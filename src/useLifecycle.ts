import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { triageSidebarRpcContract } from "./server";
import { createSnapshotStore } from "./local-snapshot";
import { LIFECYCLE_SNAPSHOT } from "./snapshot-schemas";
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

/** bb's execution states in which the agent is inside a turn. */
const TURN_STATUSES: ReadonlySet<string> = new Set([
  "starting",
  "active",
  "stopping",
]);

/**
 * Whether the thread's agent is inside a turn right now: the one state in
 * which the card counts a run's elapsed time instead of an idle age.
 *
 * bb's execution status decides it, and nothing else. Not the "runtime"
 * indicator: bb rolls a running child up into its parent's indicator, so a
 * parent idle for an hour reads "runtime" while its subagent works, and would
 * lose its idle age to a timer it has no start for. Background work does NOT
 * count either: a
 * dev server in a background terminal, a workflow, plan mode or a goal can
 * outlive every turn, and a thread running one is still idle as far as the
 * prompt cache is concerned. "stopping" does count, because the turn has not
 * ended until bb logs its end, and the age before that would be the previous
 * turn's.
 */
export function isTurnRunning(thread: PluginSidebarThread): boolean {
  return TURN_STATUSES.has(thread.status);
}

/**
 * Any live work on the thread itself: a turn, or anything running in the
 * background. This, not {@link isTurnRunning}, lifts the thread into the
 * sort's working tier and draws the working pencil.
 *
 * Its own, and only its own. Everything that asks "is anything happening here,
 * children included" wants {@link busyThreadIds} instead.
 */
export function isWorking(thread: PluginSidebarThread): boolean {
  return blocksParking(thread) || thread.activity.backgroundCommands > 0;
}

/**
 * The live work on the thread itself that parking must not hide: everything
 * {@link isWorking} counts except background commands. This is what blocks
 * parking and wakes a parked thread.
 *
 * A background command is left out because it is usually a dev server or a
 * watcher the agent left running after its turn — exactly what settling's
 * cleanup exists to stop. The card still shows its terminal glyph.
 *
 * Read from the thread's own activity counts, never from bb's indicator: bb
 * rolls a child's work up into its parent's "runtime" indicator, and a child's
 * background command must not block the parent that way. A child's other work
 * reaches the parent through {@link busyThreadIds}.
 */
