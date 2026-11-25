# rex for Claude Code

A Claude Code plugin, or a plain MCP server, that gives code-mode scripts this SDK as tools: `rex_search` and one tool per
SDK operation, the same table as the [pi extension](../pi/README.md). It runs as a stdio MCP server
(`index.ts`, `rex-mcp-server.ts`), because a mod can import neither this SDK's packages nor a socket.

```sh
claude --plugin-dir <checkout>/cc                            # tools named mcp__plugin_rex_rex__rex_*
claude mcp add -s local rex -- node <checkout>/cc/index.ts   # tools named mcp__rex__rex_*
```

```js
// The prefix depends on how the server is installed, so look each tool up by its short name.
const t = (op) => tools[tools.list().find((name) => name.endsWith(`__rex_${op}`))];
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

- Needs Node.js 22.18 or later as `node` on the PATH Claude Code starts with, and `pnpm install` in
  the checkout. The server imports `../src` and `../pi` directly, so it has no build step and works
  only from a checkout.
- Names, parameters, marks, waits, and error tags are the pi extension's. Find tools with
  `searchTools("rex …")` or `rex_search`, and their parameters with `describeTool(name)`.
- Results are JSON text, which code mode parses into objects. Claude Code (v2.1.332) hands a script a
  string instead once a result carries `structuredContent`, and its `describeTool` shows no
  `outputSchema`, so the tools declare none. Each description ends with the result's TypeScript type
  instead (`Returns: { markId: string }`), rendered from the same schema the pi extension declares.
- A failure comes back as an MCP error whose text starts with the SDK error tag, such as
  `RexSessionNotFound: …`; in a script the call throws with that message.
