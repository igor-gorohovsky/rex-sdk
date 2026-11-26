/**
 * Calls every Rex tool the way an MCP client does (`tools/call` with flat arguments, a JSON text
 * result or an error result) against the SDK's test server, never a live Rex server.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  BlockId,
  RexSdk,
  SessionId,
  rexBlockMethods,
  rexSdkLayerFromOptions,
  rexWireMethods,
} from "../../src/index.ts";
import { rexBlockMethodExamples } from "../../src/testing/rex-block-method-examples.ts";
import { startRexTestTerminal } from "../../src/testing/rex-test-terminal.ts";
import {
  rexTestServerError,
  startRexTestServer,
  type IRexTestServer,
  type RexTestServerBytesPeer,
} from "../../src/testing/rex-test-server.ts";
import { loadRexMcpSkills, RexMcpServer } from "../rex-mcp-server.ts";
import { RexToolRuntime } from "../rex-tool-runtime.ts";
import { deriveRexToolOutputJsonSchema, encodeRexToolResult } from "../rex-tool-schemas.ts";
import { rexToolExclusions, rexTools } from "../rex-tools.ts";

const uuid = "01234567-89ab-cdef-0123-456789abcdef";
const sessionId = SessionId.make(`session:${uuid}`);
const blockId = BlockId.make(`block:${uuid}`);
const here = { sessionId, blockId };
/** A terminal whose program already exited, and a shell for the mark flow. */
const exitedBlockId = BlockId.make("block:01234567-89ab-cdef-0123-000000000002");
const shellBlockId = BlockId.make("block:01234567-89ab-cdef-0123-000000000003");

// ---------------------------------------------------------------------------------------------
// JSON helpers that keep tests free of type assertions.

const Json = Schema.Json;
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Json));

function fieldOf(value: unknown, ...path: ReadonlyArray<string | number>): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = Object.getOwnPropertyDescriptor(current, key)?.value;
  }
  return current;
}

function objectOf(value: unknown): { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
}

// ---------------------------------------------------------------------------------------------
// Fixtures: documented examples for server methods, shared examples for block methods.

const ApiExamples = Schema.Struct({
  methods: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      request_example: Schema.optionalKey(Schema.String),
      response_example: Schema.optionalKey(Schema.String),
    }),
  ),
});
const apiExamples = Schema.decodeUnknownSync(Schema.fromJsonString(ApiExamples))(
  readFileSync(join(import.meta.dirname, "../../schema/rex-api.json"), "utf8"),
);
const concrete = (example: string | undefined) =>
  example === undefined ? {} : decodeJsonText(example.replaceAll("<uuid>", uuid));
const exampleFor = new Map(apiExamples.methods.map((method) => [method.name, method]));

const isWireMethod = (name: string): name is keyof typeof rexWireMethods => name in rexWireMethods;
const isBlockMethod = (name: string): name is keyof typeof rexBlockMethods =>
  name in rexBlockMethods;

/** Tool arguments for a tool that calls one documented method, from the method's example. */
function argumentsFromExample(method: string): { readonly [key: string]: unknown } {
  if (isWireMethod(method)) {
    const decode = Schema.decodeUnknownSync(rexWireMethods[method].input);
    return objectOf(encodeRexToolResult(decode(concrete(exampleFor.get(method)?.request_example))));
  }
  if (isBlockMethod(method)) {
    const decode = Schema.decodeUnknownSync(rexBlockMethods[method].args);
    const args = fieldOf(rexBlockMethodExamples, method, "args") ?? {};
    return { ...here, ...objectOf(encodeRexToolResult(decode(args))) };
  }
  throw new Error(`no example for ${method}`);
}

const terminal = { _tag: "Terminal", label: "Code", options: { cwd: "/tmp", command: ["ls"] } };
const layout = { _tag: "Split", direction: "horizontal", before: terminal, after: terminal };

