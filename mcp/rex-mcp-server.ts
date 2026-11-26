/**
 * The Rex tools as an MCP server, for every MCP client (Claude Code, pi, …): one tool per row of
 * the tool table in rex-tools.ts, and the usage docs as one skill, skills/rex/SKILL.md, served
 * as an MCP skill and a resource that the server instructions point to (README.md, "The docs").
 *
 * Results are JSON text only. Claude Code's code mode hands a script the parsed value of JSON text,
 * but a string once a result carries `structuredContent` (v2.1.332), and MCP allows an
 * `outputSchema` only with `structuredContent`, so each description ends with the result's
 * TypeScript type instead.
 *
 * A server instance holds no state of its own: the transport builds one per HTTP request or stdio
 * connection for the client's caller claim, and the marks live in the process-wide store. A client
 * outside Rex that does not opt in is offered nothing.
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
import { Duration, Effect, Exit, Layer, Logger, Schema } from "effect";
import { BlockId, RexSdk, rexSdkLayerFromOptions, type SessionId } from "../src/index.ts";
import plugin from "./.claude-plugin/plugin.json" with { type: "json" };
import { RexMarkStore } from "./rex-marks.ts";
import { describeResultType } from "./rex-result-types.ts";
import { convertToErrorResult, RexToolRuntime } from "./rex-tool-runtime.ts";
import {
  deriveRexToolOutputJsonSchema,
  deriveRexToolParametersJsonSchema,
} from "./rex-tool-schemas.ts";
import { findBlockSession, type RexTool } from "./rex-tools.ts";

/** The version in `.claude-plugin/plugin.json`, sent as the MCP server and Rex client version. */
const REX_MCP_SERVER_VERSION = plugin.version;

/** The folder of skill folders the server serves. */
const REX_SKILLS_ROOT = fileURLToPath(new URL("./skills", import.meta.url));

/** Where a client finds the usage docs, the rex skill, as a skill or a plain resource. */
export const REX_SKILL_URI = "skill://rex/SKILL.md";

/** The pointer to the skill in the server instructions: the docs cost context only when read. */
const REX_MCP_SKILL_POINTER = `Rex MCP server: tools that drive Rex sessions, tabs, panes, and terminals. Required before your first Rex tool call: read the usage guide, the MCP resource ${REX_SKILL_URI} on this server (Claude Code: ReadMcpResourceTool; pi: read_mcp_resource), which gives the result shape, the error tags, and how to run a command and wait for its output; the tool list alone does not.`;

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
 * Loads the skills under `skillsRoot` once: they keep the text they started with until a restart.
 * A SKILL.md the extension would warn about fails the start instead.
 */
export function loadRexMcpSkills(skillsRoot: string = REX_SKILLS_ROOT): Promise<SkillCatalog> {
  return SkillsExtension.load(cacheSkillFileReads(nodeSkillFiles(skillsRoot)), { strict: true });
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
 * What a client reports about where it runs: its block (the `X-Rex-Block` header or `REX_BLOCK`),
 * null when that is not one block ID (empty for an unset variable, `none`), and whether it opts in
 * from outside Rex (the `X-Rex-Headless` header or `REX_MCP_HEADLESS`, any non-empty value), as an
 * agent a timer starts does.
 */
export interface RexMcpCallerClaim {
  readonly blockId: BlockId | null;
  readonly headless: boolean;
}

export function parseRexMcpCallerClaim(
  block: string | null | undefined,
  headless: string | null | undefined,
): RexMcpCallerClaim {
  return { blockId: isBlockId(block) ? block : null, headless: Boolean(headless) };
}

/**
 * Who the server serves, once Rex has checked the claim: a block Rex knows (`sessionId` null when
 * Rex did not answer), an agent outside Rex that opted in, or anyone else, who is offered nothing.
 */
type RexMcpCaller =
  | { readonly _tag: "InRex"; readonly blockId: BlockId; readonly sessionId: SessionId | null }
  | { readonly _tag: "Headless" }
  | { readonly _tag: "Outside" };

/** How long the server waits for Rex to say where a caller's block is. */
const LOCATE_TIMEOUT = Duration.seconds(3);

/** The server instructions, one line, as pi puts only the first line in its system prompt. */
function describeRexMcpInstructions(caller: Exclude<RexMcpCaller, { _tag: "Outside" }>): string {
  if (caller._tag === "Headless") return REX_MCP_SKILL_POINTER;
  const where =
    caller.sessionId === null
      ? `You run in Rex block ${caller.blockId}; Rex did not say its session (the here tool asks again).`
      : `You run in Rex session ${caller.sessionId}, block ${caller.blockId} (the here tool answers fresh).`;
  return `${where} ${REX_MCP_SKILL_POINTER}`;
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
  readonly #skills: SkillCatalog;

  constructor(
    runtime: RexToolRuntime,
    tools: readonly RexTool[],
    skills: SkillCatalog,
    options: { readonly progressIntervalMs?: number } = {},
  ) {
    this.#runtime = runtime;
    this.#skills = skills;
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

  /**
   * An MCP server instance for one request or connection of a client that claims `claim`: with
   * nothing in it (no tools, skills, or instructions) for a caller outside Rex that did not opt in.
   */
  async createServer(claim: RexMcpCallerClaim): Promise<McpServer> {
    const caller = await this.#locateCaller(claim);
    if (caller._tag === "Outside")
      return new McpServer({ name: "rex", version: REX_MCP_SERVER_VERSION });
    const callerBlockId = caller._tag === "InRex" ? caller.blockId : null;
    // McpServer because the skills extension attaches only to one; the tools are answered from the
    // precomputed table on its low-level server, not registered one by one. The tools capability
    // goes there too: McpServer's `tools` option would install its own tool handlers and advertise
    // `listChanged`, which this server never sends.
    const mcpServer = new McpServer(
      { name: "rex", version: REX_MCP_SERVER_VERSION },
      { instructions: describeRexMcpInstructions(caller) },
    );
    mcpServer.server.registerCapabilities({ tools: {} });
    this.#skills.attach(mcpServer);
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

  /**
   * The caller its claim describes, asking Rex for the claimed block: a block Rex does not have
   * counts as no block. When Rex does not answer, the caller keeps its block, with no session.
   */
  async #locateCaller({ blockId, headless }: RexMcpCallerClaim): Promise<RexMcpCaller> {
    if (blockId !== null) {
      const located = await this.#runtime.run(
        Effect.gen(function* () {
          const rex = yield* RexSdk;
          return yield* findBlockSession(rex, blockId, { timeout: LOCATE_TIMEOUT });
        }),
      );
      if (Exit.isFailure(located)) return { _tag: "InRex", blockId, sessionId: null };
      if (located.value !== null) return { _tag: "InRex", blockId, sessionId: located.value };
    }
    return headless ? { _tag: "Headless" } : { _tag: "Outside" };
  }
}
