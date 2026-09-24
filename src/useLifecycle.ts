import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { triageSidebarRpcContract } from "./server";
import { childrenOf } from "./inbox";
import {
  applyRowMessage,
  describeReap,
  LIFECYCLE_CHANNEL,
  parseLifecycleMessage,
  predictParkingRow,
  sameRow,
  stateFromSnapshotAndBuffer,
  withPredictedRow,
  type LifecycleRowMessage,
  type LifecycleSnapshot,
  type ParkingChange,
  type SyncState,
} from "./lifecycle-sync";
import {
  canPark,
  nextWakeDelayMs,
  resolveShelf,
  type ThreadLifecycleRow,
  type ThreadShelf,
} from "./lifecycle";

/**
 * The thread's OWN live work, which blocks parking and wakes a parked thread.
 *
 * Its own, and only its own: a card's spinner-and-timer is about the run this
 * thread is accruing, and a parent has no clock for a child's. Everything that
 * asks "is anything happening here" wants {@link busyThreadIds} instead.
 */
export function isWorking(thread: PluginSidebarThread): boolean {
  const { activity } = thread;
  return (
    activity.workflows > 0 ||
    activity.backgroundAgents > 0 ||
    activity.backgroundCommands > 0 ||
    activity.planMode > 0 ||
    activity.goals > 0 ||
    thread.indicator === "runtime"
  );
}

/**
 * The threads that have work in flight, their children's included.
 *
 * A parent whose subagents are running carries nothing in its own record to
 * say so, and would read as idle: parkable, sortable to the bottom, and
 * archivable by the sweep. Folding a child's work into the parent is what
 * makes the flat list honest about a tree it deliberately does not show.
 *
 * Direct children only. A grandchild's work already marks its own parent
 * busy, and that parent is a child of this one, so depth arrives on its own
 * for any tree the sidebar can see.
 *
 * One pass over the list rather than a lookup per card: the sort asks this of
 * every row, and `childrenOf` is a scan.
 */
export function busyThreadIds(
  threads: readonly PluginSidebarThread[],
): ReadonlySet<string> {
  const busy = new Set<string>();
  for (const thread of threads) {
    if (!isWorking(thread)) continue;
    busy.add(thread.id);
    if (thread.parentThreadId !== null) busy.add(thread.parentThreadId);
  }
  return busy;
}

/** Whether one thread is busy, for a caller that has no list to scan. */
export function isBusy(
  thread: PluginSidebarThread,
  threads: readonly PluginSidebarThread[],
): boolean {
  return isWorking(thread) || childrenOf(threads, thread.id).some(isWorking);
}

export type LifecycleLoadStatus = "loading" | "ready" | "error";

export interface LifecycleApi {
  /**
   * Whether the plugin's own store has been read. Until it has, every thread
   * classifies as active and has no idle age; on "error", `retry` reads again.
   */
  status: LifecycleLoadStatus;
  retry(): void;
  shelfFor(thread: PluginSidebarThread): ThreadShelf;
  canPark(thread: PluginSidebarThread): boolean;
  wakeAtFor(thread: PluginSidebarThread): number | null;
  /**
   * When the turn in flight started, as bb's event log recorded it, or null
   * when no turn is running.
   */
  startedWorkingAtFor(threadId: string): number | null;
  /**
   * When the thread's newest turn ended, as bb's event log recorded it, or
   * null when no turn ever has. There is no fallback: any other clock would
   * misstate what is left of the prompt-cache window.
   */
  lastRunEndedAtFor(threadId: string): number | null;
  /** Live work on the thread or on any of its direct children. */
  isBusy(thread: PluginSidebarThread): boolean;
  /**
   * Parking changes apply at once and are confirmed by the server. One that
   * fails is taken back and the user is told; none of these ever throws.
   */
  settle(threadId: string): void;
  unsettle(threadId: string): void;
  snooze(threadId: string, snoozedUntil: number): void;
  unsnooze(threadId: string): void;
}