/** Arguments for tools that do more than pass one documented example through. */
const customArguments: { readonly [tool: string]: { readonly [key: string]: unknown } } = {
  here: {},
  blocks_splitBeside: { sessionId, anchorId: blockId, placement: "right", layout: terminal },
  terminals_writeLine: { ...here, text: "ls" },
  terminals_waitForOutput: {
    ...here,
    match: { type: "regex", value: "\\bls$" },
    timeoutMs: 2_000,
  },
  terminals_waitForExit: { sessionId, blockId: exitedBlockId, timeoutMs: 2_000 },
  terminals_waitForQuiet: { ...here, quietForMs: 50, timeoutMs: 2_000 },
  terminals_mark: here,
  terminals_readTail: { ...here, maxBytes: 4_096 },
  terminals_read: { ...here, trim: true, unwrap: true },
  terminals_readFile: { ...here, path: "report.csv" },
  terminals_pasteFiles: { ...here, files: [{ name: "notes.txt", text: "hello" }] },
  sessions_create: { label: "fixture", initialWindows: [{ windowLabel: "Code", layout }] },
  windows_create: { sessionId, windowLabel: "Code", layout },
  blocks_split: { sessionId, anchorId: blockId, direction: "vertical", side: "after", layout },
  layers_create: { sessionId, bounds: [0.1, 0.1, 0.5, 0.5], layout: terminal },
  tunnels_createDial: { sessionId, options: { host: "127.0.0.1", port: 5432 } },
  tunnels_createListen: { sessionId, label: "web", options: { port: 0 } },
  events_waitFor: { type: "session_destroyed", sessionId, timeoutMs: 2_000 },
};

function argumentsFor(toolName: string): { readonly [key: string]: unknown } {
  const custom = customArguments[toolName];
  if (custom !== undefined) return custom;
  const tool = rexTools.find((candidate) => candidate.name === toolName);
  if (tool?.method === undefined) throw new Error(`no arguments for ${toolName}`);
  return argumentsFromExample(tool.method);
}

/** Server and block methods no tool reaches. */
const unreachedMethods = new Set([
  "session.detach",
  "session.attach_all",
  "session.bootstrap",
  "com.superlogical.onboarding.set_step",
  "com.superlogical.onboarding.state",
]);

const file = {
  path: "/srv/app/report.csv",
  name: "report.csv",
  size: 11,
  modified_at: "2026-11-23T06:36:08Z",
  version: "v1",
};
const refOf = (payload: unknown) => {
  const ref = fieldOf(payload, "args", "ref");
  return typeof ref === "string" ? ref : "";
};
const sendsFile: RexTestServerBytesPeer = (connection) => {
  connection.send(new TextEncoder().encode("hello world"));
  connection.send(new Uint8Array(0));
  connection.close(1000);
};
const acceptsUpload: RexTestServerBytesPeer = (connection) =>
  connection.onMessage((chunk) => {
    if (chunk.length === 0) connection.close(1000);
  });

/** Answers every method with a result valid for its output schema. */
function handleEverything(server: IRexTestServer) {
  for (const method of Object.keys(rexWireMethods)) {
    // The test server issues live tickets for data.connect; the documented one is not live.
    if (method === "data.connect") continue;
    const example = exampleFor.get(method)?.response_example;
    server.handle(method, () => Effect.succeed(concrete(example)));
  }
  server.handle("block.method", () => Effect.succeed({ generation: 1 }));
  server.handle("session.attach", () =>
    Effect.succeed({
      client_id: `client:${uuid}`,
      view: { revision: 1, session_id: sessionId, windows: [] },
    }),
  );
  for (const [method, example] of Object.entries(rexBlockMethodExamples)) {
    server.handle(method, () => Effect.succeed(example.result));
  }
  // Terminal methods go to scripted terminals, which keep text, stream, and exit consistent.
  startRexTestTerminal(server, here, { content: "$ ls" });
  startRexTestTerminal(
    server,
    { sessionId, blockId: exitedBlockId },
    { content: "done", exitedWith: 0 },
  );
  server.handle("com.superlogical.terminal.download_begin", (payload) =>
    Effect.sync(() => ({
      ...file,
      ticket: server.issueBytesTicket(refOf(payload), sendsFile),
      expires_in_ms: 60_000,
    })),
  );
  server.handle("com.superlogical.terminal.upload_begin", (payload) =>
    Effect.sync(() => ({
      ticket: server.issueBytesTicket(refOf(payload), acceptsUpload),
      expires_in_ms: 60_000,
    })),
  );
}

// ---------------------------------------------------------------------------------------------
// Calls, as an MCP client makes them.

