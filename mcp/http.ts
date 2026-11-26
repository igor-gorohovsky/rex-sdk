/**
 * Serves the Rex tools to every agent on this machine (Claude Code and pi sessions) from one
 * process, over MCP streamable HTTP on 127.0.0.1 (see rex-mcp-http.ts). Run it as a service:
 *
 *   node mcp/http.ts [--port 7317]
 *
 * SIGTERM or SIGINT stops serving and closes the Rex connection before the process exits.
 */
import { parseArgs } from "node:util";
import { REX_MCP_HTTP_DEFAULT_PORT, startRexMcpHttpServer } from "./rex-mcp-http.ts";
import { loadRexMcpDocs, makeRexMcpRuntime, RexMcpServer } from "./rex-mcp-server.ts";
import { rexTools } from "./rex-tools.ts";

const { values } = parseArgs({ options: { port: { type: "string" } } });
const portText = values.port ?? String(REX_MCP_HTTP_DEFAULT_PORT);
const port = Number(portText);
if (!/^\d+$/.test(portText) || port > 65_535) {
  throw new Error(`--port ${portText} is not a port number`);
}
const docs = await loadRexMcpDocs();
const runtime = makeRexMcpRuntime();
const service = await startRexMcpHttpServer({
  mcp: new RexMcpServer(runtime, rexTools, docs),
  port,
});
console.error(`rex-mcp: serving ${service.url}`);

async function stop(signal: string): Promise<void> {
  console.error(`rex-mcp: ${signal}, stopping`);
  await service.close();
  await runtime.dispose();
  process.exit(0);
}
process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGINT", () => void stop("SIGINT"));
