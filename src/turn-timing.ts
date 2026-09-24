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

/** The rows that say who started a turn. */
export type TurnOriginEventType =
  | "turn/started"
  | "turn/input/accepted"
  | "item/backgroundTask/completed";

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
    types: readonly [
      TurnEventType | TurnOriginEventType,
      ...(TurnEventType | TurnOriginEventType)[],
    ];
    order: "desc";
    limit: string;
    signal?: AbortSignal;
  }): Promise<readonly TurnEventRow[]>;
  wait(args: {
    threadId: string;
    type: TurnEventType;
    afterSeq: string;
    waitMs: string;
    signal?: AbortSignal;
  }): Promise<TurnEventRow | null>;
}

export interface TurnTiming {
  /** When the turn in flight started; null when none is. */
  startedWorkingAt: number | null;
  /** When the newest turn ended; null when no turn ever has. */
  lastRunEndedAt: number | null;
  /**
   * The sequence of the newest turn/started row known to belong to a turn
   * that has stopped, or null when this read learned nothing new about it.
   *
   * A turn can stop without writing its completion. Its start row then sits
   * on top of the log looking like a turn in flight, and the next turn's own
   * start may land a moment after bb announces it. Remembering which start
   * already stopped is what keeps a timer from counting from hours ago.
   */
  endedStartSeq: number | null;
}

/** The newest `turn/started` and `turn/completed` rows in a thread's log. */
export interface NewestTurnRows {
  started: TurnEventRow | null;
  completed: TurnEventRow | null;
}

export interface ReadOptions {
  /** The newest start row already known to have stopped, if any. */
  endedStartSeq?: number | null;
  waitMs?: number;
  signal?: AbortSignal;
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
 * Whether the newest start row is a turn still in flight: newer than the
 * newest completion, and newer than any start already known to have stopped.
 * Rows are ordered by `seq`, not by `createdAt`: two rows written in the same
 * millisecond still have a definite order in the log.
 */
export function isStartInFlight(
  rows: NewestTurnRows,
  endedStartSeq: number | null = null,
): boolean {
  const { started, completed } = rows;
  if (started === null) return false;
  return started.seq > Math.max(completed?.seq ?? -1, endedStartSeq ?? -1);
}

/**
 * The timing a pair of newest rows describes. Pure, so every rule about which
 * row wins is tested from plain values.
 */
export function timingFromRows(
  rows: NewestTurnRows,
  running: boolean,
  endedStartSeq: number | null = null,
): TurnTiming {
  const { started, completed } = rows;
  const inFlight = isStartInFlight(rows, endedStartSeq);
  return {
    startedWorkingAt: running && inFlight && started ? started.createdAt : null,
    lastRunEndedAt: completed?.createdAt ?? null,
    // Not running: whatever start is newest has stopped.
    endedStartSeq: !running && started !== null ? started.seq : null,
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
  signal?: AbortSignal,
): Promise<NewestTurnRows> {
  const rows = await log.list({
    threadId,
    types: ["turn/started", "turn/completed"],
    order: "desc",
    limit: "2",
    signal,
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
      signal,
    });
    completed = newest ?? null;
  }
  return { started, completed };
}

/**
 * Timing for a thread read without an event to go on — the startup backfill,
 * an unarchive. The thread's status is asked for only when the log shows a
 * turn in flight, and asked at that moment: a status read before the log was
 * could say "running" about a turn the log has since finished.
 */
export async function readTurnTiming(
  log: TurnEventLog,
  threadId: string,
  readStatus: () => Promise<string>,
  options: ReadOptions = {},
): Promise<TurnTiming> {
  const endedStartSeq = options.endedStartSeq ?? null;
  const rows = await readNewestTurnRows(log, threadId, options.signal);
  const running = isStartInFlight(rows, endedStartSeq)
    ? isRunningStatus(await readStatus())
    : false;
  return timingFromRows(rows, running, endedStartSeq);
}

/**
 * Timing for a thread bb has just reported as started.
 *
 * When the log does not yet show a turn in flight — no start newer than the
 * last completion and the last start known to have stopped — the new start
 * row has not landed; this waits for it rather than stamping the event's own
 * arrival. A start that never lands leaves the start unknown: no timer is
 * better than one counting from the wrong moment.
 */
export async function readStartedTiming(
  log: TurnEventLog,
  threadId: string,
  options: ReadOptions = {},
): Promise<TurnTiming> {
  const endedStartSeq = options.endedStartSeq ?? null;
  const rows = await readNewestTurnRows(log, threadId, options.signal);
  const timing = timingFromRows(rows, true, endedStartSeq);
  if (timing.startedWorkingAt !== null) return timing;
  const afterSeq = Math.max(
    rows.started?.seq ?? 0,
    rows.completed?.seq ?? 0,
    endedStartSeq ?? 0,
  );
  const next = await log.wait({
    threadId,
    type: "turn/started",
    afterSeq: String(afterSeq),
    waitMs: String(options.waitMs ?? TURN_ROW_WAIT_MS),
    signal: options.signal,
  });
  return {
    startedWorkingAt: next?.createdAt ?? null,
    lastRunEndedAt: timing.lastRunEndedAt,
    endedStartSeq: null,
  };
}

/**
 * Timing for a thread bb has just reported as stopped — idle or failed.
 *
 * When the newest start has no completion after it yet, the completion row is
 * still on its way, and the newest completion in the log belongs to the turn
 * before. Using it would make the idle age a whole turn too old, so this waits
 * for the real one. If it never arrives the previous end stands: it is the
 * newest end the log can prove. Either way the start has now stopped.
 */
export async function readStoppedTiming(
  log: TurnEventLog,
  threadId: string,
  options: ReadOptions = {},
): Promise<TurnTiming> {
  const rows = await readNewestTurnRows(log, threadId, options.signal);
  const { started, completed } = rows;
  if (started === null || !isStartInFlight(rows, options.endedStartSeq ?? null)) {
    return timingFromRows(rows, false);
  }
  const next = await log.wait({
    threadId,
    type: "turn/completed",
    afterSeq: String(started.seq),
    waitMs: String(options.waitMs ?? TURN_ROW_WAIT_MS),
    signal: options.signal,
  });
  return {
    startedWorkingAt: null,
    lastRunEndedAt: next?.createdAt ?? completed?.createdAt ?? null,
    endedStartSeq: started.seq,
  };
}

/**
 * When the background task ended whose end made the agent start the thread's
 * newest turn by itself; null when bb started that turn with input.
 *
 * bb logs `turn/input/accepted` right after the start of every turn it asks
 * for — a user's message, a queued one, a child's report to its parent. A
 * turn the provider starts on its own has none. Claude Code starts one when a
 * background command it launched exits. Only a start that directly follows a
 * background task's end counts; any other turn with no input is left alone.
 */
export async function backgroundWakeTaskEnd(
  log: TurnEventLog,
  threadId: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const rows = await log.list({
    threadId,
    types: ["turn/started", "turn/input/accepted", "item/backgroundTask/completed"],
    order: "desc",
    limit: "4",
    signal,
  });
  return backgroundWakeFromRows(rows);
}

/** The rule {@link backgroundWakeTaskEnd} applies, over rows newest first. */
export function backgroundWakeFromRows(
  rows: readonly TurnEventRow[],
): number | null {
  const start = rows.findIndex((row) => row.type === "turn/started");
  if (start === -1) return null;
  if (rows.slice(0, start).some((row) => row.type === "turn/input/accepted")) {
    return null;
  }
  const trigger = rows[start + 1];
  return trigger?.type === "item/backgroundTask/completed" ? trigger.createdAt : null;
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
