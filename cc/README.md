# rex for Claude Code

A Claude Code plugin, or a plain MCP server, that gives code-mode scripts this SDK as tools: `search`
and one tool per SDK operation, the same table as the [pi extension](../pi/README.md). Names drop
pi's `rex_` prefix, since Claude Code already puts the server's name before each tool
(`mcp__rex__terminals_writeLine`). It runs as an MCP server, over stdio per session (`index.ts`) or
over HTTP for every session on the machine (`http.ts`), because a mod can import neither this SDK's
packages nor a socket.

```sh
claude --plugin-dir <checkout>/cc                            # tools named mcp__plugin_rex_rex__*
claude mcp add -s local rex -- node <checkout>/cc/index.ts   # tools named mcp__rex__*
```

```js
// The prefix depends on how the server is installed, so look each tool up by the end of its name,
// rex__ included: another server may have a tool with the same short name, such as search.
const t = (op) => tools[tools.list().find((name) => name.endsWith(`rex__${op}`))];
const { sessions } = await t("sessions_list")({});
const { markId } = await t("terminals_writeLine")({ sessionId, blockId, text: "pnpm test" });
const done = await t("terminals_waitForOutput")({
  sessionId,
  blockId,
  since: markId,
  match: { type: "regex", value: "Tests? .* passed" },
  timeoutMs: 120000,
});
```

## One server for every session

`http.ts` serves the same tools over MCP streamable HTTP on 127.0.0.1, so every Claude Code session
on a machine shares one process and one Rex connection instead of starting a copy each (about
130 MB per copy). Each session still gets its own marks. Run it as a service, then point Claude
Code at it, passing the block the session runs in as a header:

```sh
node <checkout>/cc/http.ts --port 7317
claude mcp add -s user --transport http rex http://127.0.0.1:7317/mcp -H 'X-Rex-Block: ${REX_BLOCK:-}'
```

- `search({}).here` comes from the `X-Rex-Block` header (and `X-Rex-Session`, when set);
  the server looks up the block's session in Rex.
- It answers only requests whose Host header is its own loopback address.
- Claude Code sends no DELETE when it exits, so a session with no open request is ended after an
  hour unused. Claude Code starts a new session on its next call, as it does after the server
  restarts; calls made while the server is down fail with `MCP server "rex" is not connected`.

## Notes

- Needs Node.js 22.18 or later as `node` on the PATH Claude Code starts with, and `pnpm install` in
  the checkout. The server imports `../src` and `../pi` directly, so it has no build step and works
  only from a checkout.
- Parameters, marks, waits, and error tags are the pi extension's; names drop its `rex_` prefix.
  Find tools with `searchTools("rex …")` or `search`, and their parameters with `describeTool(name)`.
- Results are JSON text, which code mode parses into objects. Claude Code (v2.1.332) hands a script a
  string instead once a result carries `structuredContent`, and its `describeTool` shows no
  `outputSchema`, so the tools declare none. Each description ends with the result's TypeScript type
  instead (`Returns: { markId: string }`), rendered from the same schema the pi extension declares.
- A failure comes back as an MCP error whose text starts with the SDK error tag, such as
  `RexSessionNotFound: …`; in a script the call throws with that message.
