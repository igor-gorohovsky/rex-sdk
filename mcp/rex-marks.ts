/**
 * Marks handed to agents by ID.
 *
 * A mark (`RexTerminalMark`) holds anchor lines a script has no use for, so tools return a short
 * `markId` and keep the mark here. One store serves every client of the process: IDs are random,
 * so no client can name another's mark, and the newest marks are kept.
 */
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { RexBlockTarget, RexTerminalMark } from "../src/index.ts";

/** How many marks the store keeps before forgetting the oldest. */
const MAX_MARKS = 1024;

/** A markId the script passed is unknown, expired, or belongs to another block. */
export class RexUnknownMark extends Error {
  readonly _tag = "RexUnknownMark";

  constructor(markId: string, reason: string) {
    super(`mark ${markId} ${reason}; make a new one with terminals_mark or terminals_writeLine`);
    this.name = "RexUnknownMark";
  }
}

interface StoredMark {
  readonly sessionId: string;
  readonly blockId: string;
  readonly mark: RexTerminalMark;
}

/** The marks handed out by this process. */
export class RexMarkStore {
  readonly #marks = new Map<string, StoredMark>();

  /** Keeps `mark` for `target` and returns its ID. */
  put(target: RexBlockTarget, mark: RexTerminalMark): string {
    const markId = `mark-${randomUUID()}`;
    this.#marks.set(markId, {
      sessionId: target.sessionId,
      blockId: target.blockId,
      // A line sliced from a terminal's text can share memory with the whole text; a copy keeps
      // only the line alive.
      mark: { ...mark, anchor: mark.anchor.map((line) => Buffer.from(line).toString()) },
    });
    for (const oldest of this.#marks.keys()) {
      if (this.#marks.size <= MAX_MARKS) break;
      this.#marks.delete(oldest);
    }
    return markId;
  }

  /** The mark with `markId`, which must belong to `target`. */
  get(markId: string, target: RexBlockTarget): Effect.Effect<RexTerminalMark, RexUnknownMark> {
    const stored = this.#marks.get(markId);
    if (stored === undefined) {
      return Effect.fail(new RexUnknownMark(markId, "is unknown or expired"));
    }
    if (stored.sessionId !== target.sessionId || stored.blockId !== target.blockId) {
      return Effect.fail(new RexUnknownMark(markId, `belongs to block ${stored.blockId}`));
    }
    return Effect.succeed(stored.mark);
  }
}
