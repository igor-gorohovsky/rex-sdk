/**
 * The Rex tools as an MCP server, for every MCP client (Claude Code, pi, …): one tool per row of
 * the tool table in rex-tools.ts, and the usage text in instructions.md as the server instructions.
 *
 * Results are JSON text only. Claude Code's code mode hands a script the parsed value of JSON text,
 * but a string once a result carries `structuredContent` (v2.1.332), and MCP allows an
 * `outputSchema` only with `structuredContent`, so each description ends with the result's
 * TypeScript type instead.
 *
 * A server instance holds no state of its own: the transport builds one per HTTP request or stdio
 * connection with the client's block (`callerBlockId`), and the marks live in the process-wide store.
 */
import { readFileSync } from "node:fs";
import { isSpecType, Server, type CallToolResult, type Tool } from "@modelcontextprotocol/server";
import { Layer, Logger, Schema } from "effect";
import { BlockId, rexSdkLayerFromOptions } from "../src/index.ts";
import plugin from "./.claude-plugin/plugin.json" with { type: "json" };
import { RexMarkStore } from "./rex-marks.ts";
import { describeResultType } from "./rex-result-types.ts";
import { convertToErrorResult, RexToolRuntime } from "./rex-tool-runtime.ts";
import {
  deriveRexToolOutputJsonSchema,
  deriveRexToolParametersJsonSchema,
} from "./rex-tool-schemas.ts";
import type { RexTool } from "./rex-tools.ts";

/** The version in `.claude-plugin/plugin.json`, sent as the MCP server and Rex client version. */
const REX_MCP_SERVER_VERSION = plugin.version;

/** How to use the tools, sent as the server instructions: Claude Code and pi show it to the model. */
const rexMcpInstructions = readFileSync(new URL("./instructions.md", import.meta.url), "utf8");

/**
 * How often a call still running sends its client a progress notification, when the client asked
 * for them. Each one resets the client's per-request timeout (pi's is 60 s), so a wait runs as
 * long as its own `timeoutMs`.
 */
const PROGRESS_INTERVAL_MS = 15_000;

/** The largest MCP message either transport reads; a pasted file travels inside one. */
export const REX_MCP_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

/**
 * The SDK runtime the entries serve from: one Rex connection, opened on first use, named after
 * this server. stdout may carry MCP messages, so Effect's built-in loggers write to stderr.
 */
export function makeRexMcpRuntime(): RexToolRuntime {
  return new RexToolRuntime(() =>
    rexSdkLayerFromOptions({
      client: { kind: "agent", name: "rex-mcp", version: REX_MCP_SERVER_VERSION },
    }).pipe(Layer.provideMerge(Layer.succeed(Logger.LogToStderr, true))),
  );
}

/** A tool as listed, and what answering a call to it needs. */
interface RexMcpTool {
  readonly tool: RexTool;
  readonly parameterNames: ReadonlySet<string>;
}

const isBlockId = Schema.is(BlockId);

/**
 * The caller's block from what its client reports (the `X-Rex-Block` header or `REX_BLOCK`):
 * null when that is not one block ID, such as empty for an unset variable.
 */
export function parseCallerBlockId(value: string | null | undefined): BlockId | null {
  return isBlockId(value) ? value : null;
}

function convertToListedTool(tool: RexTool): Tool {
  const result = deriveRexToolOutputJsonSchema(tool.output);
  const listed = {
    name: tool.name,
    description: `${tool.description}\n\nReturns: ${describeResultType(result)}`,
    inputSchema: deriveRexToolParametersJsonSchema({ fields: tool.fields, input: tool.input }),
    annotations: tool.annotations,
  };
  if (!isSpecType.Tool(listed)) throw new Error(`Rex tool ${tool.name} is not a valid MCP tool`);
  return listed;
}

function readParameterNames(listed: Tool): ReadonlySet<string> {
  return new Set(Object.keys(listed.inputSchema.properties ?? {}));
}

/** Serves the Rex tools on one SDK runtime, which the caller builds and disposes. */
export class RexMcpServer {
  readonly #runtime: RexToolRuntime;
  readonly #marks = new RexMarkStore();
  readonly #tools: ReadonlyMap<string, RexMcpTool>;
  readonly #listed: readonly Tool[];
  readonly #progressIntervalMs: number;

  constructor(
    runtime: RexToolRuntime,
    tools: readonly RexTool[],
    options: { readonly progressIntervalMs?: number } = {},
  ) {
    this.#runtime = runtime;
    this.#progressIntervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
    const entries = tools.map((tool) => ({ tool, listed: convertToListedTool(tool) }));
    this.#listed = entries.map(({ listed }) => listed);
    this.#tools = new Map(
      entries.map(({ tool, listed }) => [
        tool.name,
        { tool, parameterNames: readParameterNames(listed) },
      ]),
    );
  }

  /** Every tool, as `tools/list` returns them. */
  listTools(): Tool[] {
    return [...this.#listed];
  }

  /** An MCP server instance for one request or connection of a client in `callerBlockId`. */
  createServer(callerBlockId: BlockId | null): Server {
    const server = new Server(
      { name: "rex", version: REX_MCP_SERVER_VERSION },
      { capabilities: { tools: {} }, instructions: rexMcpInstructions },
    );
    server.setRequestHandler("tools/list", async () => ({ tools: this.listTools() }));
    server.setRequestHandler("tools/call", async (request, context) => {
      const progressToken = context.mcpReq._meta?.progressToken;
      let progress = 0;
      const timer =
        progressToken === undefined
          ? undefined
          : setInterval(() => {
              progress += 1;
              // A client gone mid-call cannot be told; the call itself sees the abort signal.
              context.mcpReq
                .notify({ method: "notifications/progress", params: { progressToken, progress } })
                .catch(() => undefined);
            }, this.#progressIntervalMs);
      try {
        return await this.callTool(
          request.params.name,
          request.params.arguments ?? {},
          callerBlockId,
          context.mcpReq.signal,
        );
      } finally {
        clearInterval(timer);
      }
    });
    return server;
  }

  /**
   * Answers one `tools/call`. Every failure, including an unknown tool or an argument the tool does
   * not declare (`SchemaError`, nothing sent), is an `isError` result whose text starts with
   * the error tag.
   */
  async callTool(
    name: string,
    params: { readonly [key: string]: unknown },
    callerBlockId: BlockId | null,
    signal: AbortSignal | undefined,
  ): Promise<CallToolResult> {
    const entry = this.#tools.get(name);
    if (entry === undefined)
      return convertToErrorResult(`RexUnknownTool: no Rex tool is named ${name}`);
    const unknown = Object.keys(params).filter((key) => !entry.parameterNames.has(key));
    if (unknown.length > 0) {
      return convertToErrorResult(
        `SchemaError: ${unknown.map((key) => `unknown field "${key}"`).join("; ")}`,
      );
    }
    return this.#runtime.call(entry.tool, params, { callerBlockId, marks: this.#marks }, signal);
  }
}
