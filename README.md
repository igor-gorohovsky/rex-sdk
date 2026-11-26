# rex-sdk

Effect-native TypeScript SDK for the [Rex](https://www.superlogical.com/rex/docs) server API.

Every Rex method is a typed `Effect`. Arguments and results are checked with Effect Schema
codecs generated from the server's own JSON Schemas. Live events and terminal output are
`Stream`s, and connections are owned by `Scope`. One `RexSdk` service groups the namespaces and
shares one control connection.

```ts
import { Effect } from "effect";
import { RexSdk, rexLayout, rexSdkLayer } from "rex-sdk";

const program = Effect.gen(function* () {
  const rex = yield* RexSdk;
  const session = yield* rex.sessions.create({
    label: "my-project",
    initialWindows: [{ windowLabel: "Code", layout: rexLayout.terminal({ cwd: "/src/app" }) }],
  });
  const [blockId] = session.initialWindows[0]?.blockIds ?? [];
  if (blockId === undefined) return;
  const target = { sessionId: session.sessionId, blockId };
  yield* rex.terminals.writeLine(target, "ls");
  return yield* rex.terminals.read(target, { trim: true });
});

await Effect.runPromise(program.pipe(Effect.provide(rexSdkLayer)));
```

See [examples/project-workspace.ts](examples/project-workspace.ts) for a fuller example.

## Compatibility

- Rex API revision **18** only. The SDK checks the revision in the handshake and fails with
  `RexUnsupportedApiRevision` on any other.
- Verified against Rex `0.1.0-preview.21`.
- Node.js 22.18 or newer; `effect` 4.1.

## Rex terms

| You might say       | Rex says       | SDK namespace                 |
| ------------------- | -------------- | ----------------------------- |
| Workspace           | Session        | `rex.sessions`                |
| Tab                 | Window         | `rex.windows`                 |
| Pane, terminal      | Block          | `rex.blocks`, `rex.terminals` |
| Floating pane       | Floating layer | `rex.layers`                  |
| Rex.app on a device | Client         | `rex.clients`                 |

## Namespaces

| Namespace   | Highlights                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server`    | `status`, `version`, `whoami`, `reloadConfig`, `stop`, `tailscale.*`, `apple.*`                                                                                                            |
| `sessions`  | `list`, `create` (with typed layouts), `destroy`, `view`, `watchView`, `attach`, `bootstrap`                                                                                               |
| `windows`   | `create`, `close`, `focus`, `focusNext`, `move`, `setLabel`                                                                                                                                |
| `blocks`    | `split`, `splitBeside`, `move`, `swap`, `zoom`, `float`, `focus*`, `resize`, `close`, `sendEvent`, `callMethod`                                                                            |
| `layers`    | `create`, `close`, `raise`, `lower`, `resize`, `setState` (minimize or restore)                                                                                                            |
| `terminals` | `write`, `writeLine`, `read`, `readTail`, `mark`, `waitForOutput`, `waitForQuiet`, `waitForExit`, `watch`, `activity`, `stream`, `readFile`, `downloadToFile`, `download`, `pasteFiles`, … |
| `tunnels`   | `forwardLocal` (like `ssh -L`), `forwardRemote` (like `ssh -R`), `openStream`, `connections`, `createDial`, `info`                                                                         |
| `clients`   | `list`, `inspect`, `action`, `perform`, `key`, `keymap`, `servePerformRequests`, `serveCallRequests`                                                                                       |
| `events`    | `stream`, `waitFor`                                                                                                                                                                        |
| `targets`   | `resolve`, `complete`                                                                                                                                                                      |
| `hosts`     | `list`, `put`, `remove`                                                                                                                                                                    |
| `creators`  | `list`                                                                                                                                                                                     |

Every operation's arguments are the documented method's arguments in camelCase, so
`rex api describe <method>` documents them too.

## Waiting on terminal output

The waits are built from small parts you can use on their own:

| Part                                                 | What it is                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `terminals.activity`                                 | A signal: `Ready`, then `Output` byte counts and `Exited`. One data connection per block, shared.          |
| `terminals.readTail`                                 | The end of the output as lines with byte offsets, from one snapshot, without reading the whole scrollback. |
| `terminals.mark` + `linesSinceRexMark`               | A place in the output; later text tells which of its lines came after it, and how sure it is.              |
| `findRexOutputMatch`                                 | A pure query: a substring or regex, over all lines, the last `lines`, or lines `since` a mark.             |
| `terminals.watch`                                    | Text at the start, after each burst of output, and after the exit; no reads while the terminal is quiet.   |
| `terminals.waitForOutput` / `terminals.waitForQuiet` | `watch` + a query until it matches / `activity` until nothing is written for a while.                      |

```ts
const mark = yield * rex.terminals.mark(target);
yield * rex.terminals.writeLine(target, "pnpm test");
const match =
  yield *
  rex.terminals.waitForOutput(
    target,
    { pattern: /(\d+) (passed|failed)/, since: mark },
    { timeout: "2 minutes" },
  );
```

With `since`, earlier output and the typed command line never match. `match.alignment` says how
the mark was found: `offset` and `anchor` are exact; `unaligned` means the output was cleared or
more than the read window arrived after the mark, so every line in the window counted.

Rex allows one data connection per client and block, so `activity`, `watch`, and the waits share
one, but `terminals.stream` opens its own: don't stream a block you also wait on.

## Configuration

`rexSdkLayer` reads `REX_SERVER`, or uses the default personal-server socket for the platform.
`rexSdkLayerFromOptions` takes explicit options:

```ts
rexSdkLayerFromOptions({
  server: "/run/rex/server.sock",
  client: { kind: "agent", name: "my-tool", version: "1.0.0" },
  requestTimeout: "30 seconds",
});
```

Inside a Rex terminal, `REX_SESSION` and `REX_BLOCK` are available as
`rex.config.ambient.sessionId` and `.blockId`. The SDK never uses them unless you pass them.

## Errors

Each failure is a tagged error, so you can recover with `Effect.catchTag`:

- **Server codes**: `RexBadRequest`, `RexNotFound`, `RexSessionNotFound`, `RexMethodNotFound`,
  `RexConflict`, `RexNotSupported`, `RexRefused`, `RexClientUnavailable`, `RexTooLarge`,
  `RexRevisionTooLow`, `RexServerTimeout`, and `RexServerError` for any other code.
- **Local**: `RexInvalidInput` (arguments rejected before sending), `RexConfigurationError`.
- **Connection**: `RexConnectionError`, `RexHandshakeError`, `RexUnsupportedApiRevision`,
  `RexConnectionClosed`, `RexConnectionLost`, `RexRequestTimeout`, and `RexMessageTooLarge`.
  `RexConnectionLost` means the request may have run. The SDK never resends it; check the state
  first.
- **Streams**: `RexEventsLost`, `RexDataRejected`, `RexBlockClosed`, `RexDataStreamFailed`.
- **Contract**: `RexInvalidResponse`, when the server's answer doesn't match API revision 18.

## MCP server

The [`mcp/`](mcp/README.md) directory serves this SDK to agents as an MCP server: one tool per
SDK operation (`terminals_writeLine`, `sessions_view`, …), for Claude Code, pi, and any other MCP
client. One process can serve every agent on a machine:

```sh
node mcp/http.ts --port 7317
claude mcp add -s user --transport http rex http://127.0.0.1:7317/mcp -H 'X-Rex-Block: ${REX_BLOCK:-}'
pi mcp add rex --url http://127.0.0.1:7317/mcp --header 'X-Rex-Block=!printf %s "${REX_BLOCK:-none}"'
```

## Development

```sh
vp install
vp run ready        # generated-code drift, vp check, vp test, vp pack
vp run test:live    # optional: against your Rex server, in a session it creates and destroys
```

See [AGENTS.md](AGENTS.md) and [docs/architecture.md](docs/architecture.md).
