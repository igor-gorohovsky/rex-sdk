# rex MCP server

Serves this SDK to agents as an MCP server: one tool per SDK operation, plus `here`, for Claude
Code, pi, and any other MCP client. The tool table is [`rex-tools.ts`](rex-tools.ts). The usage
docs are one skill, [`skills/rex/SKILL.md`](skills/rex/SKILL.md); nothing else
describes the tools.

## The docs

The server serves the skill through the MCP skills extension (`io.modelcontextprotocol/skills`:
`skills/list`, `skills/get`, `resources/directory/read`) at `skill://rex/SKILL.md`, which
is also an ordinary resource. The server instructions are one line that points to that resource,
so the docs cost context only when an agent reads them:

| Client                                                             | How the docs reach the model                                                           |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Claude Code, MCP skills blocked (Team plan default) or `claude -p` | The pointer in the instructions; the agent reads the resource (ReadMcpResourceTool)    |
| Claude Code, MCP skills allowed                                    | The pointer, and `rex` as a skill                                                      |
| pi (no MCP skills)                                                 | The pointer in the system prompt; the agent reads the resource (`read_mcp_resource`)   |
| Claude Code with this folder as a plugin (`--plugin-dir`)          | Also `rex:rex` as a plugin skill: Claude Code loads a plugin's `skills/` folder itself |

Keep SKILL.md short; longer guidance belongs in files under `skills/rex/references/`, which the
extension serves too. The server reads the skill once, at start, and serves that text until it
restarts, however the checkout changes.

## Run it

One process serves every agent on a machine over MCP streamable HTTP on 127.0.0.1, with one Rex
connection. Run it as a service, then point each client at it, passing the block the agent runs
in as a header:

```sh
node <checkout>/mcp/http.ts --port 7317
claude mcp add -s user --transport http rex http://127.0.0.1:7317/mcp -H 'X-Rex-Block: ${REX_BLOCK:-}'
pi mcp add rex --url http://127.0.0.1:7317/mcp --header 'X-Rex-Block=!printf %s "${REX_BLOCK:-none}"'
```

The headers differ because the hosts expand them differently. Claude Code sends
`${REX_BLOCK:-}` empty outside Rex. pi knows only `${NAME}`, drops the whole server when the
variable is unset, and sends any other `${…}` as written; it also drops a header whose `!command`
prints nothing. So pi runs a command that prints `none` outside Rex, which the server reads as
no block.

Outside Rex the server offers nothing: a request with no block, `none`, or a block Rex does not
have gets an empty server, with no tools, resources, or instructions, so an agent started outside
Rex does not carry the tools. An agent outside Rex that needs them, such as a `claude -p` a timer
starts, opts in with `X-Rex-Headless: 1` (`REX_MCP_HEADLESS=1` over stdio) and gets the tools,
with no block. Inside Rex the instructions begin with the session and block the agent runs in:

```text
You run in Rex session session:…, block block:… (the here tool answers fresh). Rex MCP server: …
```

The server asks Rex where the block is on every request (one `target.resolve`); when Rex does
not answer, it keeps serving the block, with no session.

A call still running sends a progress notification every 15 seconds when the client asks for
them, as pi does. Each one resets pi's 60-second request timeout, so a wait runs as long as its
`timeoutMs`.

For one client without a service, run it over stdio, where `REX_BLOCK` says where the agent
runs: `claude --plugin-dir <checkout>/mcp` (the plugin's `.mcp.json`), or
`claude mcp add -s local rex -- node <checkout>/mcp/stdio.ts`.

Needs Node.js 22.18 or later and `pnpm install` in the checkout: the server imports `../src`
directly, so it has no build step and works only from a checkout.

## What an agent sees

```js
// Claude Code: find the full name (the client adds a prefix such as mcp__rex__), then call it.
const t = (op) => tools[tools.list().find((name) => name.endsWith(`rex__${op}`))];
const { sessionId, blockId } = await t("here")({});
const { markId } = await t("terminals_writeLine")({ sessionId, blockId, text: "pnpm test" });
const done = await t("terminals_waitForOutput")({
  sessionId,
  blockId,
  since: markId,
  match: { type: "regex", value: "passed|failed" },
  timeoutMs: 120000,
});
```

```js
// pi: the same tools as tools.mcp__rex__*; a call resolves to the MCP result.
const call = async (op, args) => {
  const result = await tools[`mcp__rex__${op}`](args);
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
};
const { sessionId, blockId } = await call("here", {});
```

The skill covers names, parameters, results, failures, and waits. What it leaves to the code:

- **Results** carry no `structuredContent`, and each description ends with the result's
  TypeScript type instead: Claude Code (2.1.332) hands a script a string instead of the parsed
  value once a result has it, and MCP allows an `outputSchema` only with `structuredContent`.
- **`here`** takes the block from the `X-Rex-Block` header of each request, or `REX_BLOCK` over
  stdio, and asks Rex (`target.resolve`) for its session; null for both for a headless agent.
- **Marks** live in one store per process: the newest 1024 under random IDs, so a restart forgets
  them (`RexUnknownMark`).
- **Not exposed**: `rexToolExclusions` in `rex-tools.ts` names each SDK operation left out, and
  why.

## The service

- Serving is stateless: every request gets a fresh MCP server instance, for 2026-07-28 clients
  (Claude Code) and 2025 clients (pi) alike. There are no MCP sessions to keep or expire, and a
  restart costs a client nothing but the calls made while it is down.
- It answers only requests whose Host header (and a browser's Origin) is a loopback address, and
  on Linux only connections made by its own user.

| File                  | Owns                                                            |
| --------------------- | --------------------------------------------------------------- |
| `rex-tools.ts`        | The tool table and the SDK operations left out                  |
| `skills/rex/`         | The usage docs: the skill the server instructions point to      |
| `rex-tool-schemas.ts` | Effect Schema → JSON Schema for parameters and results          |
| `rex-result-types.ts` | A result's JSON Schema → the TypeScript type in its description |
| `rex-tool-runtime.ts` | The lazily built SDK runtime, exits → MCP tool results          |
| `rex-marks.ts`        | The process-wide mark store                                     |
| `rex-mcp-server.ts`   | Tool listing and calls, the caller check, and the instructions  |
| `rex-mcp-http.ts`     | HTTP serving, Host and peer checks                              |
| `http.ts`, `stdio.ts` | Entry points                                                    |
| `test/`               | Every tool and both protocol eras against the SDK's test server |
