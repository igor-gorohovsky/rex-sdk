/**
 * Serves the Rex tools over streamable HTTP to several MCP clients at once, the way Claude Code
 * sessions connect to the shared service, against the SDK's test server.
 */
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect, Exit, Option, Schema, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BlockId, SessionId, rexSdkLayerFromOptions } from "../../src/index.ts";
import { startRexTestServer, type IRexTestServer } from "../../src/testing/rex-test-server.ts";
import { startRexTestTerminal } from "../../src/testing/rex-test-terminal.ts";
import { rexToolOperations } from "../../pi/rex-tool-operations.ts";
import { RexToolRuntime } from "../../pi/rex-tool-runtime.ts";
import { findTcpPeerUid, startRexMcpHttpServer, type RexMcpHttpServer } from "../rex-mcp-http.ts";
import { RexMcpServer } from "../rex-mcp-server.ts";

const sessionId = SessionId.make("session:01234567-89ab-cdef-0123-456789abcdef");
const otherSessionId = SessionId.make("session:01234567-89ab-cdef-0123-000000000009");
const blockId = BlockId.make("block:01234567-89ab-cdef-0123-000000000001");
const lookedUpBlockId = BlockId.make("block:01234567-89ab-cdef-0123-000000000002");
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const ToolResult = Schema.Struct({
  content: Schema.Tuple([Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })]),
  isError: Schema.optionalKey(Schema.Boolean),
});
const decodeToolResult = Schema.decodeUnknownSync(ToolResult);
const Here = Schema.Struct({
  here: Schema.Struct({
    sessionId: Schema.NullOr(Schema.String),
    blockId: Schema.NullOr(Schema.String),
  }),
});
const decodeHere = Schema.decodeUnknownSync(Here);

/** A session view whose one window holds `blockIds`. */
const makeSessionView = (id: string, blockIds: readonly string[]) => ({
  revision: 1,
  session_id: id,
  windows: [
    {
      window_id: "window:01234567-89ab-cdef-0123-000000000001",
      layers: [
        {
          layer_id: "layer:01234567-89ab-cdef-0123-000000000001",
          kind: "tiled",
          bounds: [0, 0, 1, 1],
          layout: null,
          blocks: blockIds.map((id) => ({ block_id: id })),
        },
      ],
    },
  ],
});

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

