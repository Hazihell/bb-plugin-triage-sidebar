/**
 * How the sidebar keeps its copy of the lifecycle store in step with the
 * server's, as pure functions both sides share.
 *
 * The server numbers every change it publishes and hands the same counter out
 * with a full read. A client applies a change only when it is the next one it
 * expects; anything else — a gap, a message from a server that restarted since
 * — means its copy can no longer be trusted, and it reads the whole table
 * again. Deltas are the common path; the full read is the recovery, never the
 * routine.
 *
 * No server or node imports here: the frontend bundles this module.
 */
import type { ThreadLifecycleRow } from "./lifecycle";

/** Channel the lifecycle store publishes on. */
export const LIFECYCLE_CHANNEL = "lifecycle";

/** One thread's row changed; `row` is null when the row was deleted. */
export interface LifecycleRowMessage {
  kind: "row";
  /** Which server run numbered this change; a restart starts a new one. */
  epoch: string;
  seq: number;
  threadId: string;
  row: ThreadLifecycleRow | null;
}

/** The mirror of the server's reap report, as the client reads it. */
export interface ReapedSummary {
  enabled: boolean;
  terminalsClosed: Array<{ terminalId: string; title: string }>;
  terminalsFailed: number;
  processesKilled: Array<{ pid: number; command: string }>;
  processesFailed: number;
  worktreesSkipped: Array<{ path: string; reason: "in-use" | "unreachable" }>;
}

/** What a settle's reap did, published once it finished. */
export interface LifecycleReapedMessage {
  kind: "reaped";
  threadId: string;
  reaped: ReapedSummary;
}

export type LifecycleMessage = LifecycleRowMessage | LifecycleReapedMessage;

/**
 * Read a realtime payload as a lifecycle message, or null for anything else.
 * The channel carries JSON from another process; nothing is trusted by type.
 */
export function parseLifecycleMessage(payload: unknown): LifecycleMessage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const message = payload as Record<string, unknown>;
  if (typeof message.threadId !== "string") return null;
  if (
    message.kind === "row" &&
    typeof message.epoch === "string" &&
    typeof message.seq === "number" &&
    (message.row === null || typeof message.row === "object")
  ) {
    return message as unknown as LifecycleRowMessage;
  }
  if (
    message.kind === "reaped" &&
    typeof message.reaped === "object" &&
    message.reaped !== null
  ) {
    return message as unknown as LifecycleReapedMessage;
  }
  return null;
}

export interface LifecycleSnapshot {
  epoch: string;
  seq: number;
  rows: readonly ThreadLifecycleRow[];
}

export interface SyncState {
  epoch: string;
  seq: number;
  rows: ReadonlyMap<string, ThreadLifecycleRow>;
}

export function stateFromSnapshot(snapshot: LifecycleSnapshot): SyncState {
  return {
    epoch: snapshot.epoch,
    seq: snapshot.seq,
    rows: new Map(snapshot.rows.map((row) => [row.threadId, row])),
  };
}

function withRow(
  rows: ReadonlyMap<string, ThreadLifecycleRow>,
  threadId: string,
  row: ThreadLifecycleRow | null,
): ReadonlyMap<string, ThreadLifecycleRow> {
  const next = new Map(rows);
  if (row === null) next.delete(threadId);
  else next.set(threadId, row);
  return next;
}

/**
 * Apply one change to a synced copy.
 *
 * An old change — one the snapshot already contains — is dropped. The next
 * change is applied. A change past the next one, or from another epoch, is
 * applied too (it is still the newest word on that thread) but marks the copy
 * stale, and the caller reads the whole table to find what it missed.
 */
export function applyRowMessage(
  state: SyncState,
  message: LifecycleRowMessage,
): { state: SyncState; stale: boolean } {
  if (message.epoch !== state.epoch) {
    return {
      state: { ...state, rows: withRow(state.rows, message.threadId, message.row) },
      stale: true,
    };
  }
  if (message.seq <= state.seq) return { state, stale: false };
  return {
    state: {
      epoch: state.epoch,
      seq: message.seq,
      rows: withRow(state.rows, message.threadId, message.row),
    },
    stale: message.seq !== state.seq + 1,
  };
}

