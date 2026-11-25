/**
 * Entry point of the rex Claude Code plugin: serves the Rex tools over stdio (see rex-mcp-server.ts).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Layer, Logger } from "effect";
import { rexSdkLayerFromOptions } from "../src/index.ts";
import { rexHereFromEnv } from "../pi/index.ts";
import { rexToolOperations } from "../pi/rex-tool-operations.ts";
import { RexToolRuntime } from "../pi/rex-tool-runtime.ts";
import { REX_MCP_SERVER_VERSION, RexMcpServer } from "./rex-mcp-server.ts";

// stdout carries the MCP messages, so Effect's built-in loggers write to stderr.
const runtime = new RexToolRuntime(() =>
  rexSdkLayerFromOptions({
    client: { kind: "agent", name: "cc-rex-mcp", version: REX_MCP_SERVER_VERSION },
  }).pipe(Layer.provideMerge(Layer.succeed(Logger.LogToStderr, true))),
);
const transport = new StdioServerTransport();
await new RexMcpServer(runtime, rexToolOperations, rexHereFromEnv(process.env)).connect(transport);
// The stdio transport ignores the end of stdin. Close it then, so the runtime's Rex connection is
// disposed and the process exits instead of outliving Claude Code.
process.stdin.once("end", () => void transport.close());
