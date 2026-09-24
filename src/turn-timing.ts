/**
 * When a thread's turns start and end, read out of bb's own event log.
 *
 * The idle age on a card is how the owner judges what is left of the agent's
 * prompt-cache window, so it has to be the instant the last turn ended — not
 * when this plugin happened to hear about it, and not bb's `updatedAt`, which
 * moves on a rename, a pin or a read. bb writes a `turn/completed` row for
 * every turn that ends, whether it completed, failed or was interrupted, in
 * the same millisecond as the turn's last API response. That row's
 * `createdAt` is the answer; a live run's start is the newest `turn/started`.
 *
 * The log is the source of truth and the plugin's store only caches it. A
 * cache that missed events — the plugin was reloaded, reinstalled or simply
 * not running — is corrected by reading the log again, never by guessing.
 */

export type TurnEventType = "turn/started" | "turn/completed";

/** The fields of one event row this module reads. */
export interface TurnEventRow {
  seq: number;
  createdAt: number;
  type: string;
}

/** The slice of `bb.sdk.threads.events` this module needs. */
export interface TurnEventLog {
  list(args: {
    threadId: string;
    types: readonly [TurnEventType, ...TurnEventType[]];
    order: "desc";
    limit: string;
  }): Promise<readonly TurnEventRow[]>;
  wait(args: {
    threadId: string;
    type: TurnEventType;
    afterSeq: string;
    waitMs: string;
  }): Promise<TurnEventRow | null>;
}

export interface TurnTiming {
  /** When the turn in flight started; null when none is. */
  startedWorkingAt: number | null;
  /** When the newest turn ended; null when no turn ever has. */
  lastRunEndedAt: number | null;
}

/** The newest `turn/started` and `turn/completed` rows in a thread's log. */
export interface NewestTurnRows {
  started: TurnEventRow | null;
  completed: TurnEventRow | null;
}

/**
 * How long a status event waits for the log row that explains it.
 *
 * bb announces `thread.active` and `thread.idle` from the status change, and
 * the row that carries the turn's own timestamp can land a moment either side
 * of it. Waiting on the log is what keeps the stored time the turn's rather
 * than the event's.
 */
export const TURN_ROW_WAIT_MS = 15_000;

/**
 * Whether a thread's status says a turn may be in flight. A turn/started row
 * with no completion after it is only a live run when the thread agrees: an
 * idle or failed thread with such a row lost its turn without a record of the
 * end, and a timer counting up from it would count forever.
 */
export function isRunningStatus(status: string): boolean {
  return status !== "idle" && status !== "error" && status !== "pending";
}

/**
 * The timing a pair of newest rows describes. Pure, so every rule about which
 * row wins is tested from plain values.
 *
 * Rows are ordered by `seq`, not by `createdAt`: two rows written in the same
 * millisecond still have a definite order in the log, and a turn that starts
 * in the same millisecond the previous one ended is still a new turn.
 */
export function timingFromRows(
  rows: NewestTurnRows,
  running: boolean,
): TurnTiming {
  const { started, completed } = rows;
  const inFlight =
    started !== null && (completed === null || started.seq > completed.seq);
  return {
    startedWorkingAt: running && inFlight ? started.createdAt : null,
    lastRunEndedAt: completed?.createdAt ?? null,
  };
}

/**
 * The newest turn/started and turn/completed rows, in one read when it can.
 *
 * The newest two rows of either type almost always hold one of each: turns
 * alternate. Only a turn that started and never recorded an end leaves two
 * starts on top, and then the completion is asked for on its own.
 */
export async function readNewestTurnRows(
  log: TurnEventLog,
  threadId: string,
): Promise<NewestTurnRows> {
  const rows = await log.list({
    threadId,
    types: ["turn/started", "turn/completed"],
    order: "desc",
    limit: "2",
  });
  let started: TurnEventRow | null = null;
  let completed: TurnEventRow | null = null;
  for (const row of rows) {
    if (row.type === "turn/started" && started === null) started = row;
    if (row.type === "turn/completed" && completed === null) completed = row;
  }
  if (completed === null && rows.length >= 2) {
    const [newest] = await log.list({
      threadId,
      types: ["turn/completed"],
      order: "desc",
      limit: "1",
    });
    completed = newest ?? null;
  }
  return { started, completed };
}

/** Timing for a thread in whatever state its log shows now. */
export async function readTurnTiming(
  log: TurnEventLog,
  threadId: string,
  running: boolean,
): Promise<TurnTiming> {
  return timingFromRows(await readNewestTurnRows(log, threadId), running);
}

/**
 * Timing for a thread bb has just reported as started.
 *
 * When the log does not yet show a turn in flight, its start row has not
 * landed; this waits for it rather than stamping the event's own arrival.
 * A start that never lands leaves the start unknown — no timer is better than
 * one counting from the wrong moment.
 */
export async function readStartedTiming(
  log: TurnEventLog,
  threadId: string,
  waitMs = TURN_ROW_WAIT_MS,
): Promise<TurnTiming> {
  const rows = await readNewestTurnRows(log, threadId);
  const timing = timingFromRows(rows, true);
  if (timing.startedWorkingAt !== null) return timing;
  const afterSeq = Math.max(rows.started?.seq ?? 0, rows.completed?.seq ?? 0);
  const next = await log.wait({
    threadId,
    type: "turn/started",
    afterSeq: String(afterSeq),
    waitMs: String(waitMs),
  });
  return {
    startedWorkingAt: next?.createdAt ?? null,
    lastRunEndedAt: timing.lastRunEndedAt,
  };
}

/**
 * Timing for a thread bb has just reported as stopped — idle or failed.
 *
 * When the newest start has no completion after it yet, the completion row is
 * still on its way, and the newest completion in the log belongs to the turn
 * before. Using it would make the idle age a whole turn too old, so this waits
 * for the real one. If it never arrives the previous end stands: it is the
 * newest end the log can prove.
 */
export async function readStoppedTiming(
  log: TurnEventLog,
  threadId: string,
  waitMs = TURN_ROW_WAIT_MS,
): Promise<TurnTiming> {
  const rows = await readNewestTurnRows(log, threadId);
  const { started, completed } = rows;
  const pending =
    started !== null && (completed === null || started.seq > completed.seq);
  if (!pending) return timingFromRows(rows, false);
  const next = await log.wait({
    threadId,
    type: "turn/completed",
    afterSeq: String(started.seq),
    waitMs: String(waitMs),
  });
  return {
    startedWorkingAt: null,
    lastRunEndedAt: next?.createdAt ?? completed?.createdAt ?? null,
  };
}

/**
 * Run `task` over `items` with at most `limit` in flight. The startup backfill
 * reads one log per thread, and a user with hundreds of threads must not open
 * hundreds of requests at once.
 */
export async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await task(item as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}