describe("rex MCP over HTTP", () => {
  let scope: Scope.Closeable;
  let server: IRexTestServer;
  let runtime: RexToolRuntime;
  let service: RexMcpHttpServer;
  const clients: Client[] = [];

  async function connectClient(
    headers: Record<string, string>,
    transport = new StreamableHTTPClientTransport(new URL(service.url), {
      requestInit: { headers },
    }),
  ): Promise<Client> {
    const client = new Client({ name: "rex-mcp-http-test", version: "0.0.0" });
    await client.connect(transport);
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
    server.handle("session.view", (payload) => {
      const id = Schema.decodeUnknownSync(Schema.Struct({ session_id: Schema.String }))(
        payload,
      ).session_id;
      return Effect.succeed(
        makeSessionView(id, id === sessionId ? [blockId, lookedUpBlockId] : []),
      );
    });
    startRexTestTerminal(server, { sessionId, blockId });
    runtime = new RexToolRuntime(() =>
      rexSdkLayerFromOptions({
        server: server.socketPath,
        client: { kind: "agent", name: "rex-mcp-http-test", version: "0.0.0" },
        requestTimeout: "2 seconds",
      }),
    );
    service = await startRexMcpHttpServer({
      mcp: new RexMcpServer(runtime, rexToolOperations),
      port: 0,
      log: () => {},
    });
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await service.close();
    await runtime.dispose();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  test("each client gets its own here from its headers, and a block alone finds its session", async () => {
    const full = await connectClient({ "X-Rex-Session": sessionId, "X-Rex-Block": blockId });
    const blockOnly = await connectClient({ "X-Rex-Block": lookedUpBlockId });
    // Claude Code expands an unset ${REX_BLOCK:-} to an empty header.
    const outside = await connectClient({ "X-Rex-Block": "" });
    const readHere = async (client: Client) =>
      decodeHere(decodeJsonText((await callTool(client, "rex_search", {})).content[0].text)).here;
    expect(await readHere(full)).toEqual({ sessionId, blockId });
    expect(await readHere(blockOnly)).toEqual({ sessionId, blockId: lookedUpBlockId });
    expect(await readHere(outside)).toEqual({ sessionId: null, blockId: null });
    expect(service.countSessions()).toBeGreaterThanOrEqual(3);
  });

  test("a search for tools does not ask Rex where a client runs", async () => {
    const blockOnly = await connectClient({ "X-Rex-Block": lookedUpBlockId });
    const sent = server.requests().length;
    const found = await callTool(blockOnly, "rex_search", { query: "terminal" });
    expect(found.isError).toBeUndefined();
    expect(server.requests().length).toBe(sent);
  });

  test("a mark belongs to the client that made it", async () => {
    const maker = await connectClient({});
    const other = await connectClient({});
    const marked = await callTool(maker, "rex_terminals_mark", { sessionId, blockId });
    const { markId } = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ markId: Schema.String })),
    )(marked.content[0].text);
    const wait = {
      sessionId,
      blockId,
      since: markId,
      match: { type: "substring", value: "never printed" },
      timeoutMs: 50,
    };
    const own = await callTool(maker, "rex_terminals_waitForOutput", wait);
    expect(own.isError).toBeUndefined();
    expect(decodeJsonText(own.content[0].text)).toMatchObject({ timedOut: true });
    const foreign = await callTool(other, "rex_terminals_waitForOutput", wait);
    expect(foreign.isError).toBe(true);
    expect(foreign.content[0].text).toMatch(/^RexUnknownMark: mark \S+ is unknown/);
  });

  test("closing one client ends its session and leaves the others served", async () => {
    const leaving = new StreamableHTTPClientTransport(new URL(service.url));
    await connectClient({}, leaving);
    const staying = await connectClient({});
    const before = service.countSessions();
    await leaving.terminateSession();
    expect(service.countSessions()).toBe(before - 1);
    const listed = await callTool(staying, "rex_sessions_list", {});
    expect(listed.isError).toBeUndefined();
  });

  test("a session the service does not know is a 404, so the client starts a new one", async () => {
    const reply = await sendRaw(
      service.url,
      {
        host: new URL(service.url).host,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "gone-after-a-restart",
      },
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
    expect(reply.status).toBe(404);
    expect(reply.body).toContain("Session not found");
  });

  test("a client gone without a DELETE is ended once idle, but not while a call is open", async () => {
    const quick = await startRexMcpHttpServer({
      mcp: new RexMcpServer(runtime, rexToolOperations),
      port: 0,
      log: () => {},
      idleTimeoutMs: 100,
    });
    try {
      const client = new Client({ name: "rex-mcp-http-test", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(quick.url)));
      clients.push(client);
      expect(quick.countSessions()).toBe(1);
      const waited = decodeToolResult(
        await client.callTool({
          name: "rex_terminals_waitForOutput",
          arguments: {
            sessionId,
            blockId,
            match: { type: "substring", value: "never printed" },
            timeoutMs: 400,
          },
        }),
      );
      expect(decodeJsonText(waited.content[0].text)).toMatchObject({ timedOut: true });
      expect(quick.countSessions()).toBe(1);
      // Claude Code exits without a DELETE; closing the client only drops its connections.
      await client.close();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(quick.countSessions()).toBe(0);
    } finally {
      await quick.close();
    }
  });

  test("a request naming another host is refused, against DNS rebinding", async () => {
    const reply = await sendRaw(
      service.url,
      { host: "rebound.example:80", "content-type": "application/json" },
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    );
    expect(reply.status).toBe(403);
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

  test("finds nothing for a connection the table does not hold", () => {
    expect(Option.isNone(findTcpPeerUid(table, 41_001, 7317))).toBe(true);
  });
});
