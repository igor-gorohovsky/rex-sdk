/**
 * Runs Rex tools on one lazily built SDK runtime and turns each exit into an MCP tool result: the
 * value as JSON text, or an `isError` result whose text starts with the SDK error tag.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { Cause, Duration, Effect, Exit, Layer, ManagedRuntime, Option, Schema } from "effect";
import { RexSdk } from "../src/index.ts";
import type { RexTool, RexToolContext } from "./rex-tools.ts";
import { encodeRexToolResult, REX_REQUEST_TIMEOUT_FIELD } from "./rex-tool-schemas.ts";

/** Owns one SDK runtime, built on first use; rebuilt after `dispose()` or a configuration failure. */
export class RexToolRuntime {
  #runtime: ManagedRuntime.ManagedRuntime<RexSdk, unknown> | undefined;
  readonly #makeLayer: () => Layer.Layer<RexSdk, unknown>;

  constructor(makeLayer: () => Layer.Layer<RexSdk, unknown>) {
    this.#makeLayer = makeLayer;
  }

  /** Runs `tool` with flat `params` and returns what the client receives. */
  async call(
    tool: RexTool,
    params: { readonly [key: string]: unknown },
    context: RexToolContext,
    signal: AbortSignal | undefined,
  ): Promise<CallToolResult> {
    this.#runtime ??= ManagedRuntime.make(this.#makeLayer());
    const exit = await this.#runtime.runPromiseExit(
      runTool(tool, params, context),
      signal === undefined ? undefined : { signal },
    );
    if (Exit.isSuccess(exit)) return convertToTextResult(exit.value);
    const failure = describeFailure(exit.cause);
    // A configuration failure is cached by the runtime's Layer; rebuild it on the next call.
    if (failure.tag === "RexConfigurationError") await this.dispose();
    return convertToErrorResult(`${failure.tag}: ${failure.message}`);
  }

  async dispose(): Promise<void> {
    const runtime = this.#runtime;
    this.#runtime = undefined;
    await runtime?.dispose();
  }
}

/** A tool result holding `value` as JSON text, which code-mode scripts receive parsed. */
function convertToTextResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** A failed tool result; `message` starts with the error tag. */
export function convertToErrorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * The field every tool takes beside its own, which no tool's schema decodes: absent, or a positive
 * number of milliseconds, since the SDK times out every request at once for zero or less.
 */
const decodeRequestTimeout = Schema.decodeUnknownEffect(
  Schema.Struct({
    [REX_REQUEST_TIMEOUT_FIELD]: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
  }),
);

/** Decodes flat tool parameters and runs one tool, resolving to the JSON the client receives. */
function runTool(
  tool: RexTool,
  params: { readonly [key: string]: unknown },
  context: RexToolContext,
): Effect.Effect<unknown, unknown, RexSdk> {
  return Effect.gen(function* () {
    const { [REX_REQUEST_TIMEOUT_FIELD]: _requestTimeoutMs, ...rest } = params;
    const { [REX_REQUEST_TIMEOUT_FIELD]: requestTimeoutMs } = yield* decodeRequestTimeout(params);
    const options =
      requestTimeoutMs === undefined ? {} : { timeout: Duration.millis(requestTimeoutMs) };
    const rex = yield* RexSdk;
    const result = yield* tool.program(rex, rest, options, context);
    return encodeRexToolResult(result);
  });
}

/** The tag and message of a failed exit: the typed error's, an interruption, or a defect. */
function describeFailure(cause: Cause.Cause<unknown>): {
  readonly tag: string;
  readonly message: string;
} {
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error)) return describeError(error.value);
  if (Cause.hasInterruptsOnly(cause))
    return { tag: "Interrupted", message: "the Rex call was aborted" };
  return { tag: "Defect", message: Cause.pretty(cause) };
}

function describeError(error: unknown): { readonly tag: string; readonly message: string } {
  if (typeof error !== "object" || error === null) return { tag: "Error", message: String(error) };
  const tag =
    "_tag" in error && typeof error._tag === "string"
      ? error._tag
      : error instanceof Error
        ? error.name
        : "Error";
  const message =
    "message" in error && typeof error.message === "string" ? error.message : JSON.stringify(error);
  return { tag: tag || "Error", message };
}
