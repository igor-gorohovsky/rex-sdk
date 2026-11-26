/**
 * The Rex tools as an MCP server for Claude Code: `rex_search` and one tool per SDK operation, the
 * same table, parameters, and error messages as the pi extension in `../pi`.
 *
 * Results are JSON text only. Claude Code's code mode parses a JSON text result into an object, but
 * hands a script a string once a result carries `structuredContent` (measured on v2.1.332), and MCP
 * allows an `outputSchema` only with `structuredContent`.
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { Effect, Exit, Layer, Logger, Option } from "effect";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { RexSdk, rexSdkLayerFromOptions } from "../src/index.ts";
import { RexMarkStore } from "../pi/rex-tool-marks.ts";
import type { RexToolOperation } from "../pi/rex-tool-operations.ts";
import {
  makeRexToolProgram,
  RexToolError,
  RexToolRuntime,
  toRexToolResult,
} from "../pi/rex-tool-runtime.ts";
import {
  rexToolOutputJsonSchema,
  rexToolParametersJsonSchema,
  rexToolVoidOutputJsonSchema,
} from "../pi/rex-tool-schemas.ts";
import {
  readSearchInput,
  REX_SEARCH_TOOL_NAME,
  rexToolInstructions,
  searchRexTools,
  toRexSearchToolDefinition,
  type RexSearchHere,
} from "../pi/rex-tool-search.ts";
import plugin from "./.claude-plugin/plugin.json" with { type: "json" };
import { describeResultType } from "./rex-result-types.ts";

/** The version in `.claude-plugin/plugin.json`, sent as the MCP server and Rex client version. */
export const REX_MCP_SERVER_VERSION = plugin.version;

/**
 * The SDK runtime both entries serve from: one Rex connection, opened on first use, named after
 * this server. stdout may carry MCP messages, so Effect's built-in loggers write to stderr.
 */
export function makeRexMcpRuntime(): RexToolRuntime {
  return new RexToolRuntime(() =>
    rexSdkLayerFromOptions({
      client: { kind: "agent", name: "cc-rex-mcp", version: REX_MCP_SERVER_VERSION },
    }).pipe(Layer.provideMerge(Layer.succeed(Logger.LogToStderr, true))),
  );
}

/** The pi texts that name pi or pi's way of calling a tool, as Claude Code words them. */
const CLAUDE_CODE_WORDING: ReadonlyArray<readonly [pi: string, claudeCode: string]> = [
  [
    "Find tools: rex_search({ query, namespace?, limit? }) → describeTool(name) for the signature → tools.<name>(args).",
    'Find tools: searchTools("rex <words>") → describeTool(name) for the parameters → tools[name](args), with the full name searchTools returns. Claude Code puts the MCP server\'s prefix before each tool name, and the prefix depends on how this server is installed, so never write a name by hand: rex_terminals_writeLine is the tool whose name ends in "__rex_terminals_writeLine". rex_search({ query }) ranks the same tools by their short names. describeTool shows a tool\'s parameters, and its description ends with what it returns (Returns: a TypeScript type).',
  ],
  [
    "the session and terminal block pi runs in",
    "the session and terminal block this Claude Code session runs in",
  ],
  ["the session and block pi runs in", "the session and block this Claude Code session runs in"],
  ["in this pi session", "in this Claude Code session"],
];

/** A pi text worded for Claude Code. The tests fail if pi rewords a text this relies on. */
function convertTextForClaudeCode(text: string): string {
  // A replacer function inserts the text as is; a replacement string would expand `$&` and such.
  return CLAUDE_CODE_WORDING.reduce(
    (result, [pi, claudeCode]) => result.replace(pi, () => claudeCode),
    text,
  );
}

function parseInputSchema(schema: unknown): Tool["inputSchema"] {
  return ToolSchema.shape.inputSchema.parse(schema);
}

function nameOperationTool(operation: RexToolOperation): string {
  return `rex_${operation.name}`;
}

function describeOperationTool(operation: RexToolOperation): Tool {
  const result =
    operation.output === "void"
      ? rexToolVoidOutputJsonSchema
      : rexToolOutputJsonSchema(operation.output);
  return {
    name: nameOperationTool(operation),
    description: `${operation.description}\n\nReturns: ${describeResultType(result)}`,
    inputSchema: parseInputSchema(
      rexToolParametersJsonSchema({ fields: operation.fields, input: operation.input }),
    ),
    annotations: operation.annotations,
  };
}

function convertToTextResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function convertToErrorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Ajv errors as one line naming each bad argument: `arguments has unknown field "sinc"`. */
function describeArgumentErrors(errors: readonly ErrorObject[]): string {
  return errors
    .map((error) => {
      const path = `arguments${error.instancePath.replaceAll("/", ".")}`;
      const unknownProperty: unknown = error.params.additionalProperty;
      return typeof unknownProperty === "string"
        ? `${path} has unknown field "${unknownProperty}"`
        : `${path} ${error.message ?? "is invalid"}`;
    })
    .join("; ");
}

/** A tool this server answers: its argument validator, and its operation (none for rex_search). */
interface RexMcpTool {
  readonly validate: ValidateFunction;
  readonly operation: RexToolOperation | undefined;
}

/** One connected client: where it runs, and the marks handed to it, which no other client sees. */
interface RexMcpClient {
  readonly here: RexSearchHere;
  /**
   * `here` with its session looked up: the lookup running now, or the one that found the session.
   * A lookup that failed or found nothing is dropped, so the next empty `rex_search` asks again.
   */
  completeHere: Promise<RexSearchHere> | undefined;
  readonly marks: RexMarkStore;
}