function makeRuntime(socketPath: string): RexToolRuntime {
  return new RexToolRuntime(() =>
    rexSdkLayerFromOptions({
      server: socketPath,
      client: { kind: "agent", name: "rex-mcp-test", version: "0.0.0" },
      requestTimeout: "2 seconds",
    }),
  );
}

/** A failed call: the error tag and the whole text. */
class ToolError extends Error {
  readonly tag: string;

  constructor(text: string) {
    super(text);
    this.tag = text.split(":")[0] ?? "";
  }
}

const TextResult = Schema.Struct({
  content: Schema.Tuple([Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })]),
  isError: Schema.optionalKey(Schema.Boolean),
});
const decodeTextResult = Schema.decodeUnknownSync(TextResult);

/** The parsed JSON of a result, or a ToolError for an error result. */
function readResult(result: CallToolResult): unknown {
  const { content, isError } = decodeTextResult(result);
  if (isError === true) throw new ToolError(content[0].text);
  return decodeJsonText(content[0].text);
}

async function awaitToolError(promise: Promise<unknown>): Promise<ToolError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

// ---------------------------------------------------------------------------------------------

describe("rex tools", () => {
  let scope: Scope.Closeable;
  let server: IRexTestServer;
  let runtime: RexToolRuntime;
  let mcp: RexMcpServer;

  /** Calls a tool as a client in `here`, resolving to its parsed result. */
  const callTool = async (
    name: string,
    args: { readonly [key: string]: unknown },
    signal?: AbortSignal,
  ) => readResult(await mcp.callTool(name, args, blockId, signal));

  beforeAll(async () => {
    scope = await Effect.runPromise(Scope.make());
    server = await Effect.runPromise(startRexTestServer().pipe(Scope.provide(scope)));
    handleEverything(server);
    runtime = makeRuntime(server.socketPath);
    mcp = new RexMcpServer(runtime, rexTools, await loadRexMcpSkills());
  });

  afterAll(async () => {
    await runtime.dispose();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  test("every SDK operation has a tool or a stated exclusion", async () => {
    const rex = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* RexSdk;
      }).pipe(
        Effect.provide(
          rexSdkLayerFromOptions({
            server: server.socketPath,
            client: { kind: "agent", name: "rex-mcp-test", version: "0.0.0" },
          }),
        ),
      ),
    );
    const sdkPaths: string[] = [];
    const collect = (value: unknown, path: string) => {
      if (typeof value === "function") sdkPaths.push(path);
      else if (typeof value === "object" && value !== null)
        for (const [key, child] of Object.entries(value)) collect(child, `${path}.${key}`);
    };
    for (const [namespace, service] of Object.entries(objectOf(rex))) {
      if (namespace === "config" || namespace === "ids") continue;
      collect(service, namespace);
    }
    const toolPaths = new Set(
      rexTools.filter((tool) => tool.name !== "here").map((tool) => tool.name.replaceAll("_", ".")),
    );
    const excluded = new Set(Object.keys(rexToolExclusions));
    expect(sdkPaths.filter((path) => !toolPaths.has(path) && !excluded.has(path))).toEqual([]);
    expect([...excluded].filter((path) => !sdkPaths.includes(path) || toolPaths.has(path))).toEqual(
      [],
    );
    expect([...toolPaths].filter((path) => !sdkPaths.includes(path))).toEqual([]);
  });

  test("every tool crosses the socket and resolves to JSON text matching its result type", async () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const firstRequest = server.requests().length;
    for (const tool of rexTools) {
      if (tool.name === "events_waitFor") {
        setTimeout(
          () => server.emit({ type: "session_destroyed", payload: { session_id: sessionId } }),
          200,
        );
      }
      const result = await callTool(tool.name, argumentsFor(tool.name));
      const validate = ajv.compile(deriveRexToolOutputJsonSchema(tool.output));
      expect(validate(result), `${tool.name}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
    const observed = new Set(
      server
        .requests()
        .slice(firstRequest)
        .map((request) => request.method),
    );
    const expected = [...Object.keys(rexWireMethods), ...Object.keys(rexBlockMethods)].filter(
      (method) => !unreachedMethods.has(method),
    );
    expect(expected.filter((method) => !observed.has(method))).toEqual([]);
    expect(server.violations()).toEqual([]);
  });

  test("here returns the caller's block and the session Rex finds it in", async () => {
    const firstRequest = server.requests().length;
    // The documented target.resolve example resolves its first query in sessionId.
    expect(await callTool("here", {})).toEqual(here);
    expect(server.requests().slice(firstRequest)).toMatchObject([
      { method: "target.resolve", payload: { kinds: ["block"], queries: [blockId] } },
    ]);
    const outside = readResult(await mcp.callTool("here", {}, null, undefined));
    expect(outside).toEqual({ sessionId: null, blockId: null });
    expect(server.requests().length).toBe(firstRequest + 1);
  });

  test("flat parameters reach the wire as the SDK's positional arguments and input", async () => {
    const firstRequest = server.requests().length;
    await callTool("terminals_read", { ...here, trim: true });
    await callTool("blocks_splitBeside", {
      sessionId,
      anchorId: blockId,
      placement: "left",
      ratio: 0.3,
    });
    await callTool("windows_create", { sessionId, layout: terminal });
    const sent = (method: string) =>
      server
        .requests()
        .slice(firstRequest)
        .find((request) => request.method === method)?.payload;
    expect(sent("com.superlogical.terminal.format")).toEqual({
      session_id: sessionId,
      block_id: blockId,
      args: { trim: true, max_bytes: 524_288 },
    });
    expect(sent("session.new_split")).toMatchObject({
      session_id: sessionId,
      anchor_id: blockId,
      direction: "horizontal",
      side: "before",
      ratio: 0.3,
      layout: { block: { flavor: "com.superlogical.terminal.shell" } },
    });
    expect(sent("session.new_window")).toEqual({
      session_id: sessionId,
      layout: {
        block: {
          flavor: "com.superlogical.terminal.shell",
          label: "Code",
          options: { cwd: "/tmp", command: ["ls"] },
        },
      },
    });
  });

  test("fails with SchemaError before any request when parameters do not match the schema", async () => {
    const firstRequest = server.requests().length;
    const missingText = await awaitToolError(callTool("terminals_writeLine", here));
    expect(missingText.tag).toBe("SchemaError");
    const extra = await awaitToolError(callTool("sessions_view", { sessionId, extra: 1 }));
    expect(extra.message).toBe('SchemaError: unknown field "extra"');
    for (const name of ["terminals_waitForOutput", "terminals_waitForExit", "events_waitFor"]) {
      const { timeoutMs: _timeoutMs, ...withoutTimeout } = argumentsFor(name);
      const error = await awaitToolError(callTool(name, withoutTimeout));
      expect(error.tag).toBe("SchemaError");
      expect(error.message).toMatch(/timeoutMs/);
    }
    const malformed = await awaitToolError(
      callTool("sessions_view", { sessionId: "not-a-session" }),
    );
    expect(malformed.tag).toBe("SchemaError");
    // The deadline every tool takes is checked too, though no tool's own schema decodes it.
    for (const requestTimeoutMs of ["100", 0, -1, null]) {
      const deadline = await awaitToolError(callTool("hosts_list", { requestTimeoutMs }));
      expect(deadline.tag).toBe("SchemaError");
      expect(deadline.message).toContain("requestTimeoutMs");
    }
    const unknownTool = await awaitToolError(callTool("search", {}));
    expect(unknownTool.message).toBe("RexUnknownTool: no Rex tool is named search");
    expect(server.requests().length).toBe(firstRequest);
  });

  test("a wait that passes its timeoutMs resolves to { timedOut: true }", async () => {
    const output = await callTool("terminals_waitForOutput", {
      ...here,
      match: { type: "substring", value: "never printed" },
      timeoutMs: 300,
    });
    expect(output).toEqual({ timedOut: true });
    const exit = await callTool("terminals_waitForExit", { ...here, timeoutMs: 300 });
    expect(exit).toEqual({ timedOut: true });
    const event = await callTool("events_waitFor", { type: "never_sent", timeoutMs: 300 });
    expect(event).toEqual({ timedOut: true });
  });

  test("waits resolve to { timedOut: false, value } with the SDK's result", async () => {
    // Output already on screen matches without a mark, even after the program exited.
    const output = await callTool("terminals_waitForOutput", {
      sessionId,
      blockId: exitedBlockId,
      match: { type: "regex", value: "^(\\w+)$" },
      timeoutMs: 1_000,
    });
    expect(output).toEqual({
      timedOut: false,
      match: { line: "done", text: "done", groups: ["done"], alignment: null },
    });
    const exit = await callTool("terminals_waitForExit", {
      sessionId,
      blockId: exitedBlockId,
      timeoutMs: 1_000,
    });
    expect(exit).toEqual({ timedOut: false, exit: { exitCode: 0, error: null } });
  });

  test("writeLine returns a mark; waitForOutput since it matches only what the command printed", async () => {
    const shell = { sessionId, blockId: shellBlockId };
    const terminal = startRexTestTerminal(server, shell, { content: "$ pnpm test\npassed\n$ " });
    const written = await callTool("terminals_writeLine", { ...shell, text: "pnpm test" });
    const markId = fieldOf(written, "markId");
    expect(markId).toMatch(/^mark-[0-9a-f-]{36}$/);
    // Marks belong to the process, not to a client: another client may wait on it.
    const wait = mcp.callTool(
      "terminals_waitForOutput",
      {
        ...shell,
        since: markId,
        match: { type: "regex", value: "passed|failed" },
        timeoutMs: 2_000,
      },
      null,
      undefined,
    );
    // The earlier "passed" line and the typed command don't count; this does.
    setTimeout(() => terminal.print("1 failed\n$ "), 300);
    expect(readResult(await wait)).toEqual({
      timedOut: false,
      match: { line: "1 failed", text: "failed", groups: [], alignment: "offset" },
    });
    const otherBlock = await awaitToolError(
      callTool("terminals_waitForOutput", {
        ...here,
        since: markId,
        match: { type: "substring", value: "x" },
        timeoutMs: 100,
      }),
    );
    expect(otherBlock.tag).toBe("RexUnknownMark");
    expect(otherBlock.message).toContain("terminals_mark or terminals_writeLine");
  });

  test("waitForOutput fails with RexTerminalExited when the program exits without a match", async () => {
    const error = await awaitToolError(
      callTool("terminals_waitForOutput", {
        sessionId,
        blockId: exitedBlockId,
        match: { type: "substring", value: "never printed" },
        timeoutMs: 1_000,
      }),
    );
    expect(error.tag).toBe("RexTerminalExited");
  });

  test("a server rejection fails with the SDK error tag first", async () => {
    server.handle("session.list_blocks", () =>
      Effect.succeed(rexTestServerError("session_not_found", "no such session")),
    );
    try {
      const error = await awaitToolError(callTool("sessions_listBlocks", { sessionId }));
      expect(error.tag).toBe("RexSessionNotFound");
      expect(error.message).toMatch(/^RexSessionNotFound: /);
    } finally {
      server.handle("session.list_blocks", () =>
        Effect.succeed(concrete(exampleFor.get("session.list_blocks")?.response_example)),
      );
    }
  });

  test("requestTimeoutMs bounds a stalled request with RexRequestTimeout", async () => {
    server.handle("hosts.list", () => Effect.never);
    try {
      const started = Date.now();
      const error = await awaitToolError(callTool("hosts_list", { requestTimeoutMs: 100 }));
      expect(error.tag).toBe("RexRequestTimeout");
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      server.handle("hosts.list", () =>
        Effect.succeed(concrete(exampleFor.get("hosts.list")?.response_example)),
      );
    }
  });

  test("aborting the tool call interrupts it", async () => {
    const controller = new AbortController();
    const call = callTool(
      "terminals_waitForOutput",
      { ...here, match: { type: "substring", value: "never printed" }, timeoutMs: 60_000 },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    expect((await awaitToolError(call)).tag).toBe("Interrupted");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

test("a missing server fails with the SDK's connection error", async () => {
  const runtime = new RexToolRuntime(() =>
    Layer.fresh(
      rexSdkLayerFromOptions({
        server: "/tmp/rex-mcp-missing/server.sock",
        connectTimeout: "1 second",
      }),
    ),
  );
  try {
    const mcp = new RexMcpServer(runtime, rexTools, await loadRexMcpSkills());
    const result = await mcp.callTool("server_status", {}, blockId, undefined);
    const error = await awaitToolError(Promise.resolve().then(() => readResult(result)));
    expect(error.tag).toMatch(/^RexConnection/);
  } finally {
    await runtime.dispose();
  }
});
