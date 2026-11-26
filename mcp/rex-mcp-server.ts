/**
 * The Rex tools as an MCP server, for every MCP client (Claude Code, pi, …): one tool per row of
 * the tool table in rex-tools.ts, and the usage docs as one skill, skills/rex-tools/SKILL.md, served
 * as an MCP skill and as the server instructions (README.md, "The docs").
 *
 * Results are JSON text only. Claude Code's code mode hands a script the parsed value of JSON text,
 * but a string once a result carries `structuredContent` (v2.1.332), and MCP allows an
 * `outputSchema` only with `structuredContent`, so each description ends with the result's
 * TypeScript type instead.
 *
 * A server instance holds no state of its own: the transport builds one per HTTP request or stdio
 * connection with the client's block (`callerBlockId`), and the marks live in the process-wide store.
 */
import { fileURLToPath } from "node:url";
import {
  isSpecType,
  McpServer,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/server";
import {
  SkillsExtension,
  type SkillCatalog,
  type SkillFiles,
} from "@modelcontextprotocol/server/ext/skills";
import { nodeSkillFiles } from "@modelcontextprotocol/server/ext/skills/node";
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

/** The folder of skill folders the server serves. */
const REX_SKILLS_ROOT = fileURLToPath(new URL("./skills", import.meta.url));

/**
 * The skill that holds the usage docs. Not `rex`: that is Rex's own skill for its CLI
 * (`rex skill show`, ~/.agents/skills/rex).
 */
const REX_SKILL_NAME = "rex-tools";

/** Where a client finds the usage docs, as a skill or a plain resource. */
export const REX_SKILL_URI = `skill://${REX_SKILL_NAME}/SKILL.md`;

/** The usage docs, served two ways from one SKILL.md. */
export interface RexMcpDocs {
  /** The skills extension's catalog: `skills/list`, `skills/get`, and `skill://` resources. */
  readonly skills: SkillCatalog;
  /** The server instructions. */
  readonly instructions: string;
}

/**
 * The server instructions: a pointer to the skill, then the SKILL.md body. The pointer comes first
 * because pi puts only the first line in its system prompt.
 */
function buildRexMcpInstructions(skillMarkdown: string): string {
  const body = skillMarkdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)+/, "");
  return `Rex tools for sessions, tabs, panes, terminals. The rest of these instructions is the rex-tools skill (${REX_SKILL_URI}): read it before the first call (pi: describeNamespace("mcp__rex")).\n\n${body}`;
}

/**
 * `files`, answering every read of a path with the bytes of its first read. The catalog reads each
 * file as it loads and checks every later read against the digest it took then, so without this a
 * skill file changed on disk (an edit, a pull) fails each read until a restart.
 */
function cacheSkillFileReads(files: SkillFiles): SkillFiles {
  const reads = new Map<string, Promise<Uint8Array>>();
  return {
    list: (dir) => files.list(dir),
    read: (path) => {
      const read = reads.get(path) ?? files.read(path);
      reads.set(path, read);
      return read;
    },
  };
}

/**
 * Loads the skills under `skillsRoot` once: the skill and the instructions keep the text they
 * started with until a restart. A SKILL.md the extension would warn about fails the start instead.
 */
export async function loadRexMcpDocs(skillsRoot: string = REX_SKILLS_ROOT): Promise<RexMcpDocs> {
  const files = cacheSkillFileReads(nodeSkillFiles(skillsRoot));
  const skills = await SkillsExtension.load(files, { strict: true });
  // From the cache the catalog filled, so the instructions are the text the skill serves.
  const skillMarkdown = new TextDecoder().decode(await files.read(`${REX_SKILL_NAME}/SKILL.md`));
  return { skills, instructions: buildRexMcpInstructions(skillMarkdown) };
}

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
  readonly #docs: RexMcpDocs;

  constructor(
    runtime: RexToolRuntime,
    tools: readonly RexTool[],
    docs: RexMcpDocs,
    options: { readonly progressIntervalMs?: number } = {},
  ) {
    this.#runtime = runtime;
    this.#docs = docs;
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
  createServer(callerBlockId: BlockId | null): McpServer {
    // McpServer because the skills extension attaches only to one; the tools are answered from the
    // precomputed table on its low-level server, not registered one by one. The tools capability
    // goes there too: McpServer's `tools` option would install its own tool handlers and advertise
    // `listChanged`, which this server never sends.
    const mcpServer = new McpServer(
      { name: "rex", version: REX_MCP_SERVER_VERSION },
      { instructions: this.#docs.instructions },
    );
    mcpServer.server.registerCapabilities({ tools: {} });
    this.#docs.skills.attach(mcpServer);
    mcpServer.server.setRequestHandler("tools/list", async () => ({ tools: this.listTools() }));
    mcpServer.server.setRequestHandler("tools/call", async (request, context) => {
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
    return mcpServer;
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
