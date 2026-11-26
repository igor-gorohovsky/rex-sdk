/**
 * Entry point of the rex Claude Code plugin: serves the Rex tools to one Claude Code session over
 * stdio (see rex-mcp-server.ts). http.ts serves every session on the machine from one process.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { rexHereFromEnv } from "../pi/index.ts";
import { rexToolOperations } from "../pi/rex-tool-operations.ts";
import { makeRexMcpRuntime, RexMcpServer } from "./rex-mcp-server.ts";

const runtime = makeRexMcpRuntime();
const transport = new StdioServerTransport();
const server = await new RexMcpServer(runtime, rexToolOperations).connect(
  transport,
  rexHereFromEnv(process.env),
);
server.onclose = () => void runtime.dispose();
// The stdio transport ignores the end of stdin. Close it then, so the runtime's Rex connection is
// disposed and the process exits instead of outliving Claude Code.
process.stdin.once("end", () => void transport.close());
