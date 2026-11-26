/**
 * Calls the Rex MCP server the way Claude Code does (an MCP client over a transport) against the
 * SDK's test server, never a live Rex server.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Effect, Exit, Schema, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BlockId, SessionId, rexSdkLayerFromOptions } from "../../src/index.ts";
import {
  rexTestServerError,
  startRexTestServer,
  type IRexTestServer,
} from "../../src/testing/rex-test-server.ts";
import { rexToolOperations } from "../../pi/rex-tool-operations.ts";
import { RexToolRuntime } from "../../pi/rex-tool-runtime.ts";
import { RexMcpServer } from "../rex-mcp-server.ts";

const uuid = "01234567-89ab-cdef-0123-456789abcdef";
const sessionId = SessionId.make(`session:${uuid}`);
const blockId = BlockId.make(`block:${uuid}`);
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const TextContent = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const ToolResult = Schema.Struct({
  content: Schema.Tuple([TextContent]),
  isError: Schema.optionalKey(Schema.Boolean),
  structuredContent: Schema.optionalKey(Schema.Unknown),
});
const decodeToolResult = Schema.decodeUnknownSync(ToolResult);

describe("rex MCP server", () => {
  let scope: Scope.Closeable;
  let server: IRexTestServer;
  let runtime: RexToolRuntime;
  let client: Client;

  beforeAll(async () => {
    scope = await Effect.runPromise(Scope.make());
    server = await Effect.runPromise(startRexTestServer().pipe(Scope.provide(scope)));
    server.handle("session.list", () =>
      Effect.succeed({ sessions: [{ session_id: sessionId, label: "hq" }] }),
    );
    server.handle("session.attach", () =>
      Effect.succeed(rexTestServerError("session_not_found", "no such session")),
    );
    runtime = new RexToolRuntime(() =>
      rexSdkLayerFromOptions({
        server: server.socketPath,
        client: { kind: "agent", name: "rex-mcp-test", version: "0.0.0" },
        requestTimeout: "2 seconds",
      }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await new RexMcpServer(runtime, rexToolOperations).connect(serverTransport, {
      sessionId,
      blockId,
    });
    client = new Client({ name: "rex-mcp-test", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await runtime.dispose();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  test("its instructions speak of Claude Code's tool names and session, never of pi", () => {
    const instructions = client.getInstructions() ?? "";
    // The prefix Claude Code adds depends on how the server is installed, so none is written out.
    expect(instructions).toContain("never write a name by hand");
    expect(instructions).toContain('ends in "rex__terminals_writeLine"');
    // Claude Code already puts the server's name before each tool, so no name repeats it.
    expect(instructions).not.toMatch(/\brex_(?!_)/);
    expect(instructions).not.toContain("mcp__plugin_rex_rex__");
    expect(instructions).not.toContain("mcp__rex__");
    expect(instructions).toContain('searchTools("rex <words>")');
    expect(instructions).toContain("this Claude Code session runs in");
    expect(instructions).toContain("(Returns: a TypeScript type)");
    expect(instructions).not.toMatch(/\bpi\b/);
  });

  test("lists search and every operation, each with an object input schema and no output schema", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "search",
      ...rexToolOperations.map((operation) => operation.name),
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema).toBeUndefined();
    }
  });

  test("each operation's description ends with its result type, since describeTool shows no outputSchema", async () => {
    const { tools } = await client.listTools();
    const readDescription = (name: string) =>
      tools.find((tool) => tool.name === name)?.description ?? "";
    const readResultType = (name: string) => readDescription(name).split("\n\nReturns: ")[1] ?? "";
    for (const tool of tools.slice(1)) expect(tool.description).toMatch(/\n\nReturns: \S/);
    expect(readDescription("terminals_writeLine")).toMatch(/\n\nReturns: \{ markId: string \}$/);
    expect(readDescription("sessions_list")).toMatch(
      /\n\nReturns: \{ sessions: \{ sessionId: string; label: string \}\[\] \}$/,
    );
    expect(readDescription("terminals_pasteFiles")).toMatch(/\n\nReturns: null$/);
    expect(readDescription("search")).toContain("this Claude Code session runs in");
    expect(readDescription("search")).not.toMatch(/\bpi\b/);
    // A recursive $defs entry is named once after the type; only real unions are grouped.
    expect(readResultType("sessions_view")).toMatch(/, where type \w+ = \{ splitId: string;/);
    expect(readResultType("sessions_view")).not.toContain("({");
    expect(readResultType("terminals_waitForOutput")).toContain("groups: (string | null)[]");
    // A union of two branded strings is one string.
    expect(readResultType("blocks_splitBeside")).toContain("anchorId: string;");
  });

  test("no description and no search hit names a tool with pi's rex_ prefix", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) expect(tool.description).not.toMatch(/\brex_/);
    const found = decodeJsonText(
      decodeToolResult(
        await client.callTool({ name: "search", arguments: { query: "mark", limit: 3 } }),
      ).content[0].text,
    );
    const text = JSON.stringify(found);
    // terminals_mark's description names terminals_waitForOutput.
    expect(text).toContain('"name":"terminals_mark"');
    expect(text).toContain("in terminals_waitForOutput");
    expect(text).not.toMatch(/\brex_/);
  });

  test("search with no arguments returns the instructions and where the agent runs, as JSON text", async () => {
    const result = decodeToolResult(await client.callTool({ name: "search", arguments: {} }));
    expect(result.structuredContent).toBeUndefined();
    expect(decodeJsonText(result.content[0].text)).toMatchObject({
      instructions: client.getInstructions(),
      here: { sessionId, blockId },
    });
  });

  test("arguments that do not match the input schema are a SchemaError, and nothing is sent", async () => {
    const sent = server.requests().length;
    const unknownField = decodeToolResult(
      await client.callTool({ name: "sessions_view", arguments: { sessionId, sesionId: 1 } }),
    );
    expect(unknownField.isError).toBe(true);
    expect(unknownField.content[0].text).toBe(
      'SchemaError: arguments has unknown field "sesionId"',
    );
    const badLimit = decodeToolResult(
      await client.callTool({ name: "search", arguments: { query: "terminal", limit: 0 } }),
    );
    expect(badLimit.isError).toBe(true);
    expect(badLimit.content[0].text).toMatch(/^SchemaError: arguments\.limit /);
    expect(server.requests().length).toBe(sent);
  });

  test("an operation returns the SDK value as JSON text", async () => {
    const result = decodeToolResult(
      await client.callTool({ name: "sessions_list", arguments: {} }),
    );
    expect(result.isError).toBeUndefined();
    expect(decodeJsonText(result.content[0].text)).toMatchObject({
      sessions: [{ sessionId, label: "hq" }],
    });
  });

  test("a failed operation is an MCP error whose text starts with the SDK error tag", async () => {
    const result = decodeToolResult(
      await client.callTool({ name: "sessions_view", arguments: { sessionId } }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^RexSessionNotFound: /);
  });

  test("an error message names this server's tools and keeps the rest of its text as sent", async () => {
    const result = decodeToolResult(
      await client.callTool({
        name: "terminals_waitForOutput",
        arguments: {
          sessionId,
          blockId,
          since: "rex_custom",
          match: { type: "substring", value: "never printed" },
          timeoutMs: 50,
        },
      }),
    );
    expect(result.isError).toBe(true);
    // The markId the script sent keeps its rex_; only pi's tool names lose it.
    expect(result.content[0].text).toMatch(/^RexUnknownMark: mark rex_custom is unknown/);
    expect(result.content[0].text).toContain(
      "make a new one with terminals_mark or terminals_writeLine",
    );
  });

  test("an unknown tool is an MCP error that points to search", async () => {
    const result = decodeToolResult(await client.callTool({ name: "nothing", arguments: {} }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Unknown tool nothing; find tools with search.");
  });

  test("the test server saw no request that breaks its schema", () => {
    expect(server.violations()).toEqual([]);
  });
});