/**
 * A snapshot plus the changes that arrived while it was being read.
 *
 * A change can overtake the read that should have contained it; applying the
 * buffered ones on top, in order, and dropping those the snapshot already
 * covers, gives the same table the server has.
 */
export function stateFromSnapshotAndBuffer(
  snapshot: LifecycleSnapshot,
  buffered: readonly LifecycleRowMessage[],
): { state: SyncState; stale: boolean } {
  let state = stateFromSnapshot(snapshot);
  let stale = false;
  for (const message of [...buffered].sort((a, b) => a.seq - b.seq)) {
    // A buffered change from an older epoch predates this snapshot entirely.
    if (message.epoch !== snapshot.epoch) continue;
    const applied = applyRowMessage(state, message);
    state = applied.state;
    stale ||= applied.stale;
  }
  return { state, stale };
}

/**
 * Put a predicted row — or take one back — without moving the counter. Only
 * the server numbers changes; a prediction is replaced by the real row when
 * its message arrives.
 */
export function withPredictedRow(
  state: SyncState,
  threadId: string,
  row: ThreadLifecycleRow | null,
): SyncState {
  return { ...state, rows: withRow(state.rows, threadId, row) };
}

/** An empty row for a thread the store has never seen. */
export function blankRow(threadId: string): ThreadLifecycleRow {
  return {
    threadId,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    startedWorkingAt: null,
    lastRunEndedAt: null,
  };
}

export type ParkingChange =
  | { kind: "settle"; at: number }
  | { kind: "snooze"; at: number; until: number }
  | { kind: "unpark" };

/**
 * The row a parking change will produce, predicted on the client so the shelf
 * moves the moment the user acts. The same rule the server writes by: a settle
 * clears any snooze, a snooze clears any settle, un-parking clears both, and
 * bb's timing columns are never touched.
 */
export function predictParkingRow(
  current: ThreadLifecycleRow | undefined,
  threadId: string,
  change: ParkingChange,
): ThreadLifecycleRow {
  const base = current ?? blankRow(threadId);
  switch (change.kind) {
    case "settle":
      return { ...base, settledAt: change.at, snoozedUntil: null, snoozedAt: null };
    case "snooze":
      return {
        ...base,
        settledAt: null,
        snoozedUntil: change.until,
        snoozedAt: change.at,
      };
    case "unpark":
      return { ...base, settledAt: null, snoozedUntil: null, snoozedAt: null };
  }
}

/** Whether two rows say the same thing, column by column. */
export function sameRow(
  a: ThreadLifecycleRow | undefined,
  b: ThreadLifecycleRow | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.threadId === b.threadId &&
    a.settledAt === b.settledAt &&
    a.snoozedUntil === b.snoozedUntil &&
    a.snoozedAt === b.snoozedAt &&
    a.startedWorkingAt === b.startedWorkingAt &&
    a.lastRunEndedAt === b.lastRunEndedAt
  );
}

/**
 * One line for a toast about what a reap did, or null when there is nothing
 * the user needs to hear. Stopping a dev server is a visible act; so is
 * leaving one running that the user expected stopped.
 */
export function describeReap(reaped: ReapedSummary): {
  tone: "info" | "warning";
  title: string;
  description: string | null;
} | null {
  const stopped = reaped.processesKilled.length + reaped.terminalsClosed.length;
  const skipped = reaped.worktreesSkipped;
  const failed = reaped.processesFailed + reaped.terminalsFailed;
  if (stopped === 0 && skipped.length === 0 && failed === 0) return null;

  const names = [
    ...reaped.terminalsClosed.map((terminal) => terminal.title),
    ...reaped.processesKilled.map((process) => process.command),
  ];
  const notes = [
    ...skipped.map((worktree) =>
      worktree.reason === "in-use"
        ? `Left running in ${worktree.path}: another thread is mid-turn there.`
        : `Nothing stopped in ${worktree.path}: its machine could not be reached.`,
    ),
    ...(failed > 0 ? [`${failed} could not be stopped; see the plugin log.`] : []),
  ];
  const title =
    stopped > 0
      ? `Stopped ${stopped} leftover ${stopped === 1 ? "process" : "processes"}`
      : "Left processes running";
  const description = [...names, ...notes].join("\n");
  return {
    tone: skipped.length > 0 || failed > 0 ? "warning" : "info",
    title,
    description: description === "" ? null : description,
  };
}
