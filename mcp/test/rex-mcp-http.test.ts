/**
 * Serves the Rex tools over streamable HTTP to MCP clients of both protocol eras at once, as the
 * shared service serves Claude Code (2026-07-28) and pi (2025-11-25), against the SDK's test server.
 */
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Effect, Exit, Option, Schema, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BlockId, SessionId, rexSdkLayerFromOptions } from "../../src/index.ts";
import { startRexTestServer, type IRexTestServer } from "../../src/testing/rex-test-server.ts";
import { startRexTestTerminal } from "../../src/testing/rex-test-terminal.ts";
import { findTcpPeerUid, startRexMcpHttpServer, type RexMcpHttpServer } from "../rex-mcp-http.ts";
import { RexMcpServer } from "../rex-mcp-server.ts";
import { RexToolRuntime } from "../rex-tool-runtime.ts";
import { rexTools } from "../rex-tools.ts";

const sessionId = SessionId.make("session:01234567-89ab-cdef-0123-456789abcdef");
const otherSessionId = SessionId.make("session:01234567-89ab-cdef-0123-000000000009");
const blockId = BlockId.make("block:01234567-89ab-cdef-0123-000000000001");
/** A block ID Rex does not know, such as a closed pane's. */
const closedBlockId = BlockId.make("block:01234567-89ab-cdef-0123-000000000002");
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const ToolResult = Schema.Struct({
  content: Schema.Tuple([Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })]),
  isError: Schema.optionalKey(Schema.Boolean),
  structuredContent: Schema.optionalKey(Schema.Unknown),
});
const decodeToolResult = Schema.decodeUnknownSync(ToolResult);
const instructions = readFileSync(new URL("../instructions.md", import.meta.url), "utf8");