/** How long a settle waits for its reap report before it stops listening. */
const REAP_REPORT_WINDOW_MS = 2 * 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps a copy of the plugin's lifecycle store and classifies threads onto
 * shelves.
 *
 * The copy is read whole once, then kept current by the numbered row messages
 * the server publishes for every change (see lifecycle-sync.ts). It is read
 * whole again only to recover: a missed message, a restarted server, or a
 * realtime connection that dropped and came back.
 *
 * `now` is state, not a render-time clock read: a snooze that elapses must
 * move its row without waiting for an unrelated re-render, and re-reading the
 * clock during render would make the classification unstable.
 */
export function useLifecycle(
  threads: readonly PluginSidebarThread[],
): LifecycleApi {
  const rpc = useRpc<typeof triageSidebarRpcContract>();
  const [sync, setSync] = useState<SyncState | null>(null);
  const [status, setStatus] = useState<LifecycleLoadStatus>("loading");
  const [now, setNow] = useState(() => Date.now());

  // The copy lives in a ref as well as in state: a realtime message has to
  // know synchronously whether it left the copy stale, and a state updater
  // runs too late to say.
  const syncRef = useRef<SyncState | null>(null);
  const commit = useCallback((next: SyncState) => {
    syncRef.current = next;
    setSync(next);
  }, []);

  // Non-null while a full read is in flight: messages that arrive meanwhile
  // wait here and are applied on top of the snapshot.
  const buffer = useRef<LifecycleRowMessage[] | null>(null);
  // Only the newest read may write; an older one can land after it.
  const readSeq = useRef(0);

  const resync = useCallback(async (): Promise<void> => {
    const id = ++readSeq.current;
    buffer.current ??= [];
    let snapshot: LifecycleSnapshot;
    try {
      snapshot = await rpc.call("listLifecycle", {});
    } catch (error) {
      if (id !== readSeq.current) return;
      buffer.current = null;
      setStatus("error");
      toast.error("Couldn't load the triage sidebar", {
        description: errorMessage(error),
        action: { label: "Retry", onClick: () => void resync() },
      });
      return;
    }
    if (id !== readSeq.current) return;
    const buffered = buffer.current ?? [];
    buffer.current = null;
    const { state, stale } = stateFromSnapshotAndBuffer(snapshot, buffered);
    commit(state);
    setStatus("ready");
    // A gap among the buffered messages: one was lost in flight.
    if (stale) void resync();
  }, [commit, rpc]);

  useEffect(() => {
    void resync();
  }, [resync]);

  // Threads this client settled, whose reap report it is waiting for. The
  // report is broadcast to every open window; only the one where the user
  // acted should speak up about it.
  const awaitingReap = useRef(new Map<string, number>());

  useRealtime(LIFECYCLE_CHANNEL, (payload) => {
    const message = parseLifecycleMessage(payload);
    if (message === null) return;
    if (message.kind === "reaped") {
      const since = awaitingReap.current.get(message.threadId);
      if (since === undefined) return;
      awaitingReap.current.delete(message.threadId);
      if (Date.now() - since > REAP_REPORT_WINDOW_MS) return;
      const report = describeReap(message.reaped);
      if (report === null) return;
      const show = report.tone === "warning" ? toast.warning : toast;
      show(report.title, { description: report.description ?? undefined });
      return;
    }
    if (buffer.current !== null) {
      buffer.current.push(message);
      return;
    }
    const current = syncRef.current;
    // Never loaded: the retry will read everything this message says.
    if (current === null) return;
    const { state, stale } = applyRowMessage(current, message);
    commit(state);
    if (stale) void resync();
  });

  // Messages sent while the connection was down are gone for good, so a
  // reconnect reads the whole table. The first connection is not a reconnect.
  const connection = useRealtimeConnectionState();
  const wasDisconnected = useRef(false);
  useEffect(() => {
    if (connection === "reconnecting") {
      wasDisconnected.current = true;
      return;
    }
    if (connection === "connected" && wasDisconnected.current) {
      wasDisconnected.current = false;
      void resync();
    }
  }, [connection, resync]);

  const rows = sync?.rows ?? EMPTY_ROWS;

  // Arm one timer for the soonest wake instead of polling: the shelf empties
  // the moment a snooze expires, and nothing ticks while nothing is snoozed.
  useEffect(() => {
    // Read a fresh clock here rather than trusting `now`: `now` is only
    // updated when a timer fires, so arming from it after a long idle period
    // would schedule a new snooze far too late.
    const armedAt = Date.now();
    const delay = nextWakeDelayMs(
      [...rows.values()].flatMap((row) =>
        row.snoozedUntil === null ? [] : [row.snoozedUntil],
      ),
      armedAt,
    );
    if (delay === null) return;
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [now, rows]);

  return useMemo<LifecycleApi>(() => {
    const busy = busyThreadIds(threads);
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const signalsFor = (thread: PluginSidebarThread) => ({
      hasPendingInteraction: thread.hasPendingInteraction,
      // Busy, not the thread's own work: a parent whose children are running
      // may not be parked, and the shelves must agree with the card.
      isWorking: busy.has(thread.id),
      isUnread: thread.isUnread,
      latestAttentionAt: thread.latestAttentionAt,
    });

    /**
     * When a predicted parking change says it happened. Never before the
     * thread's own latest attention: the shelf rule reads attention after a
     * park as the thread speaking up, and a browser clock a little behind
     * bb's would bounce the row straight back until the server's answer came.
     */
    const parkedAt = (threadId: string) =>
      Math.max(Date.now(), (byId.get(threadId)?.latestAttentionAt ?? 0) + 1);

    const mutate = (
      threadId: string,
      change: ParkingChange,
      send: () => Promise<unknown>,
      failure: string,
    ) => {
      const current = syncRef.current;
      const before = current?.rows.get(threadId);
      const predicted = predictParkingRow(before, threadId, change);
      if (current !== null) commit(withPredictedRow(current, threadId, predicted));
      send().catch((error: unknown) => {
        const latest = syncRef.current;
        // Take the prediction back only if nothing has replaced it since —
        // a server message about this thread is newer than the guess.
        if (latest !== null && sameRow(latest.rows.get(threadId), predicted)) {
          commit(withPredictedRow(latest, threadId, before ?? null));
        }
        awaitingReap.current.delete(threadId);
        toast.error(failure, { description: errorMessage(error) });
      });
    };

    return {
      status,
      retry: () => void resync(),
      shelfFor: (thread) =>
        resolveShelf(rows.get(thread.id), signalsFor(thread), now),
      canPark: (thread) => canPark(signalsFor(thread)),
      wakeAtFor: (thread) => rows.get(thread.id)?.snoozedUntil ?? null,
      // `?? null` rather than a bare read: a row written before this column
      // existed carries no value, and the caller wants "not running", not
      // `undefined`.
      startedWorkingAtFor: (threadId) =>
        rows.get(threadId)?.startedWorkingAt ?? null,
      lastRunEndedAtFor: (threadId) =>
        rows.get(threadId)?.lastRunEndedAt ?? null,
      isBusy: (thread) => busy.has(thread.id),
      settle: (threadId) => {
        awaitingReap.current.set(threadId, Date.now());
        mutate(
          threadId,
          { kind: "settle", at: parkedAt(threadId) },
          () => rpc.call("settle", { threadId }),
          "Couldn't settle the thread",
        );
      },
      unsettle: (threadId) =>
        mutate(
          threadId,
          { kind: "unpark" },
          () => rpc.call("unsettle", { threadId }),
          "Couldn't move the thread back to the inbox",
        ),
      snooze: (threadId, snoozedUntil) =>
        mutate(
          threadId,
          { kind: "snooze", at: parkedAt(threadId), until: snoozedUntil },
          () => rpc.call("snooze", { threadId, snoozedUntil }),
          "Couldn't snooze the thread",
        ),
      unsnooze: (threadId) =>
        mutate(
          threadId,
          { kind: "unpark" },
          () => rpc.call("unsnooze", { threadId }),
          "Couldn't wake the thread",
        ),
    };
  }, [commit, now, resync, rows, rpc, status, threads]);
}

const EMPTY_ROWS: ReadonlyMap<string, ThreadLifecycleRow> = new Map();
