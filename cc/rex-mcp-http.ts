/**
 * The Rex tools over MCP streamable HTTP, for every Claude Code session on a machine from one
 * process: one SDK runtime (one Rex connection) shared by all clients, and an MCP session per
 * client with its own marks.
 *
 * It listens on loopback only and answers only requests whose Host header names that address, so
 * a web page cannot reach it through DNS rebinding. On Linux it also answers only connections
 * made by its own user, read from /proc/net/tcp: the Rex socket is private to that user, and
 * this server must not open it to every local account. A client says where it runs with the
 * `X-Rex-Block` header (and `X-Rex-Session`, when known), which Claude Code fills from the
 * client's environment: `"X-Rex-Block": "${REX_BLOCK:-}"`.
 */
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo, Socket } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Option, Schema } from "effect";
import { BlockId, SessionId } from "../src/index.ts";
import type { RexSearchHere } from "../pi/rex-tool-search.ts";
import type { RexMcpServer } from "./rex-mcp-server.ts";

/** The path the MCP endpoint answers on. */
export const REX_MCP_HTTP_PATH = "/mcp";
/** The port the service listens on unless told otherwise. */
export const REX_MCP_HTTP_DEFAULT_PORT = 7317;
/** The largest request body read; a pasted file travels inside one. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** JSON-RPC's code for a session the server does not know (as the MCP SDK's own server sends). */
const SESSION_NOT_FOUND = -32001;
/** How long a session with no request open may sit unused before it is ended. */
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/** Options for {@link startRexMcpHttpServer}. */
export interface RexMcpHttpOptions {
  readonly mcp: RexMcpServer;
  /** 0 picks a free port. */
  readonly port: number;
  /** One line per opened and closed MCP session; defaults to stderr. */
  readonly log?: (line: string) => void;
  /**
   * A session with no request open (no tool call, no event stream) and none for this long is
   * ended; defaults to an hour. Claude Code sends no DELETE when it exits, so this is how its
   * sessions end, and one still running starts a new session on its next call.
   */
  readonly idleTimeoutMs?: number;
}

/** A running service. */
export interface RexMcpHttpServer {
  /** The MCP endpoint, such as `http://127.0.0.1:7317/mcp`. */
  readonly url: string;
  /** How many MCP sessions are open. */
  readonly countSessions: () => number;
  /** Ends every MCP session and stops listening. */
  readonly close: () => Promise<void>;
}

/** An MCP session: its transport, how many of its requests are open, and when one last ended. */
interface RexMcpHttpSession {
  readonly transport: StreamableHTTPServerTransport;
  openRequests: number;
  lastUsedAt: number;
}

class RexMcpHttpError extends Error {
  readonly status: number;
  readonly code: number;