/** Sends one raw HTTP request, so a test can set headers fetch refuses, such as Host. */
function sendRaw(url: string, headers: Record<string, string>, body: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const target = new URL(url);
    const outgoing = request(
      { host: target.hostname, port: target.port, path: target.pathname, method: "POST", headers },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

/** The two protocol eras the service serves: pi speaks 2025-11-25, Claude Code 2026-07-28. */
const eras = [
  { era: "2025 (pi)", versionNegotiation: { mode: "legacy" as const } },
  { era: "2026-07-28 (Claude Code)", versionNegotiation: { mode: "auto" as const } },
];

describe("rex MCP over HTTP", () => {
  let scope: Scope.Closeable;
  let server: IRexTestServer;
  let runtime: RexToolRuntime;
  let service: RexMcpHttpServer;
  const clients: Client[] = [];

  async function connectClient(
    headers: Record<string, string>,
    versionNegotiation: { readonly mode: "legacy" | "auto" },
  ): Promise<Client> {
    const client = new Client(
      { name: "rex-mcp-http-test", version: "0.0.0" },
      { versionNegotiation },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers } }),
    );
    clients.push(client);
    return client;
  }

  async function callTool(client: Client, name: string, args: Record<string, unknown>) {
    return decodeToolResult(await client.callTool({ name, arguments: args }));
  }

  beforeAll(async () => {
    scope = await Effect.runPromise(Scope.make());
    server = await Effect.runPromise(startRexTestServer().pipe(Scope.provide(scope)));
    server.handle("session.list", () =>
      Effect.succeed({
        sessions: [
          { session_id: otherSessionId, label: "other" },
          { session_id: sessionId, label: "hq" },
        ],
      }),
    );
    // Rex knows one block: blockId, in sessionId.
    server.handle("target.resolve", (payload) => {
      const { queries } = Schema.decodeUnknownSync(
        Schema.Struct({ queries: Schema.Array(Schema.String) }),
      )(payload);
      return Effect.succeed({
        results: queries.map((query) =>
          query === blockId
            ? {
                query,
                status: "resolved",
                target: { kind: "block", session_id: sessionId, block_id: blockId, label: "" },
              }
            : { query, status: "not_found" },
        ),
      });
    });
    startRexTestTerminal(server, { sessionId, blockId }, { content: "$ " });
    runtime = new RexToolRuntime(() =>
      rexSdkLayerFromOptions({
        server: server.socketPath,
        client: { kind: "agent", name: "rex-mcp-http-test", version: "0.0.0" },
        requestTimeout: "2 seconds",
      }),
    );
    service = await startRexMcpHttpServer({
      mcp: new RexMcpServer(runtime, rexTools, { progressIntervalMs: 100 }),
      port: 0,
      log: () => undefined,
    });
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await service.close();
    await runtime.dispose();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  for (const { era, versionNegotiation } of eras) {
    describe(era, () => {
      test("the instructions are instructions.md, naming tools without a client's prefix", async () => {
        const client = await connectClient({}, versionNegotiation);
        expect(client.getInstructions()).toBe(instructions);
        expect(instructions).not.toMatch(/\brex_(?!_)/);
        expect(instructions).not.toContain("rex_search");
      });

      test("lists every tool with an object input schema, no output schema, and its result type", async () => {
        const client = await connectClient({}, versionNegotiation);
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual(rexTools.map((tool) => tool.name));
        for (const tool of tools) {
          expect(tool.inputSchema.type).toBe("object");
          expect(tool.outputSchema).toBeUndefined();
          expect(tool.description).toMatch(/\n\nReturns: \S/);
          expect(tool.description).not.toMatch(/\brex_/);
        }
        const writeLine = tools.find((tool) => tool.name === "terminals_writeLine");
        expect(writeLine?.description).toMatch(/Returns: \{ markId: string \}$/);
      });

      test("here is the block in each request's X-Rex-Block header, and the session Rex has it in", async () => {
        const inside = await connectClient({ "X-Rex-Block": blockId }, versionNegotiation);
        const closed = await connectClient({ "X-Rex-Block": closedBlockId }, versionNegotiation);
        const outside = await connectClient({ "X-Rex-Block": "" }, versionNegotiation);
        const readHere = async (client: Client) =>
          decodeJsonText((await callTool(client, "here", {})).content[0].text);
        expect(await readHere(inside)).toEqual({ sessionId, blockId });
        expect(await readHere(closed)).toEqual({ sessionId: null, blockId: closedBlockId });
        expect(await readHere(outside)).toEqual({ sessionId: null, blockId: null });
      });

      test("a result is JSON text only; a failure is an error result led by the error tag", async () => {
        const client = await connectClient({}, versionNegotiation);
        const list = await callTool(client, "sessions_list", {});
        expect(list.isError).toBeUndefined();
        expect(list.structuredContent).toBeUndefined();
        expect(decodeJsonText(list.content[0].text)).toEqual({
          sessions: [
            { sessionId: otherSessionId, label: "other" },
            { sessionId, label: "hq" },
          ],
        });
        const extra = await callTool(client, "sessions_list", { sinc: 1 });
        expect(extra).toEqual({
          isError: true,
          content: [{ type: "text", text: 'SchemaError: unknown field "sinc"' }],
        });
        const unknown = await callTool(client, "search", {});
        expect(unknown.isError).toBe(true);
        expect(unknown.content[0].text).toMatch(/^RexUnknownTool: /);
      });

      test("a call that outlasts the client's request timeout keeps it alive with progress", async () => {
        const client = await connectClient({}, versionNegotiation);
        const progress: number[] = [];
        const wait = await client.callTool(
          {
            name: "terminals_waitForOutput",
            arguments: {
              sessionId,
              blockId,
              match: { type: "substring", value: "never printed" },
              timeoutMs: 600,
            },
          },
          {
            timeout: 300,
            resetTimeoutOnProgress: true,
            onprogress: ({ progress: count }) => progress.push(count),
          },
        );
        expect(decodeJsonText(decodeToolResult(wait).content[0].text)).toEqual({ timedOut: true });
        expect(progress.length).toBeGreaterThan(0);
      });

      test("a mark made in one request serves a wait in the next", async () => {
        const client = await connectClient({}, versionNegotiation);
        const target = { sessionId, blockId };
        const mark = decodeJsonText(
          (await callTool(client, "terminals_mark", target)).content[0].text,
        );
        const wait = await callTool(client, "terminals_waitForOutput", {
          ...target,
          since: Schema.decodeUnknownSync(Schema.Struct({ markId: Schema.String }))(mark).markId,
          match: { type: "substring", value: "never printed" },
          timeoutMs: 100,
        });
        expect(decodeJsonText(wait.content[0].text)).toEqual({ timedOut: true });
      });
    });
  }

  test("a request naming another host is refused, against DNS rebinding", async () => {
    const reply = await sendRaw(
      service.url,
      { host: "rebound.example:80", "content-type": "application/json" },
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    );
    expect(reply.status).toBe(403);
  });

  test("a browser request from another origin is refused", async () => {
    const reply = await sendRaw(
      service.url,
      {
        host: new URL(service.url).host,
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    );
    expect(reply.status).toBe(403);
  });

  test("another path is a 404", async () => {
    const reply = await sendRaw(
      service.url.replace("/mcp", "/other"),
      { host: new URL(service.url).host, "content-type": "application/json" },
      "{}",
    );
    expect(reply.status).toBe(404);
  });

  test("the test server saw no request that breaks its schema", () => {
    expect(server.violations()).toEqual([]);
  });
});

describe("the peer check", () => {
  // Rows as Linux writes them: a listener, and both ends of one connection 127.0.0.1:41000 → :7317.
  const table = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:1C95 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0",
    "   1: 0100007F:A028 0100007F:1C95 01 00000000:00000000 00:00000000 00000000   997        0 2 1 0",
    "   2: 0100007F:1C95 0100007F:A028 01 00000000:00000000 00:00000000 00000000  1000        0 3 1 0",
  ].join("\n");

  test("finds the UID that owns the client end of a loopback connection", () => {
    expect(Option.getOrUndefined(findTcpPeerUid(table, 41_000, 7317))).toBe(997);
  });

  test("finds a dual-stack client's IPv4-mapped row in /proc/net/tcp6", () => {
    const tcp6 =
      "   0: 0000000000000000FFFF00000100007F:A029 0000000000000000FFFF00000100007F:1C95 01 00000000:00000000 00:00000000 00000000   996        0 4 1 0";
    expect(Option.getOrUndefined(findTcpPeerUid(`${table}\n${tcp6}`, 41_001, 7317))).toBe(996);
  });

  test("finds nothing for a connection the table does not hold", () => {
    expect(Option.isNone(findTcpPeerUid(table, 41_001, 7317))).toBe(true);
  });
});