export function blocksParking(thread: PluginSidebarThread): boolean {
  const { activity } = thread;
  return (
    isTurnRunning(thread) ||
    activity.workflows > 0 ||
    activity.backgroundAgents > 0 ||
    activity.planMode > 0 ||
    activity.goals > 0
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
 * Every ancestor, not just the parent: a grandchild working under a quiet
 * child must keep the grandparent off the shelves too, even when the quiet
 * child is itself hidden or archived. The walk keeps a visited set, so a
 * malformed parent chain cannot loop.
 *
 * One pass over the list rather than a lookup per card: the sort asks this of
 * every row. `isLive` says what counts as work: {@link isWorking} for the
 * sort, {@link blocksParking} for the shelves.
 */
export function busyThreadIds(
  threads: readonly PluginSidebarThread[],
  isLive: (thread: PluginSidebarThread) => boolean = isWorking,
): ReadonlySet<string> {
  const parentOf = new Map(
    threads.map((thread) => [thread.id, thread.parentThreadId]),
  );
  const busy = new Set<string>();
  for (const thread of threads) {
    if (!isLive(thread)) continue;
    let id: string | null | undefined = thread.id;
    while (id != null && !busy.has(id)) {
      busy.add(id);
      id = parentOf.get(id);
    }
  }
  return busy;
}

export type LifecycleLoadStatus = "loading" | "ready" | "error";

/**
 * Where the rows on screen came from: nowhere yet, the snapshot this client
 * kept from its last session, or the server.
 */
export type LifecycleSource = "none" | "snapshot" | "live";

export interface LifecycleApi {
  /**
   * Whether the plugin's own store has been read. Until it has, every thread
   * classifies as active and has no idle age; on "error", `retry` reads again.
   */
  status: LifecycleLoadStatus;
  /**
   * "snapshot" means the rows are last session's, painted so the first frame
   * is the real list; the server's replace them as soon as they arrive.
   */
  source: LifecycleSource;
  /** Why the last read failed, while `status` is "error"; null otherwise. */
  error: string | null;
  /** Read the store again; `status` is "loading" until it answers. */
  retry(): void;
  shelfFor(thread: PluginSidebarThread): ThreadShelf;
  canPark(thread: PluginSidebarThread): boolean;
  wakeAtFor(thread: PluginSidebarThread): number | null;
  /**
   * When the turn in flight started, or null when no turn is running.
   *
   * bb's event log says, once the server has read it. Until then — the
   * moment between bb marking a thread active and the server pushing the
   * logged start — it is when this client first saw the turn running, so
   * the clock counts from the start rather than going blank. The logged time
   * is never later, so when it lands the timer only steps forward.
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
  const [seed] = useState(readLifecycleSnapshot);
  // What the next snapshot write may keep: rows of threads the host lists and
  // has not archived. Read when the write happens, so it is always current.
  const listedThreads = useRef(threads);
  listedThreads.current = threads;
  const [sync, setSync] = useState<SyncState | null>(seed);
  const [status, setStatus] = useState<LifecycleLoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<LifecycleSource>(
    seed === null ? "none" : "snapshot",
  );
  const [now, setNow] = useState(() => Date.now());

  // The copy lives in a ref as well as in state: a realtime message has to
  // know synchronously whether it left the copy stale, and a state updater
  // runs too late to say.
  const syncRef = useRef<SyncState | null>(seed);
  const commit = useCallback((next: SyncState) => {
    syncRef.current = next;
    setSync(next);
    lifecycleSnapshot.schedule(() =>
      rowsWorthSaving(syncRef.current, listedThreads.current),
    );
  }, []);

  // Non-null while a full read is in flight: messages that arrive meanwhile
  // wait here and are applied on top of the snapshot.
  const buffer = useRef<LifecycleRowMessage[] | null>(null);
  // Only the newest read may write; an older one can land after it.
  const readSeq = useRef(0);
  // The last full read failed. A gap in the messages then waits for the
  // user's Retry or a reconnect instead of firing another read that will
  // most likely fail the same way.
  const readFailed = useRef(false);

  const resync = useCallback(async (): Promise<void> => {
    const id = ++readSeq.current;
    buffer.current ??= [];
    let snapshot: LifecycleSnapshot;
    try {
      snapshot = await rpc.call("listLifecycle", {});
    } catch (failure) {
      if (id !== readSeq.current) return;
      buffer.current = null;
      // Shown by the list itself, with a Retry, rather than toasted: a toast
      // fades while the list goes on being wrong.
      readFailed.current = true;
      setError(errorMessage(failure));
      setStatus("error");
      return;
    }
    if (id !== readSeq.current) return;
    const buffered = buffer.current ?? [];
    buffer.current = null;
    const { state, stale } = stateFromSnapshotAndBuffer(snapshot, buffered);
    commit(state);
    readFailed.current = false;
    setError(null);
    setStatus("ready");
    setSource("live");
    // A gap among the buffered messages: one was lost in flight.
    if (stale && !readFailed.current) void resync();
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
    if (stale && !readFailed.current) void resync();
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

  // When this client first saw each thread's turn running. Kept across
  // renders and pruned when the turn ends; read only while the server has no
  // logged start for it.
  const firstSeenRunning = useRef(new Map<string, number>());
  const seenRunning = firstSeenRunning.current;
  const running = new Set<string>();
  for (const thread of threads) {
    if (!isTurnRunning(thread)) continue;
    running.add(thread.id);
    if (!seenRunning.has(thread.id)) seenRunning.set(thread.id, Date.now());
  }
  for (const id of seenRunning.keys()) if (!running.has(id)) seenRunning.delete(id);

  return useMemo<LifecycleApi>(() => {
    const busy = busyThreadIds(threads);
    const parkingBlocked = busyThreadIds(threads, blocksParking);
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const signalsFor = (thread: PluginSidebarThread) => ({
      hasPendingInteraction: thread.hasPendingInteraction,
      // Folded, not the thread's own work: a parent whose children are
      // running may not be parked, and the shelves must agree with the card.
      blocksParking: parkingBlocked.has(thread.id),
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
      source,
      error,
      retry: () => {
        setStatus("loading");
        void resync();
      },
      shelfFor: (thread) =>
        resolveShelf(rows.get(thread.id), signalsFor(thread), now),
      canPark: (thread) => canPark(signalsFor(thread)),
      wakeAtFor: (thread) => rows.get(thread.id)?.snoozedUntil ?? null,
      startedWorkingAtFor: (threadId) =>
        rows.get(threadId)?.startedWorkingAt ??
        seenRunning.get(threadId) ??
        null,
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
  }, [commit, error, now, resync, rows, rpc, source, status, threads]);
}

const EMPTY_ROWS: ReadonlyMap<string, ThreadLifecycleRow> = new Map();

const lifecycleSnapshot = createSnapshotStore<ThreadLifecycleRow>(
  "lifecycle",
  LIFECYCLE_SNAPSHOT,
);

/**
 * Enough rows to paint a long sidebar. The store also holds rows for every
 * thread ever archived, which the first frame never draws.
 */
const MAX_SNAPSHOT_ROWS = 500;

/**
 * The rows the next launch's first frame can use: those of threads the host
 * lists and has not archived, the most recently active first, up to the cap.
 * Null — skip the write — until both the store and the host's threads have
 * arrived, so a half-loaded moment never overwrites a good snapshot.
 */
function rowsWorthSaving(
  state: SyncState | null,
  threads: readonly PluginSidebarThread[],
): ThreadLifecycleRow[] | null {
  if (state === null || threads.length === 0) return null;
  const listed = threads
    .filter((thread) => !thread.isArchived)
    .sort((left, right) => right.latestAttentionAt - left.latestAttentionAt);
  const rows: ThreadLifecycleRow[] = [];
  for (const thread of listed) {
    const row = state.rows.get(thread.id);
    if (row === undefined) continue;
    rows.push(row);
    if (rows.length === MAX_SNAPSHOT_ROWS) break;
  }
  return rows;
}

/**
 * Last session's rows, as a state the list can paint. A turn start saved then
 * belongs to a turn that has ended or been superseded, so it is dropped; the
 * client's own sighting stands in until the server answers. The counter is
 * the server's to hand out, so a snapshot carries none: any message that
 * arrives before the first read is buffered behind it anyway.
 */
function readLifecycleSnapshot(): SyncState | null {
  const rows = lifecycleSnapshot.read();
  if (rows === null) return null;
  return {
    epoch: "",
    seq: 0,
    rows: new Map(
      rows.map((row) => [row.threadId, { ...row, startedWorkingAt: null }]),
    ),
  };
}
