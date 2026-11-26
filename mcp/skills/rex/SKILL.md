---
name: rex
description: Drive Rex (sessions, tabs, panes, terminals) through the rex MCP tools, not the rex CLI. Find a tool, learn where the agent runs with here, run a command in a terminal and wait for its output, and read results and errors.
---

# Rex tools

Terms: a session is a workspace, a window is a tab, a block is a pane (a terminal is a block), a layer is a floating pane, a client is a Rex app or tool. Tool names mirror rex-sdk, `<sdkNamespace>_<method>`, such as `terminals_writeLine`.

## Find tools

Search for "rex <words>" (`searchTools` in a script), then read a tool's parameters with `describeTool`. The client puts a prefix before each name (`mcp__rex__terminals_writeLine`), so take the full name from the search. Each description ends with what the tool returns (`Returns:` a TypeScript type). Search, describe, and call in one script; return only what you need.

## Where you are

`here()` returns `{ sessionId, blockId }`, the session and terminal block this agent runs in (null outside Rex). Nothing defaults to them: pass IDs explicitly.

## Recipes

- Loop: `sessions_view({ sessionId })` → pick IDs → write → wait → read.
- Run a command: `blocks_splitBeside({ sessionId, anchorId: blockId, placement: "right" })` for a fresh terminal (its `blockIds`), then `const { markId } = terminals_writeLine({ sessionId, blockId, text: "pnpm test" })`, then `terminals_waitForOutput({ sessionId, blockId, since: markId, match: { type: "regex", value: "passed|failed" }, timeoutMs: 120000 })`. With `since`, only what the command prints counts, not earlier output or the typed command line. Then `terminals_readTail({ sessionId, blockId })` for context. For output with no line to match, use `terminals_waitForQuiet({ sessionId, blockId, quietForMs: 2000, timeoutMs })`.
- Run a program to completion: create the block with layout `{ _tag: "Terminal", options: { command: ["pnpm", "test"], cwd } }`, then `terminals_waitForExit`.
- New places: `windows_create({ sessionId, layout })` for a tab, `sessions_create({ label, initialWindows })` for a workspace; both return `blockIds`.

## Parameters, waits, and deadlines

- Parameters: one flat object. SDK positional arguments become fields (`sessionId`, `blockId`, …) and the SDK input object's fields sit beside them. An unknown field is an error.
- Waits (`terminals_waitForOutput`, `terminals_waitForQuiet`, `terminals_waitForExit`, `events_waitFor`) require `timeoutMs` and resolve to `{ timedOut: true }` when it passes, or `{ timedOut: false, match | quiet | exit | event }` on success. `terminals_waitForOutput` fails with `RexTerminalExited` if the program exits without a match. Check `timedOut` before reading the value.
- Deadlines: `requestTimeoutMs` bounds each request a call makes (default 10000 ms).

## Results and failures

- Results: the SDK's value as camelCase JSON text; absent values and void results are null. Claude Code hands a script the parsed value. pi hands it the MCP result: `JSON.parse(result.content[0].text)`.
- Failures: an MCP error result whose text starts with the SDK error tag. Claude Code throws it (`error.message`); pi returns it with `isError: true`. Tags: `RexNotFound`, `RexSessionNotFound`, `RexBadRequest`, `RexConflict`, `RexRefused`, `RexServerError` (the server rejected the request), `RexInvalidInput` or `SchemaError` (bad arguments, nothing sent), `RexRequestTimeout`, `RexConnectionLost` (the outcome is uncertain: inspect state before retrying), `RexConnectionError` (no Rex server), `RexBlockClosed` (the block closed during a wait), `RexUnknownMark` (a markId this server does not know: another block's, or from before a restart), `RexDataRejected` (a terminal's output stream was refused), `RexUnknownTool` (no tool has that name).

## Limits

- Destructive tools carry `destructiveHint`: closes, `sessions_destroy`, `terminals_clear` and `terminals_reset`, `server_stop`, tailscale disable and logout, `hosts_remove`.
- Not tools: streams (terminal output, session views, events, tunnel connections), port forwards, byte streams, request handlers.