  constructor(status: number, code: number, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const isSessionId = Schema.is(SessionId);
const isBlockId = Schema.is(BlockId);

/**
 * Where a client runs, from its `X-Rex-Session` and `X-Rex-Block` headers. A header that is not
 * one ID (missing, empty for an unset variable, or sent twice) is null.
 */
export function readHereFromHeaders(headers: IncomingHttpHeaders): RexSearchHere {
  const sessionId = headers["x-rex-session"];
  const blockId = headers["x-rex-block"];
  return {
    sessionId: isSessionId(sessionId) ? sessionId : null,
    blockId: isBlockId(blockId) ? blockId : null,
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  // Refused before reading when the length is declared: stopping a read midway drops the
  // connection, and the client sees a reset instead of this answer.
  if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) {
    throw new RexMcpHttpError(413, -32600, `request body over ${MAX_BODY_BYTES} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new RexMcpHttpError(413, -32600, `request body over ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed;
  } catch {
    throw new RexMcpHttpError(400, -32700, "Parse error: the body is not JSON");
  }
}

/** A loopback IPv4 address and port as /proc/net/tcp writes them. */
function formatProcAddress(port: number): string {
  return `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * The UID owning the client end of the loopback TCP connection from `clientPort` to
 * `serverPort`, in a /proc/net/tcp table.
 */
export function findTcpPeerUid(
  table: string,
  clientPort: number,
  serverPort: number,
): Option.Option<number> {
  const local = formatProcAddress(clientPort);
  const remote = formatProcAddress(serverPort);
  for (const line of table.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[1] === local && fields[2] === remote) return Option.some(Number(fields[7]));
  }
  return Option.none();
}

function checkInitializeRequest(body: unknown): boolean {
  return Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body);
}

function sendError(response: ServerResponse, error: RexMcpHttpError): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(error.status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: error.code, message: error.message },
      id: null,
    }),
  );
}

/** Serves `mcp` on 127.0.0.1:`port` until `close`. */
export async function startRexMcpHttpServer(options: RexMcpHttpOptions): Promise<RexMcpHttpServer> {
  const { mcp } = options;
  const log = options.log ?? ((line: string) => console.error(line));
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!(idleTimeoutMs > 0 && Number.isFinite(idleTimeoutMs))) {
    throw new RangeError(`idleTimeoutMs ${idleTimeoutMs} is not a positive number of milliseconds`);
  }
  const sessions = new Map<string, RexMcpHttpSession>();
  const http = createServer();
  let allowedHosts = new Set<string>();
  let port = options.port;
  const ownUid = process.platform === "linux" ? process.getuid?.() : undefined;
  const peerChecks = new WeakMap<Socket, Promise<boolean>>();

  /** Whether the connection was made by this process's user; checked once per connection. */
  function checkPeer(socket: Socket): Promise<boolean> {
    if (ownUid === undefined) return Promise.resolve(true);
    let check = peerChecks.get(socket);
    if (check === undefined) {
      check = readFile("/proc/net/tcp", "utf8").then(
        (table) =>
          Option.getOrUndefined(findTcpPeerUid(table, socket.remotePort ?? 0, port)) === ownUid,
        () => false,
      );
      peerChecks.set(socket, check);
    }
    return check;
  }

  async function openSession(
    request: IncomingMessage,
    response: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const here = readHereFromHeaders(request.headers);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, openRequests: 0, lastUsedAt: Date.now() });
        log(
          `rex-mcp: session ${sessionId} opened for ${here.blockId ?? "a client outside Rex"} (${sessions.size} open)`,
        );
      },
    });
    const server = await mcp.connect(transport, here);
    server.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId !== undefined && sessions.delete(sessionId)) {
        log(`rex-mcp: session ${sessionId} closed (${sessions.size} open)`);
      }
    };
    await transport.handleRequest(request, response, body);
  }

  async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!allowedHosts.has(request.headers.host ?? "")) {
      throw new RexMcpHttpError(403, -32000, "Forbidden: the Host header names another server");
    }
    if (!(await checkPeer(request.socket))) {
      throw new RexMcpHttpError(403, -32000, "Forbidden: the connection comes from another user");
    }
    if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== REX_MCP_HTTP_PATH) {
      throw new RexMcpHttpError(404, -32000, `Not found: MCP answers on ${REX_MCP_HTTP_PATH}`);
    }
    const body = request.method === "POST" ? await readJsonBody(request) : undefined;
    const sessionId = request.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      const session = sessions.get(sessionId);
      // 404 tells the client to start a new session, as after a restart of this service.
      if (session === undefined) {
        throw new RexMcpHttpError(404, SESSION_NOT_FOUND, "Session not found");
      }
      session.openRequests += 1;
      response.once("close", () => {
        session.openRequests -= 1;
        session.lastUsedAt = Date.now();
      });
      await session.transport.handleRequest(request, response, body);
      return;
    }
    if (request.method === "POST" && checkInitializeRequest(body)) {
      await openSession(request, response, body);
      return;
    }
    throw new RexMcpHttpError(400, -32000, "Bad Request: no session ID, and not an initialize");
  }

  http.on("request", (request, response) => {
    answer(request, response).catch((error: unknown) => {
      sendError(
        response,
        error instanceof RexMcpHttpError
          ? error
          : new RexMcpHttpError(500, -32603, `Internal error: ${String(error)}`),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, "127.0.0.1", () => {
      // A later server error is not this listen's; left attached, it would be swallowed here.
      http.off("error", reject);
      resolve();
    });
  });
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (session.openRequests === 0 && now - session.lastUsedAt > idleTimeoutMs) {
        log(`rex-mcp: session ${sessionId} idle, ending it`);
        void session.transport.close();
      }
    }
  }, idleTimeoutMs / 4);
  sweep.unref();
  const address: AddressInfo | string | null = http.address();
  if (typeof address === "object" && address !== null) port = address.port;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  return {
    url: `http://127.0.0.1:${port}${REX_MCP_HTTP_PATH}`,
    countSessions: () => sessions.size,
    close: async () => {
      clearInterval(sweep);
      await Promise.all([...sessions.values()].map((session) => session.transport.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
