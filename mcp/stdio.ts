/**
 * Serves the Rex tools to one client over stdio, such as the Claude Code plugin in .mcp.json.
 * The client runs in the block REX_BLOCK names. http.ts serves every agent on the machine from one
 * process instead.
 */
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  loadRexMcpDocs,
  makeRexMcpRuntime,
  parseCallerBlockId,
  REX_MCP_MAX_MESSAGE_BYTES,
  RexMcpServer,
} from "./rex-mcp-server.ts";
import { rexTools } from "./rex-tools.ts";

const callerBlockId = parseCallerBlockId(process.env.REX_BLOCK);
const runtime = makeRexMcpRuntime();
const mcp = new RexMcpServer(runtime, rexTools, await loadRexMcpDocs());
serveStdio(
  () => {
    const instance = mcp.createServer(callerBlockId);
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
