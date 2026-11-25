/**
 * The Rex tools as an MCP server for Claude Code: `rex_search` and one tool per SDK operation, the
 * same table, parameters, and error messages as the pi extension in `../pi`.
 *
 * Results are JSON text only. Claude Code's code mode parses a JSON text result into an object, but
 * hands a script a string once a result carries `structuredContent` (measured on v2.1.332), and MCP
 * allows an `outputSchema` only with `structuredContent`.
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { RexToolOperation } from "../pi/rex-tool-operations.ts";
import {
  makeRexToolProgram,
  RexToolError,
  type RexToolRuntime,
  toRexToolResult,
} from "../pi/rex-tool-runtime.ts";
import {
  rexToolOutputJsonSchema,
  rexToolParametersJsonSchema,
  rexToolVoidOutputJsonSchema,
} from "../pi/rex-tool-schemas.ts";
import {
  REX_SEARCH_TOOL_NAME,
  rexToolInstructions,
  runRexSearch,
  toRexSearchToolDefinition,
  type RexSearchHere,
} from "../pi/rex-tool-search.ts";
import plugin from "./.claude-plugin/plugin.json" with { type: "json" };
import { describeResultType } from "./rex-result-types.ts";

/** The version in `.claude-plugin/plugin.json`, sent as the MCP server and Rex client version. */
export const REX_MCP_SERVER_VERSION = plugin.version;

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

/** Serves the Rex tools on one SDK runtime, which the caller builds and this server disposes. */
export class RexMcpServer {
  readonly #runtime: RexToolRuntime;
  readonly #operations: readonly RexToolOperation[];
  readonly #here: RexSearchHere;
  readonly #instructions = convertTextForClaudeCode(rexToolInstructions);
  readonly #tools: readonly Tool[];
  readonly #toolsByName: ReadonlyMap<string, RexMcpTool>;

  constructor(
    runtime: RexToolRuntime,
    operations: readonly RexToolOperation[],
    here: RexSearchHere,
  ) {
    this.#runtime = runtime;
    this.#operations = operations;
    this.#here = here;
    const search = toRexSearchToolDefinition(operations, here);
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
   * Answers one `tools/call`. Every failure, including an unknown tool or arguments that do not
   * match its input schema (`SchemaError`, nothing sent), is an `isError` result whose text starts
   * with the error tag.
   */
  async callTool(
    name: string,
    params: { readonly [key: string]: unknown },
    signal?: AbortSignal,
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
      return convertToTextResult(
        runRexSearch(this.#operations, params, this.#here, this.#instructions).structuredContent,
      );
    }
    const exit = await this.#runtime.run(
      makeRexToolProgram(operation, params, this.#runtime.marks),
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

  /** Serves the tools on `transport`; closing it disposes the runtime. */
  async connect(transport: Transport): Promise<void> {
    const server = new Server(
      { name: "rex", version: REX_MCP_SERVER_VERSION },
      {
        capabilities: { tools: {} },
        instructions: this.#instructions,
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
      this.callTool(request.params.name, request.params.arguments ?? {}, extra.signal),
    );
    server.onclose = () => void this.#runtime.dispose();
    await server.connect(transport);
  }
}
