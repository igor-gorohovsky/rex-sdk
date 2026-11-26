/**
 * Serves the Rex tools to one client over stdio, such as the Claude Code plugin in .mcp.json.
 * The client runs in the block REX_BLOCK names; outside Rex it gets an empty server unless
 * REX_MCP_HEADLESS is set. http.ts serves every agent on the machine from one
 * process instead.
 */
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  loadRexMcpSkills,
  makeRexMcpRuntime,
  parseRexMcpCallerClaim,
  REX_MCP_MAX_MESSAGE_BYTES,
  RexMcpServer,
} from "./rex-mcp-server.ts";
import { rexTools } from "./rex-tools.ts";

const claim = parseRexMcpCallerClaim(process.env.REX_BLOCK, process.env.REX_MCP_HEADLESS);
const runtime = makeRexMcpRuntime();
const mcp = new RexMcpServer(runtime, rexTools, await loadRexMcpSkills());
serveStdio(
  async () => {
    const instance = await mcp.createServer(claim);
    // However the connection ends (stdin closed, or a message the transport could not read),
    // dispose the Rex connection so the process exits instead of outliving its client. The
    // runtime is rebuilt if a later instance still calls a tool.
    instance.server.onclose = () => void runtime.dispose();
    return instance;
  },
  {
    // The same limit as over HTTP; past it the transport closes the connection.
    transport: new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: REX_MCP_MAX_MESSAGE_BYTES,
    }),
  },
);