/** The session holding `blockId`, or none when no session holds it; fails when Rex cannot be asked. */
function findSessionOfBlock(blockId: string) {
  return Effect.gen(function* () {
    const rex = yield* RexSdk;
    const { sessions } = yield* rex.sessions.list();
    const holders = yield* Effect.forEach(
      sessions,
      ({ sessionId }) =>
        rex.sessions.view({ sessionId }).pipe(
          Effect.map((view) =>
            view.windows.some((window) =>
              window.layers.some((layer) =>
                layer.blocks.some((block) => block.blockId === blockId),
              ),
            ),
          ),
          // A session closed since the list holds no block.
          Effect.catchTags({
            RexSessionNotFound: () => Effect.succeed(false),
            RexNotFound: () => Effect.succeed(false),
          }),
        ),
      { concurrency: "unbounded" },
    );
    return Option.fromUndefinedOr(sessions.find((_, index) => holders[index])?.sessionId);
  });
}

/**
 * Serves the Rex tools on one SDK runtime, which the caller builds and disposes, to any number of
 * clients at once: each `connect` serves one client.
 */
export class RexMcpServer {
  readonly #runtime: RexToolRuntime;
  readonly #operations: readonly RexToolOperation[];
  readonly #instructions = convertTextForClaudeCode(rexToolInstructions);
  readonly #tools: readonly Tool[];
  readonly #toolsByName: ReadonlyMap<string, RexMcpTool>;

  constructor(runtime: RexToolRuntime, operations: readonly RexToolOperation[]) {
    this.#runtime = runtime;
    this.#operations = operations;
    // Only the definition's name, description, and parameters are used: each client's own here
    // goes to searchRexTools.
    const search = toRexSearchToolDefinition(operations, { sessionId: null, blockId: null });
    this.#tools = [
      {
        name: search.name,
        description: convertTextForClaudeCode(search.description),
        inputSchema: parseInputSchema(search.parameters),
        annotations: search.annotations,
      },
      ...operations.map(describeOperationTool),
    ];
    // pi validates arguments against the schema before a tool runs; MCP hands them over as sent.
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const operationsByTool = new Map(
      operations.map((operation) => [nameOperationTool(operation), operation]),
    );
    this.#toolsByName = new Map(
      this.#tools.map((tool) => [
        tool.name,
        { validate: ajv.compile(tool.inputSchema), operation: operationsByTool.get(tool.name) },
      ]),
    );
  }

  /** `rex_search` and one tool per operation, as `tools/list` returns them. */
  listTools(): Tool[] {
    return [...this.#tools];
  }

  /**
   * Serves the tools to the client on `transport`, which runs in `here` (a block without its
   * session is completed from Rex on first use). Closing the transport closes the returned server
   * and leaves the runtime to the caller.
   */
  async connect(transport: Transport, here: RexSearchHere): Promise<Server> {
    const client: RexMcpClient = { here, completeHere: undefined, marks: new RexMarkStore() };
    const server = new Server(
      { name: "rex", version: REX_MCP_SERVER_VERSION },
      {
        capabilities: { tools: {} },
        instructions: this.#instructions,
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
      this.#callTool(client, request.params.name, request.params.arguments ?? {}, extra.signal),
    );
    await server.connect(transport);
    return server;
  }

  /**
   * Answers one `tools/call`. Every failure, including an unknown tool or arguments that do not
   * match its input schema (`SchemaError`, nothing sent), is an `isError` result whose text starts
   * with the error tag.
   */
  async #callTool(
    client: RexMcpClient,
    name: string,
    params: { readonly [key: string]: unknown },
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const tool = this.#toolsByName.get(name);
    if (tool === undefined) {
      return convertToErrorResult(`Unknown tool ${name}; find tools with ${REX_SEARCH_TOOL_NAME}.`);
    }
    if (!tool.validate(params)) {
      return convertToErrorResult(
        `SchemaError: ${describeArgumentErrors(tool.validate.errors ?? [])}`,
      );
    }
    const operation = tool.operation;
    if (operation === undefined) {
      const found = searchRexTools(
        this.#operations,
        readSearchInput(params),
        client.here,
        this.#instructions,
      );
      // Only an empty search shows where the client runs; a search for tools never asks Rex.
      return convertToTextResult(
        "here" in found ? { ...found, here: await this.#completeHere(client) } : found,
      );
    }
    const exit = await this.#runtime.run(
      makeRexToolProgram(operation, params, client.marks),
      signal,
    );
    try {
      return convertToTextResult(toRexToolResult(exit).structuredContent);
    } catch (error) {
      // A configuration failure is cached by the runtime's Layer; rebuild it on the next call.
      if (error instanceof RexToolError && error.tag === "RexConfigurationError") {
        await this.#runtime.dispose();
      }
      return convertToErrorResult(error instanceof Error ? error.message : String(error));
    }
  }

  /** The client's `here` with the session of its block looked up when it came without one. */
  async #completeHere(client: RexMcpClient): Promise<RexSearchHere> {
    const { here } = client;
    const { sessionId, blockId } = here;
    if (sessionId !== null || blockId === null) return here;
    // No abort signal: searches made while it runs share the lookup.
    client.completeHere ??= this.#runtime.run(findSessionOfBlock(blockId), undefined).then(
      (exit) =>
        Exit.isSuccess(exit) && Option.isSome(exit.value)
          ? { sessionId: exit.value.value, blockId }
          : here,
      () => here,
    );
    const completed = await client.completeHere;
    if (completed.sessionId === null) client.completeHere = undefined;
    return completed;
  }
}
