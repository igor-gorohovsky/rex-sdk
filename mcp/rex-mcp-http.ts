/**
 * The Rex tools over MCP streamable HTTP, for every agent on a machine from one process: one SDK
 * runtime (one Rex connection) shared by all clients. Serving is stateless: each request gets a
 * fresh server instance (`createMcpHandler`), for 2026-07-28 clients such as Claude Code and
 * 2025 clients such as pi alike, so there are no MCP sessions to keep or expire.
 *
 * It listens on loopback only and answers only requests whose Host header (and Origin, when a
 * browser sends one) names a loopback address, so a web page cannot reach it. On Linux it also
 * answers only connections made by its own user, read from /proc/net/tcp and /proc/net/tcp6 (a
 * dual-stack client's socket is listed there): the Rex socket is private to that user, and
 * this server must not open it to every local account. A client says where it runs with the
 * `X-Rex-Block` header on every request, which the client fills from its environment:
 * `"X-Rex-Block": "${REX_BLOCK:-}"`. A client outside Rex gets an empty server unless it sends
 * `X-Rex-Headless` (any non-empty value), as the dream's headless `claude -p` does.
 */
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Option } from "effect";
import {
  parseRexMcpCallerClaim,
  REX_MCP_MAX_MESSAGE_BYTES,
  type RexMcpServer,
} from "./rex-mcp-server.ts";

/** The path the MCP endpoint answers on. */
const REX_MCP_HTTP_PATH = "/mcp";
/** The port the service listens on unless told otherwise. */
export const REX_MCP_HTTP_DEFAULT_PORT = 7317;

/** Options for {@link startRexMcpHttpServer}. */
export interface RexMcpHttpOptions {
  readonly mcp: RexMcpServer;
  /** 0 picks a free port. */
  readonly port: number;
  /** One line per failed request; defaults to stderr. */
  readonly log?: (line: string) => void;
}

/** A running service. */
export interface RexMcpHttpServer {
  /** The MCP endpoint, such as `http://127.0.0.1:7317/mcp`. */
  readonly url: string;
  /** Ends the requests in flight and stops listening. */
  readonly close: () => Promise<void>;
}

/** 127.0.0.1 as /proc/net/tcp writes it, and as /proc/net/tcp6 writes it IPv4-mapped. */
const PROC_LOOPBACK_ADDRESSES = ["0100007F", "0000000000000000FFFF00000100007F"];

/** 127.0.0.1:`port` in each form /proc/net/tcp or /proc/net/tcp6 writes it. */
function formatProcAddresses(port: number): readonly string[] {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  return PROC_LOOPBACK_ADDRESSES.map((address) => `${address}:${hexPort}`);
}

/**
 * The UID owning the client end of the loopback TCP connection from `clientPort` to
 * `serverPort`, in /proc/net/tcp or /proc/net/tcp6 rows.
 */
export function findTcpPeerUid(
  table: string,
  clientPort: number,
  serverPort: number,
): Option.Option<number> {
  const locals = formatProcAddresses(clientPort);
  const remotes = formatProcAddresses(serverPort);
  for (const line of table.split("\n")) {
    const [, local = "", remote = "", , , , , uid] = line.trim().split(/\s+/);
    if (locals.includes(local) && remotes.includes(remote)) return Option.some(Number(uid));
  }
  return Option.none();
}

function sendError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

/** Serves `mcp` on 127.0.0.1:`port` until `close`. */
export async function startRexMcpHttpServer(options: RexMcpHttpOptions): Promise<RexMcpHttpServer> {
  const { mcp } = options;
  const log = options.log ?? ((line: string) => console.error(line));
  const onerror = (error: Error) => log(`rex-mcp: ${error.message}`);
  const handler = createMcpHandler(
    ({ requestInfo }) =>
      mcp.createServer(
        parseRexMcpCallerClaim(
          requestInfo?.headers.get("x-rex-block"),
          requestInfo?.headers.get("x-rex-headless"),
        ),
      ),
    {
      onerror,
      maxRequestBodySize: REX_MCP_MAX_MESSAGE_BYTES,
      // Every answer streams, so its headers go out at once and keep-alive frames flow while a
      // wait runs: a client with a headers or idle timeout (undici's is 300 s) would otherwise
      // drop a long wait whose JSON answer has not started.
      responseMode: "sse",
    },
  );
  const serve = toNodeHandler(handler, {
    onerror,
    maxRequestBodySize: REX_MCP_MAX_MESSAGE_BYTES,
  });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const http = createServer();
  let port = options.port;
  const ownUid = process.platform === "linux" ? process.getuid?.() : undefined;
  const peerChecks = new WeakMap<Socket, Promise<boolean>>();

  /** Whether the connection was made by this process's user; checked once per connection. */
  function checkPeer(socket: Socket): Promise<boolean> {
    if (ownUid === undefined) return Promise.resolve(true);
    let check = peerChecks.get(socket);
    if (check === undefined) {
      // A table that cannot be read holds no row, so the connection is refused.
      const readTable = (path: string) => readFile(path, "utf8").catch(() => "");
      check = Promise.all([readTable("/proc/net/tcp"), readTable("/proc/net/tcp6")]).then(
        (tables) =>
          Option.getOrUndefined(findTcpPeerUid(tables.join("\n"), socket.remotePort ?? 0, port)) ===
          ownUid,
      );
      peerChecks.set(socket, check);
    }
    return check;
  }

  async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Each answers a request itself when its Host, or a browser's Origin, is not localhost,
    // 127.0.0.1, or [::1].
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== REX_MCP_HTTP_PATH) {
      return sendError(response, 404, `Not found: MCP answers on ${REX_MCP_HTTP_PATH}`);
    }
    if (!(await checkPeer(request.socket))) {
      return sendError(response, 403, "Forbidden: the connection comes from another user");
    }
    // The adapter reads only these; Node types `method` and `url` as possibly undefined.
    await serve(
      {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
      },
      response,
    );
  }

  http.on("request", (request, response) => {
    answer(request, response).catch((error: unknown) => {
      onerror(error instanceof Error ? error : new Error(String(error)));
      if (!response.headersSent) sendError(response, 500, `Internal error: ${String(error)}`);
      else response.end();
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
  const address: AddressInfo | string | null = http.address();
  if (typeof address === "object" && address !== null) port = address.port;

  return {
    url: `http://127.0.0.1:${port}${REX_MCP_HTTP_PATH}`,
    close: async () => {
      await handler.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
