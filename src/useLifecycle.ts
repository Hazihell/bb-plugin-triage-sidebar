import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { triageSidebarRpcContract } from "./server";
import { childrenOf } from "./inbox";
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

export interface LifecycleApi {
  shelfFor(thread: PluginSidebarThread): ThreadShelf;
  canPark(thread: PluginSidebarThread): boolean;
  wakeAtFor(thread: PluginSidebarThread): number | null;
  /**
   * When the thread's current run started, as bb recorded it, or null when it
   * is not running or the store has never seen it run.
   */
  startedWorkingAtFor(threadId: string): number | null;
  /**
   * When the thread's own last run ended, or null when this plugin has never
   * seen one end. The caller falls back to bb's `updatedAt`.
   */
  lastRunEndedAtFor(threadId: string): number | null;
  /** Live work on the thread or on any of its direct children. */
  isBusy(thread: PluginSidebarThread): boolean;
  settle(threadId: string): void;
  unsettle(threadId: string): void;
  snooze(threadId: string, snoozedUntil: number): void;
  unsnooze(threadId: string): void;
}

/**
 * Reads the plugin's own lifecycle store and classifies threads onto shelves.
 *
 * `now` is state, not a render-time clock read: a snooze that elapses must
 * move its row without waiting for an unrelated re-render, and re-reading the
 * clock during render would make the classification unstable.
 */
export function useLifecycle(
  threads: readonly PluginSidebarThread[],
): LifecycleApi {
  const rpc = useRpc<typeof triageSidebarRpcContract>();
  const [rows, setRows] = useState<ReadonlyMap<string, ThreadLifecycleRow>>(
    () => new Map(),
  );
  const [now, setNow] = useState(() => Date.now());

  // Responses can land out of order (a mutation's refresh racing a realtime
  // one), and an older list would silently restore state the user just
  // changed. Only the newest request may write.
  const requestSeq = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    const result = await rpc.call("listLifecycle", {});
    if (seq !== requestSeq.current) return;
    setRows(new Map(result.rows.map((row) => [row.threadId, row])));
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtime("lifecycle", () => {
    void refresh();
  });

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
    const signalsFor = (thread: PluginSidebarThread) => ({
      hasPendingInteraction: thread.hasPendingInteraction,
      // Busy, not the thread's own work: a parent whose children are running
      // may not be parked, and the shelves must agree with the card.
      isWorking: busy.has(thread.id),
      isUnread: thread.isUnread,
      latestAttentionAt: thread.latestAttentionAt,
    });
    // One read per mutation: the write publishes on the realtime channel, and
    // that subscription already triggers a refresh for every client.
    const mutate = async (
      method: "settle" | "unsettle" | "unsnooze",
      threadId: string,
    ) => {
      await rpc.call(method, { threadId });
    };
    return {
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
      settle: (threadId) => void mutate("settle", threadId),
      unsettle: (threadId) => void mutate("unsettle", threadId),
      unsnooze: (threadId) => void mutate("unsnooze", threadId),
      snooze: (threadId, snoozedUntil) => {
        void rpc.call("snooze", { threadId, snoozedUntil });
      },
    };
  }, [now, refresh, rows, rpc, threads]);
}
