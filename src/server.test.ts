import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type CreateFakePluginHostOptions,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin, {
  isAllowedAvatarDataUrl,
  localSourcePath,
  MAX_AVATAR_BYTES,
  parseAutoArchiveDays,
  parseAutoArchiveIntervalHours,
  parseCacheWindow,
  nextAutoArchiveRunAt,
  BACKFILL_DELAY_MS,
  type AutoArchiveSweepResult,
  type ReapSummary,
  type StoredAvatarRow,
  type StoredLifecycleRow,
} from "./server";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The plugin loaded against the fake host, so these tests exercise the real
 * registrations — migrations, events, schedule — rather than a copy of them.
 */
function load(options: CreateFakePluginHostOptions = {}): FakePluginHost {
  const host = createFakePluginHost({ pluginId: "triage-sidebar", ...options });
  plugin(host.bb);
  return host;
}

const listRows = async (host: FakePluginHost): Promise<StoredLifecycleRow[]> =>
  ((await host.harness.behavior.callRpc("listLifecycle", {})) as {
    rows: StoredLifecycleRow[];
  }).rows;

/**
 * Lets work the plugin started without awaiting — a settle's reap, an event
 * handler waiting on the fake log — run to its next real wait. The fakes
 * answer synchronously, so one macrotask drains every promise they queued.
 */
const flushTasks = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A thread that has been settled long enough for any sane retention period. */
async function settleLongAgo(
  host: FakePluginHost,
  threadId: string,
): Promise<void> {
  await host.harness.behavior.callRpc("settle", { threadId });
  // The settle's reap runs after it returns; let it finish so its calls are
  // not mistaken for the sweep's.
  await flushTasks();
  host.bb.storage
    .database()
    .prepare(`UPDATE thread_lifecycle SET settled_at = ? WHERE thread_id = ?`)
    .run(Date.now() - 30 * DAY_MS, threadId);
}

/**
 * Settles a thread, then forgets the SDK calls that settling made.
 *
 * A settle reaps, and a reap reads terminals. Tests that assert a sweep made
 * no calls at all are about the sweep's silence, not the settle's, so the
 * setup's own traffic has to go before the assertion can mean anything.
 */
async function settleLongAgoQuietly(
  host: FakePluginHost,
  threadId: string,
): Promise<void> {
  await settleLongAgo(host, threadId);
  host.harness.inspection.sdk.calls.length = 0;
}

/** Pretends the last sweep happened `ago` milliseconds before now. */
function ageLastSweep(host: FakePluginHost, ago: number): void {
  host.bb.storage
    .database()
    .prepare(`UPDATE plugin_state SET value = ? WHERE key = ?`)
    .run(String(Date.now() - ago), "autoArchiveLastRunAt");
}

describe("parseAutoArchiveDays", () => {
  it("reads a whole number of days", () => {
    expect(parseAutoArchiveDays("14")).toBe(14);
  });

  // The setting is a free-text string, so the sweep must survive a typo
  // without deciding that everything settled is already overdue.
  it("falls back to 7 on anything unusable", () => {
    expect(parseAutoArchiveDays("soon")).toBe(7);
    expect(parseAutoArchiveDays("0")).toBe(7);
    expect(parseAutoArchiveDays("-3")).toBe(7);
    expect(parseAutoArchiveDays("1.5")).toBe(7);
    expect(parseAutoArchiveDays(undefined)).toBe(7);
  });
});

interface LogRow {
  seq: number;
  createdAt: number;
  type: "turn/started" | "turn/completed";
}

/**
 * bb's event log for a few threads, answering `events.list` and `events.wait`
 * the way the server does: newest first by sequence, filtered by type. Rows
 * pushed later are what a wait resolves with, which is how a test plays a row
 * landing a moment after the status event that announced it.
 */
function eventLog(initial: Record<string, LogRow[]> = {}) {
  const rows: Record<string, LogRow[]> = structuredClone(initial);
  const waiters: Array<{
    threadId: string;
    type: string;
    afterSeq: number;
    resolve: (row: LogRow | null) => void;
  }> = [];
  const newest = (threadId: string, types: readonly string[]) =>
    (rows[threadId] ?? [])
      .filter((row) => types.includes(row.type))
      .sort((a, b) => b.seq - a.seq);
  return {
    /** Lands a row; `quietly` leaves open waits waiting until `flush`. */
    push(threadId: string, row: LogRow, quietly = false) {
      (rows[threadId] ??= []).push(row);
      if (!quietly) this.flush();
    },
    /** Every wait still open resolves empty, as a timed-out wait does. */
    timeOut() {
      for (const waiter of waiters.splice(0)) waiter.resolve(null);
    },
    /** Answers every open wait whose row has landed. */
    flush() {
      for (const waiter of [...waiters]) {
        const [row] = newest(waiter.threadId, [waiter.type])
          .filter((candidate) => candidate.seq > waiter.afterSeq)
          .reverse();
        if (row === undefined) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(row);
      }
    },
    sdk: {
      list: (args: {
        threadId: string;
        types?: readonly string[];
        limit?: string;
      }) =>
        newest(args.threadId, args.types ?? []).slice(
          0,
          Number(args.limit ?? "100"),
        ),
      wait: (args: { threadId: string; type: string; afterSeq?: string }) => {
        const afterSeq = Number(args.afterSeq ?? "0");
        const [found] = newest(args.threadId, [args.type])
          .filter((row) => row.seq > afterSeq)
          .reverse();
        if (found !== undefined) return found;
        return new Promise<LogRow | null>((resolve) =>
          waiters.push({ threadId: args.threadId, type: args.type, afterSeq, resolve }),
        );
      },
    },
  };
}


describe("turn timing", () => {
  const T = 1_790_000_000_000;

  it("stores the start of the turn in flight from the log", async () => {
    const log = eventLog({
      thr_run: [
        { seq: 1, createdAt: T, type: "turn/started" },
        { seq: 2, createdAt: T + 5_000, type: "turn/completed" },
        { seq: 3, createdAt: T + 60_000, type: "turn/started" },
      ],
    });
    const host = load({ sdk: { threads: { events: log.sdk } } });
    await host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_run", status: "active" }),
    });
    await flushTasks();

    const [row] = await listRows(host);
    expect(row?.startedWorkingAt).toBe(T + 60_000);
    expect(row?.lastRunEndedAt).toBe(T + 5_000);
    // The sidebar only re-reads on the channel, so a silent write would leave
    // the elapsed label missing until something unrelated refreshed.
    expect(
      host.harness.inspection.realtimeSignals.some(
        (signal) => signal.channel === "lifecycle",
      ),
    ).toBe(true);
  });

  // The regression the owner cares about: the idle age is the instant the
  // turn's last response landed, not when this plugin heard about it.
  it("stores the end as the log's turn/completed time, not the event's", async () => {
    const log = eventLog({
      thr_run: [
        { seq: 1, createdAt: T, type: "turn/started" },
        { seq: 9, createdAt: T + 42_123, type: "turn/completed" },
      ],
    });
    const host = load({ sdk: { threads: { events: log.sdk } } });
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_run", status: "idle" }),
      lastAssistantText: null,
    });
    await flushTasks();

    const [row] = await listRows(host);
    expect(row?.startedWorkingAt).toBeNull();
    expect(row?.lastRunEndedAt).toBe(T + 42_123);
  });

  // bb can announce the idle status a moment before the completion row is in
  // the log. The newest completion then belongs to the turn BEFORE, and using
  // it would make the age a whole turn too old.
  it("waits for the completion row when the idle event arrives first", async () => {
    const log = eventLog({
      thr_run: [
        { seq: 1, createdAt: T, type: "turn/completed" },
        { seq: 2, createdAt: T + 10_000, type: "turn/started" },
      ],
    });
    const host = load({ sdk: { threads: { events: log.sdk } } });
    const handled = host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_run", status: "idle" }),
      lastAssistantText: null,
    });
    await flushTasks();
    expect(await listRows(host)).toEqual([]);

    log.push("thr_run", { seq: 3, createdAt: T + 20_000, type: "turn/completed" });
    await handled;

    expect((await listRows(host))[0]?.lastRunEndedAt).toBe(T + 20_000);
  });

  it("waits for the start row when the active event arrives first", async () => {
    const log = eventLog({
      thr_run: [{ seq: 1, createdAt: T, type: "turn/completed" }],
    });
    const host = load({ sdk: { threads: { events: log.sdk } } });
    const handled = host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_run", status: "active" }),
    });
    await flushTasks();
    expect(await listRows(host)).toEqual([]);

    log.push("thr_run", { seq: 2, createdAt: T + 7_000, type: "turn/started" });
    await handled;

    expect((await listRows(host))[0]?.startedWorkingAt).toBe(T + 7_000);
  });

  // A start still waiting for its row must not overwrite the turn's end, which
  // a later event already recorded.
  it("lets a later event win over a slower read", async () => {
    const log = eventLog({
      thr_run: [{ seq: 1, createdAt: T, type: "turn/completed" }],
    });
    const host = load({ sdk: { threads: { events: log.sdk } } });
    const started = host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_run", status: "active" }),
    });
    await flushTasks();
    // The turn was so short that it started and ended before the start's
    // wait returned, and the idle event was handled first.
    log.push("thr_run", { seq: 2, createdAt: T + 1_000, type: "turn/started" }, true);
    log.push("thr_run", { seq: 3, createdAt: T + 2_000, type: "turn/completed" }, true);
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_run", status: "idle" }),
      lastAssistantText: null,
    });
    log.flush();
    await started;

    const [row] = await listRows(host);
    expect(row?.startedWorkingAt).toBeNull();
    expect(row?.lastRunEndedAt).toBe(T + 2_000);
  });

  // A failed turn still writes turn/completed (status "failed"), so it starts
  // the idle clock the same way.
  it("records the end when a run fails", async () => {
    const log = eventLog({
      thr_boom: [
        { seq: 1, createdAt: T, type: "turn/started" },
        { seq: 2, createdAt: T + 3_000, type: "turn/completed" },
      ],
    });
    const host = load({ sdk: { threads: { events: log.sdk } } });
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "thr_boom", status: "error" }),
      error: "boom",
    });
    await flushTasks();

    expect((await listRows(host))[0]?.lastRunEndedAt).toBe(T + 3_000);
  });

  // An unreadable log leaves the cache as it was: the last value the log
  // confirmed beats any guess, and the next event reads again.
  it("keeps the cached value when the log cannot be read", async () => {
    const host = load({
      sdk: {
        threads: {
          events: {
            list: () => {
              throw new Error("no log");
            },
          },
        },
      },
    });
    host.bb.storage
      .database()
      .prepare(
        `INSERT INTO thread_lifecycle (thread_id, last_run_ended_at) VALUES (?, ?)`,
      )
      .run("thr_x", T);
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_x", status: "idle" }),
      lastAssistantText: null,
    });
    await flushTasks();

    expect((await listRows(host))[0]?.lastRunEndedAt).toBe(T);
  });

  // A row written before the column existed reads as "never ran here" rather
  // than breaking the read, and parking it keeps working.
  it("reads a row that predates the column", async () => {
    const host = load();
    host.bb.storage
      .database()
      .prepare(
        `INSERT INTO thread_lifecycle (thread_id, settled_at) VALUES (?, ?)`,
      )
      .run("thr_old_schema", Date.now());

    const [row] = await listRows(host);
    expect(row?.threadId).toBe("thr_old_schema");
    expect(row?.lastRunEndedAt).toBeNull();
  });

  // Parking rewrites the row, and must carry bb's columns through untouched.
  it("keeps the end time across a settle", async () => {
    const log = eventLog({
      thr_park: [{ seq: 1, createdAt: T, type: "turn/completed" }],
    });
    const host = load({ sdk: { threads: { events: log.sdk } } });
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_park", status: "idle" }),
      lastAssistantText: null,
    });
    await flushTasks();

    await host.harness.behavior.callRpc("settle", { threadId: "thr_park" });

    expect((await listRows(host))[0]?.lastRunEndedAt).toBe(T);
  });

  it("keeps a parked thread's shelf when its run ends", async () => {
    const log = eventLog({
      thr_parked: [
        { seq: 1, createdAt: T, type: "turn/started" },
        { seq: 2, createdAt: T + 1_000, type: "turn/completed" },
      ],
    });
    const host = load({ sdk: { threads: { events: log.sdk } } });
    await host.harness.behavior.callRpc("settle", { threadId: "thr_parked" });
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "thr_parked", status: "error" }),
      error: "boom",
    });
    await flushTasks();

    const [row] = await listRows(host);
    expect(row?.settledAt).not.toBeNull();
    expect(row?.lastRunEndedAt).toBe(T + 1_000);
  });

  // Events missed while the plugin was not running — a reload, a reinstall —
  // heal on the next load: every live thread's timing is read again, stale
  // values included, and a start left behind by a missed idle is cleared.
  it("backfills every live thread from the log shortly after load", async () => {
    vi.useFakeTimers();
    try {
      const log = eventLog({
        thr_idle: [
          { seq: 1, createdAt: T, type: "turn/started" },
          { seq: 2, createdAt: T + 4_000, type: "turn/completed" },
        ],
        thr_busy: [
          { seq: 1, createdAt: T, type: "turn/completed" },
          { seq: 2, createdAt: T + 8_000, type: "turn/started" },
        ],
        thr_fresh: [],
      });
      const threads = [
        makeThreadResponse({ id: "thr_idle", status: "idle" }),
        makeThreadResponse({ id: "thr_busy", status: "active" }),
        makeThreadResponse({ id: "thr_fresh", status: "idle" }),
      ];
      const host = load({
        sdk: {
          threads: {
            events: log.sdk,
            list: (args) => threads.slice(args?.offset ?? 0),
            // Asked fresh, per thread, only where the log shows a turn open.
            get: ({ threadId }) => threads.find((thread) => thread.id === threadId)!,
          },
        },
      });
      // Stale: an old end, and a start the plugin never saw finish.
      host.bb.storage
        .database()
        .prepare(
          `INSERT INTO thread_lifecycle (thread_id, started_working_at, last_run_ended_at)
             VALUES (?, ?, ?)`,
        )
        .run("thr_idle", T + 1, T - 99_000);

      await vi.advanceTimersByTimeAsync(BACKFILL_DELAY_MS + 10);

      const rows = new Map((await listRows(host)).map((row) => [row.threadId, row]));
      expect(rows.get("thr_idle")).toMatchObject({
        startedWorkingAt: null,
        lastRunEndedAt: T + 4_000,
      });
      expect(rows.get("thr_busy")).toMatchObject({
        startedWorkingAt: T + 8_000,
        lastRunEndedAt: T,
      });
      // Nothing to cache for a thread with no turns, so no row at all.
      expect(rows.has("thr_fresh")).toBe(false);
      expect(host.harness.inspection.sdk.callsTo("threads.list")).toEqual([
        [{ archived: false, includeHidden: true, limit: 200, offset: 0 }],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("turn timing races", () => {
  const T = 1_790_000_000_000;

  // A reload lands mid-turn-end: the idle event's read is waiting for the
  // completion row when the backfill reaches the same thread. The backfill
  // knows less, so it steps aside rather than cancelling the event's read.
  it("lets the backfill yield to an event read already in flight", async () => {
    vi.useFakeTimers();
    try {
      const log = eventLog({
        thr_run: [
          { seq: 1, createdAt: T, type: "turn/completed" },
          { seq: 2, createdAt: T + 1_000, type: "turn/started" },
        ],
      });
      const host = load({
        sdk: {
          threads: {
            events: log.sdk,
            list: () => [makeThreadResponse({ id: "thr_run", status: "active" })],
            get: () => makeThreadResponse({ id: "thr_run", status: "active" }),
          },
        },
      });
      const idle = host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({ id: "thr_run", status: "idle" }),
        lastAssistantText: null,
      });
      await vi.advanceTimersByTimeAsync(BACKFILL_DELAY_MS + 10);

      log.push("thr_run", { seq: 3, createdAt: T + 9_000, type: "turn/completed" });
      await idle;

      expect((await listRows(host))[0]).toMatchObject({
        startedWorkingAt: null,
        lastRunEndedAt: T + 9_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // A turn that stopped without writing its completion leaves its start on
  // top of the log. The next turn's timer must not count from it.
  it("does not count the next turn from a start that already stopped", async () => {
    const log = eventLog({
      thr_run: [
        { seq: 1, createdAt: T, type: "turn/completed" },
        { seq: 2, createdAt: T + 1_000, type: "turn/started" },
      ],
    });
    const host = load({ sdk: { threads: { events: log.sdk } } });
    // The turn fails and its completion never lands; the wait gives up.
    const failed = host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "thr_run", status: "error" }),
      error: "provider crashed",
    });
    await flushTasks();
    log.timeOut();
    await failed;

    // Hours later the user resumes; bb announces the turn before its row.
    const active = host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_run", status: "active" }),
    });
    await flushTasks();
    expect((await listRows(host))[0]?.startedWorkingAt).toBeNull();

    log.push("thr_run", { seq: 5, createdAt: T + 7_200_000, type: "turn/started" });
    await active;
    expect((await listRows(host))[0]?.startedWorkingAt).toBe(T + 7_200_000);
  });

  // Unload must stop the plugin writing and publishing on the old run's
  // behalf, even with a read still waiting for its row.
  it("writes nothing after unload", async () => {
    const log = eventLog({
      thr_run: [{ seq: 1, createdAt: T, type: "turn/completed" }],
    });
    const host = load({ sdk: { threads: { events: log.sdk } } });
    const active = host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_run", status: "active" }),
    });
    await flushTasks();
    const published = host.harness.inspection.realtimeSignals.length;
    await host.harness.lifecycle.dispose();

    log.push("thr_run", { seq: 2, createdAt: T + 1, type: "turn/started" });
    await active.catch(() => {});

    expect(host.harness.inspection.realtimeSignals.length).toBe(published);
  });
});

describe("lifecycle channel", () => {
  const rowMessages = (host: FakePluginHost) =>
    host.harness.inspection.realtimeSignals
      .filter((signal) => signal.channel === "lifecycle")
      .map((signal) => signal.payload as { kind: string; seq: number; threadId: string; row: StoredLifecycleRow | null })
      .filter((payload) => payload.kind === "row");

  // Each change carries the row itself, numbered, so a sidebar applies it
  // instead of re-reading the table.
  it("publishes each change as a numbered row", async () => {
    const host = load();
    await host.harness.behavior.callRpc("snooze", { threadId: "thr_a", snoozedUntil: Date.now() + 60_000 });
    await host.harness.behavior.callRpc("unsnooze", { threadId: "thr_a" });

    const messages = rowMessages(host);
    expect(messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(messages[0]?.row?.snoozedUntil).not.toBeNull();
    // Un-snoozed with nothing else in it, so the row is gone.
    expect(messages[1]?.row).toBeNull();
  });

  it("hands out the counter a full read is current as of", async () => {
    const host = load();
    await host.harness.behavior.callRpc("settle", { threadId: "thr_a" });
    await flushTasks();
    const snapshot = (await host.harness.behavior.callRpc("listLifecycle", {})) as {
      epoch: string;
      seq: number;
    };
    expect(snapshot.seq).toBe(1);
    expect(typeof snapshot.epoch).toBe("string");
  });

  // Un-parking is the user's decision about the shelf; the idle age is bb's
  // and must survive it.
  it("keeps the idle age when a thread is unsettled", async () => {
    const host = load();
    host.bb.storage
      .database()
      .prepare(`INSERT INTO thread_lifecycle (thread_id, last_run_ended_at) VALUES (?, ?)`)
      .run("thr_a", 1234);
    await host.harness.behavior.callRpc("settle", { threadId: "thr_a" });
    await host.harness.behavior.callRpc("unsettle", { threadId: "thr_a" });
    await flushTasks();

    expect(await listRows(host)).toEqual([
      expect.objectContaining({ threadId: "thr_a", settledAt: null, lastRunEndedAt: 1234 }),
    ]);
  });

  // A manual archive, not only the sweep's: a row left behind would park the
  // thread again the moment it came back.
  it("forgets an archived thread and reads its timing back on unarchive", async () => {
    const log = eventLog({
      thr_a: [{ seq: 1, createdAt: 777, type: "turn/completed" }],
    });
    const host = load({ sdk: { threads: { events: log.sdk } } });
    await host.harness.behavior.callRpc("settle", { threadId: "thr_a" });
    await flushTasks();

    await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "thr_a" }),
    });
    expect(await listRows(host)).toEqual([]);

    await host.harness.behavior.emitThreadEvent("thread.unarchived", {
      thread: makeThreadResponse({ id: "thr_a", status: "idle" }),
    });
    expect(await listRows(host)).toEqual([
      expect.objectContaining({ threadId: "thr_a", settledAt: null, lastRunEndedAt: 777 }),
    ]);
  });
});

describe("parseCacheWindow", () => {
  it("reads a pair of whole minutes", () => {
    expect(parseCacheWindow("20", "45")).toEqual({
      warnAfterMinutes: 20,
      coldAfterMinutes: 45,
    });
  });

  // A crossed or unusable pair is a band no thread can be in, which reads
  // exactly like a feature that does not work.
  it("falls back to the defaults on an unusable or crossed pair", () => {
    const defaults = { warnAfterMinutes: 50, coldAfterMinutes: 60 };
    expect(parseCacheWindow("soon", "60")).toEqual(defaults);
    expect(parseCacheWindow("50", "0")).toEqual(defaults);
    expect(parseCacheWindow("60", "50")).toEqual(defaults);
    expect(parseCacheWindow("50", "50")).toEqual(defaults);
    expect(parseCacheWindow(undefined, undefined)).toEqual(defaults);
  });
});

describe("getSettings", () => {
  it("hands the sidebar the cache thresholds", async () => {
    const host = load({
      settings: { cacheWarnAfterMinutes: "10", cacheColdAfterMinutes: "25" },
    });
    expect(await host.harness.behavior.callRpc("getSettings", {})).toEqual({
      cacheWarnAfterMinutes: 10,
      cacheColdAfterMinutes: 25,
    });
  });
});

/**
 * One row of bb's thread list — the shape the sweep and the reap read, with
 * every activity count at zero and no environment unless a test says so.
 */
function listRow(overrides: Record<string, unknown> & { id: string }) {
  return {
    ...makeThreadResponse({ id: overrides.id }),
    hasPendingInteraction: false,
    environmentHostId: null,
    environmentPath: null,
    environmentIsWorktree: null,
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
    ...overrides,
  };
}

type ListRow = ReturnType<typeof listRow>;

/**
 * bb's thread list and archive over a fixed set of rows. The list honours the
 * filters the plugin uses; the archive takes a thread's whole tree, as bb's
 * does, and answers with every id it archived.
 */
function liveThreads(rows: ListRow[]) {
  const treeOf = (id: string): string[] => [
    ...rows
      .filter(
        (row) =>
          row.parentThreadId === id ||
          row.lifecycleOwnerThreadId === id ||
          (row.visibility === "hidden" && row.sourceThreadId === id),
      )
      .flatMap((row) => treeOf(row.id)),
    id,
  ];
  return {
    list: (args?: { environmentId?: string; offset?: number; limit?: number }) => {
      const matching = rows.filter(
        (row) =>
          args?.environmentId === undefined || row.environmentId === args.environmentId,
      );
      const offset = args?.offset ?? 0;
      return matching.slice(offset, offset + (args?.limit ?? matching.length)) as never;
    },
    archive: ({ threadId }: { threadId: string }) => ({
      ok: true as const,
      archivedThreadIds: treeOf(threadId),
    }),
  };
}

/** A host whose bb knows exactly these threads, idle and quiet. */
const sweeping = (...ids: string[]) => ({
  threads: liveThreads(ids.map((id) => listRow({ id }))),
});

describe("auto-archive sweep", () => {
  it("archives a settled thread once it is older than the retention period", async () => {
    const host = load({ sdk: sweeping("thr_old") });
    await settleLongAgo(host, "thr_old");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([
      [{ threadId: "thr_old" }],
    ]);
    // Archived threads have no shelf, and a leftover row would park the
    // thread again the moment it was unarchived.
    expect(await listRows(host)).toEqual([]);
  });

  // bb archives a thread with its whole tree, deepest first, so one call is
  // enough and nothing is released as an orphan root. Rows the descendants
  // carried go with them.
  it("archives a whole subtree in one call and clears its rows", async () => {
    const host = load({
      sdk: {
        threads: liveThreads([
          listRow({ id: "thr_old" }),
          listRow({ id: "thr_child", parentThreadId: "thr_old" }),
          listRow({ id: "thr_grandchild", parentThreadId: "thr_child" }),
        ]),
      },
    });
    await settleLongAgo(host, "thr_old");
    await host.harness.behavior.callRpc("snooze", {
      threadId: "thr_grandchild",
      snoozedUntil: Date.now() + DAY_MS,
    });

    const result = (await host.harness.behavior.callRpc(
      "runAutoArchive",
      {},
    )) as AutoArchiveSweepResult;

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([
      [{ threadId: "thr_old" }],
    ]);
    expect(result.archived.map((thread) => thread.threadId)).toEqual(["thr_old"]);
    expect(await listRows(host)).toEqual([]);
  });

  // The N+1 this replaced: one list read answers every candidate, and nothing
  // is asked per thread except the archive itself.
  it("asks bb nothing per thread but the list and the archive", async () => {
    const host = load({ sdk: sweeping("thr_a", "thr_b", "thr_c") });
    for (const id of ["thr_a", "thr_b", "thr_c"]) await settleLongAgo(host, id);
    host.harness.inspection.sdk.calls.length = 0;

    await host.harness.behavior.callRpc("runAutoArchive", {});

    const paths = host.harness.inspection.sdk.calls.map((call) => call.path);
    // One list to choose, then per archived thread one for its reap and one
    // to judge it again just before the archive. Nothing per thread else.
    expect(paths.filter((path) => path === "threads.list")).toHaveLength(1 + 3 * 2);
    expect(paths.filter((path) => path === "threads.archive")).toHaveLength(3);
    expect(paths.some((path) => path === "threads.get")).toBe(false);
    expect(paths.some((path) => path === "threads.interactions.list")).toBe(false);
  });

  // Guessing without the list would archive threads still in use.
  it("archives nothing and does not count as a sweep when the list cannot be read", async () => {
    const host = load({
      sdk: {
        threads: {
          ...liveThreads([]),
          list: () => {
            throw new Error("bb is unhappy");
          },
        },
      },
    });
    await settleLongAgo(host, "thr_old");

    await expect(host.harness.behavior.callRpc("runAutoArchive", {})).rejects.toThrow();

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    expect(await listRows(host)).toHaveLength(1);
  });

  // A settle that ages into an archive should not leave behind what an
  // interactive settle would have stopped.
  it("reaps a worktree it archives, on the machine that holds it", async () => {
    const host = load({
      sdk: {
        threads: liveThreads([
          listRow({
            id: "thr_old",
            environmentId: "env_wt",
            environmentHostId: "host_remote",
            environmentPath: "/w/app",
            environmentIsWorktree: true,
          }),
        ]),
        terminals: { list: () => ({ sessions: [] }) },
      },
      experimental_callHostRpc: () => ({ killed: [], failed: 0, refused: null }),
    });
    await settleLongAgo(host, "thr_old");
    (host.harness.inspection.experimental_hostRpcCalls as unknown[]).length = 0;

    await host.harness.behavior.callRpc("runAutoArchive", {});

    expect(
      host.harness.inspection.experimental_hostRpcCalls.map((call) => call.hostId),
    ).toEqual(["host_remote"]);
  });

  // The sweep's first judgement is from its start; a thread resumed while an
  // earlier candidate's reap held the sweep must not be archived anyway.
  it("judges again from a fresh read just before archiving", async () => {
    let reads = 0;
    const idle = liveThreads([listRow({ id: "thr_old" })]);
    const resumed = liveThreads([listRow({ id: "thr_old", status: "active" })]);
    const host = load({
      sdk: {
        threads: {
          ...idle,
          list: (args) => {
            reads += 1;
            // The first read chooses; by the re-read the user has resumed it.
            return reads <= 1 ? idle.list(args) : resumed.list(args);
          },
        },
      },
    });
    await settleLongAgo(host, "thr_old");
    reads = 0;

    const result = (await host.harness.behavior.callRpc(
      "runAutoArchive",
      {},
    )) as AutoArchiveSweepResult;

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  // bb's archive stops every run in the tree it takes, lifetime dependents
  // and hidden spin-offs included, so work in any of them blocks it.
  it("leaves a thread alone while a lifetime dependent works", async () => {
    const host = load({
      sdk: {
        threads: liveThreads([
          listRow({ id: "thr_old" }),
          listRow({ id: "thr_owned", lifecycleOwnerThreadId: "thr_old", status: "active" }),
        ]),
      },
    });
    await settleLongAgo(host, "thr_old");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  });

  it("leaves a thread that is working alone", async () => {
    const host = load({
      sdk: { threads: liveThreads([listRow({ id: "thr_busy", status: "active" })]) },
    });
    await settleLongAgo(host, "thr_busy");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    // The row stays, so the thread keeps its place and the next sweep can
    // reconsider it once the work finishes.
    expect(await listRows(host)).toHaveLength(1);
  });

  // The sidebar counts a background command as work; the sweep must agree.
  it("leaves a thread with a background command running alone", async () => {
    const host = load({
      sdk: {
        threads: liveThreads([
          listRow({
            id: "thr_cmd",
            activity: {
              activeBackgroundAgentCount: 0,
              activeBackgroundCommandCount: 1,
              activeGoalCount: 0,
              activePlanModeCount: 0,
              activeWorkflowCount: 0,
            },
          }),
        ]),
      },
    });
    await settleLongAgo(host, "thr_cmd");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  });

  it("leaves a thread that is waiting on the user alone", async () => {
    const host = load({
      sdk: {
        threads: liveThreads([listRow({ id: "thr_asking", hasPendingInteraction: true })]),
      },
    });
    await settleLongAgo(host, "thr_asking");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  });

  it("does nothing while auto-archive is switched off", async () => {
    const host = load({
      settings: { autoArchiveEnabled: false },
      sdk: sweeping("thr_old"),
    });
    await settleLongAgoQuietly(host, "thr_old");

    await host.harness.behavior.runSchedule("auto-archive");

    // Not even a read: the switch is off, so the sweep never inspects a thread.
    expect(host.harness.inspection.sdk.calls).toEqual([]);
    expect(await listRows(host)).toHaveLength(1);
  });

  it("forgets the row of a thread bb no longer has", async () => {
    const host = load({ sdk: sweeping() });
    await settleLongAgo(host, "thr_gone");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    expect(await listRows(host)).toEqual([]);
  });

  it("does not archive a thread that spoke to the user since the settle", async () => {
    // The regression. The sidebar reads new attention after a settle as
    // un-settling, so this thread is visibly back in the inbox — but nothing
    // clears `settled_at`, and the sweep used to select on that column alone
    // and guard only with "is it busy right now".
    const host = load({
      sdk: {
        threads: liveThreads([
          listRow({ id: "thr_spoke", latestAttentionAt: Date.now() - DAY_MS }),
        ]),
      },
    });
    await settleLongAgo(host, "thr_spoke");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    // And the stale row goes, so this is not a candidate the sweep has to talk
    // itself out of again on every pass.
    expect(await listRows(host)).toEqual([]);
  });

  it("honours a retention period the user set", async () => {
    const host = load({
      settings: { autoArchiveDays: "60" },
      sdk: sweeping("thr_recent"),
    });
    // Settled 30 days ago: overdue at the default 7, still fresh at 60.
    await settleLongAgo(host, "thr_recent");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    expect(await listRows(host)).toHaveLength(1);
  });
});

const listAvatars = async (host: FakePluginHost): Promise<StoredAvatarRow[]> =>
  ((await host.harness.behavior.callRpc("listProjectAvatars", {})) as {
    rows: StoredAvatarRow[];
  }).rows;

/** A one-pixel PNG, small enough to write out in full. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * A fake `fetch`, so no test here touches a git host. Returns the recorder as
 * well, because "did not ask at all" is the assertion several of these make.
 */
function stubFetch(
  respond: (url: string) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const fake = vi.fn(async (input: unknown) => respond(String(input)));
  vi.stubGlobal("fetch", fake);
  return fake;
}

const imageResponse = (
  bytes: Buffer = PNG_BYTES,
  contentType = "image/png",
): Response =>
  // A copy into a plain Uint8Array: Buffer is not in the DOM's BodyInit.
  new Response(new Uint8Array(bytes), {
    headers: { "content-type": contentType },
  });

/** The host id `system.config` reports for the machine running the server. */
const OWN_HOST = "hst_this_machine";

/** A host with one project, its git remote pointing at GitHub. */
function loadWithProject(
  options: {
    gitRemoteUrl?: string | null;
    settings?: CreateFakePluginHostOptions["settings"];
    /** A checkout on this machine, when the test is about the local scan. */
    sourcePath?: string;
    /** The machine the source is enrolled on; defaults to this one. */
    sourceHostId?: string;
    /** What `system.config` answers, for the cases where it cannot say. */
    primaryHostId?: string | null;
  } = {},
): FakePluginHost {
  const project = {
    id: "prj_1",
    gitRemoteUrl:
      options.gitRemoteUrl === undefined
        ? "git@github.com:get-bb/bb.git"
        : options.gitRemoteUrl,
    sources:
      options.sourcePath === undefined
        ? []
        : [
            {
              id: "src_1",
              projectId: "prj_1",
              isDefault: true,
              type: "local_path",
              hostId: options.sourceHostId ?? OWN_HOST,
              path: options.sourcePath,
            },
          ],
  };
  return load({
    settings: options.settings,
    sdk: {
      projects: {
        list: () => [project],
        get: () => project,
      },
      system: {
        config: () => ({
          primaryHostId:
            options.primaryHostId === undefined
              ? OWN_HOST
              : options.primaryHostId,
        }),
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseAutoArchiveIntervalHours", () => {
  it("reads a whole number of hours", () => {
    expect(parseAutoArchiveIntervalHours("6")).toBe(6);
    expect(parseAutoArchiveIntervalHours(" 12 ")).toBe(12);
  });

  // The schedule only ticks hourly, so anything under an hour would promise a
  // sweep the ticker cannot deliver.
  it("falls back to the default for anything it cannot honour", () => {
    for (const raw of ["0", "-1", "0.5", "", "soon", undefined]) {
      expect(parseAutoArchiveIntervalHours(raw)).toBe(4);
    }
  });
});

describe("nextAutoArchiveRunAt", () => {
  const HOUR = 60 * 60 * 1000;
  const at = (hours: number, minutes = 0) =>
    Date.UTC(2026, 7, 27, hours, minutes);

  // The interval says when the sweep is DUE; the hourly ticker says when it
  // can actually happen. Reporting the due time would name a minute at which
  // nothing runs.
  it("rounds a due time up to the next tick", () => {
    expect(nextAutoArchiveRunAt(at(14, 30), at(10, 20), 4)).toBe(at(15));
  });

  it("is the next tick when the sweep has never run", () => {
    expect(nextAutoArchiveRunAt(at(14, 30), null, 4)).toBe(at(15));
  });

  // Overdue is not the same as due now: the tick is still what runs it.
  it("is the next tick when the sweep is already overdue", () => {
    expect(nextAutoArchiveRunAt(at(14, 30), at(1), 4)).toBe(at(15));
  });

  it("waits out a long interval rather than the next tick", () => {
    // 14:00 plus twelve hours is 02:00 the following day, not today.
    expect(nextAutoArchiveRunAt(at(14, 30), at(14), 12)).toBe(
      Date.UTC(2026, 7, 28, 2),
    );
  });

  it("lands exactly on the hour a due time already sits on", () => {
    expect(nextAutoArchiveRunAt(at(14, 30), at(12), 6)).toBe(at(18));
  });

  it("never reports a time in the past", () => {
    expect(nextAutoArchiveRunAt(at(14, 30), at(14, 29), 1)).toBeGreaterThan(
      at(14, 30),
    );
  });
});

describe("the interval between sweeps", () => {
  // The sidebar folds a child's work into the parent's card, and the sweep has
  // to read the tree the same way: archiving a parent takes its running
  // children with it.
  it("leaves a settled thread alone while one of its children works", async () => {
    const host = load({
      sdk: {
        threads: liveThreads([
          listRow({ id: "thr_parent" }),
          listRow({ id: "thr_child", parentThreadId: "thr_parent", status: "active" }),
        ]),
      },
    });
    await settleLongAgo(host, "thr_parent");

    const result = (await host.harness.behavior.callRpc(
      "runAutoArchive",
      {},
    )) as AutoArchiveSweepResult;

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    // Skipped, not unsettled: work is a moment, and the settle still stands
    // once the children are quiet again.
    expect(result.skipped).toBe(1);
  });

  // No stamp means this plugin has never swept. Waiting an interval before the
  // first one would leave a fresh install doing nothing for four hours.
  it("sweeps on the first tick it ever sees", async () => {
    const host = load({ sdk: sweeping("thr_old", "thr_other") });
    await settleLongAgo(host, "thr_old");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([
      [{ threadId: "thr_old" }],
    ]);
  });

  it("does nothing on a tick that lands inside the interval", async () => {
    const host = load({ settings: { autoArchiveIntervalHours: "4" }, sdk: sweeping("thr_old", "thr_other") });
    await settleLongAgo(host, "thr_old");
    // The first tick sweeps and starts the clock; the second is an hour later
    // in a four-hour interval, so it must not even read a thread.
    await host.harness.behavior.runSchedule("auto-archive");
    host.harness.inspection.sdk.calls.length = 0;
    await settleLongAgoQuietly(host, "thr_other");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.calls).toEqual([]);
  });

  it("sweeps again once the interval has elapsed", async () => {
    const host = load({ settings: { autoArchiveIntervalHours: "4" }, sdk: sweeping("thr_old", "thr_other") });
    await settleLongAgo(host, "thr_old");
    await host.harness.behavior.runSchedule("auto-archive");
    host.harness.inspection.sdk.calls.length = 0;
    await settleLongAgo(host, "thr_other");
    ageLastSweep(host, 5 * 60 * 60 * 1000);

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([
      [{ threadId: "thr_other" }],
    ]);
  });

  // The whole reason the interval is not in the cron: the setting has to bite
  // on the next tick, not on the next plugin load.
  it("honours a shorter interval without a reload", async () => {
    const host = load({ settings: { autoArchiveIntervalHours: "1" }, sdk: sweeping("thr_old", "thr_other") });
    await settleLongAgo(host, "thr_old");
    await host.harness.behavior.runSchedule("auto-archive");
    host.harness.inspection.sdk.calls.length = 0;
    await settleLongAgo(host, "thr_other");
    ageLastSweep(host, 90 * 60 * 1000);

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([
      [{ threadId: "thr_other" }],
    ]);
  });

  // The button is an explicit request; making it wait for the interval would
  // defeat the point of having it.
  it("lets the manual run ignore the interval", async () => {
    const host = load({ settings: { autoArchiveIntervalHours: "4" }, sdk: sweeping("thr_old", "thr_other") });
    await settleLongAgo(host, "thr_old");
    await host.harness.behavior.runSchedule("auto-archive");
    host.harness.inspection.sdk.calls.length = 0;
    await settleLongAgo(host, "thr_other");

    await host.harness.behavior.callRpc("runAutoArchive", {});

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([
      [{ threadId: "thr_other" }],
    ]);
  });
});

describe("runAutoArchive on demand", () => {
  const sweep = async (host: FakePluginHost) =>
    (await host.harness.behavior.callRpc(
      "runAutoArchive",
      {},
    )) as AutoArchiveSweepResult;

  it("archives the same threads the schedule would, and names them", async () => {
    const host = load({
      sdk: {
        threads: liveThreads([listRow({ id: "thr_old", title: "Fix the flake" })]),
      },
    });
    await settleLongAgo(host, "thr_old");

    const result = await sweep(host);

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([
      [{ threadId: "thr_old" }],
    ]);
    expect(result.archived).toEqual([
      { threadId: "thr_old", title: "Fix the flake" },
    ]);
    expect(result.candidates).toBe(1);
  });

  // The button is a way to see the sweep work, not a way around the switch:
  // pressing it while auto-archive is off must archive nothing.
  it("obeys the switch rather than overriding it", async () => {
    const host = load({
      settings: { autoArchiveEnabled: false },
      sdk: sweeping("thr_old"),
    });
    await settleLongAgoQuietly(host, "thr_old");

    const result = await sweep(host);

    expect(result.enabled).toBe(false);
    expect(host.harness.inspection.sdk.calls).toEqual([]);
    expect(await listRows(host)).toHaveLength(1);
  });

  // The ordinary case, and the one the button exists to make legible: a
  // healthy sweep with nothing old enough yet still has to answer.
  it("reports a run that found no candidates", async () => {
    const host = load({
      sdk: sweeping("thr_fresh"),
    });
    await host.harness.behavior.callRpc("settle", { threadId: "thr_fresh" });

    const result = await sweep(host);

    expect(result).toMatchObject({ enabled: true, candidates: 0, archived: [] });
    expect(await listRows(host)).toHaveLength(1);
  });

  it("counts a thread it had to skip", async () => {
    const host = load({
      sdk: { threads: liveThreads([listRow({ id: "thr_busy", status: "active" })]) },
    });
    await settleLongAgo(host, "thr_busy");

    const result = await sweep(host);

    expect(result.skipped).toBe(1);
    expect(result.archived).toEqual([]);
  });
});

describe("isAllowedAvatarDataUrl", () => {
  it("accepts the image types the sidebar renders", () => {
    for (const type of ["png", "jpeg", "webp", "gif", "svg+xml"]) {
      expect(isAllowedAvatarDataUrl(`data:image/${type};base64,AAAA`)).toBe(
        true,
      );
    }
  });

  // The string ends up in an `<img src>` in bb's own window, so anything that
  // is not plainly an image must never reach it.
  it("rejects anything that is not a base64 image data URL", () => {
    expect(isAllowedAvatarDataUrl("https://example.org/a.png")).toBe(false);
    expect(isAllowedAvatarDataUrl("data:text/html;base64,AAAA")).toBe(false);
    expect(isAllowedAvatarDataUrl("data:image/png,AAAA")).toBe(false);
    expect(
      isAllowedAvatarDataUrl("javascript:alert(1)//data:image/png;base64,AA"),
    ).toBe(false);
    expect(isAllowedAvatarDataUrl("data:image/png;base64,<svg>")).toBe(false);
  });

  it("rejects an image past the size cap", () => {
    const huge = `data:image/png;base64,${"A".repeat(MAX_AVATAR_BYTES)}`;
    expect(isAllowedAvatarDataUrl(huge)).toBe(false);
  });
});

describe("setProjectAvatar", () => {
  it("stores a colour and initials, and tells the frontend", async () => {
    const host = load();
    await host.harness.behavior.callRpc("setProjectAvatar", {
      projectId: "prj_1",
      custom: { kind: "monogram", color: "oklch(0.7 0.1 250)", initials: "BB" },
    });

    expect(await listAvatars(host)).toEqual([
      expect.objectContaining({
        projectId: "prj_1",
        customKind: "monogram",
        customColor: "oklch(0.7 0.1 250)",
        customInitials: "BB",
      }),
    ]);
    expect(
      host.harness.inspection.realtimeSignals.some(
        (signal) => signal.channel === "project-avatars",
      ),
    ).toBe(true);
  });

  it("stores an emoji with its background colour", async () => {
    const host = load();
    await host.harness.behavior.callRpc("setProjectAvatar", {
      projectId: "prj_1",
      custom: { kind: "emoji", emoji: "🐝", color: "#ffcc00" },
    });

    const [row] = await listAvatars(host);
    expect(row).toMatchObject({
      customKind: "emoji",
      customEmoji: "🐝",
      customColor: "#ffcc00",
      customInitials: null,
    });
  });

  it("stores an image data URL", async () => {
    const host = load();
    const image = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;
    await host.harness.behavior.callRpc("setProjectAvatar", {
      projectId: "prj_1",
      custom: { kind: "image", image },
    });

    const [row] = await listAvatars(host);
    expect(row).toMatchObject({ customKind: "image", customImage: image });
  });

  it("refuses an image that is not one of the allowed types", async () => {
    const host = load();
    await expect(
      host.harness.behavior.callRpc("setProjectAvatar", {
        projectId: "prj_1",
        custom: { kind: "image", image: "data:text/html;base64,AAAA" },
      }),
    ).rejects.toThrow(/data URL/);

    expect(await listAvatars(host)).toEqual([]);
  });

  it("refuses an image past the size cap", async () => {
    const host = load();
    await expect(
      host.harness.behavior.callRpc("setProjectAvatar", {
        projectId: "prj_1",
        custom: {
          kind: "image",
          image: `data:image/png;base64,${"A".repeat(MAX_AVATAR_BYTES)}`,
        },
      }),
    ).rejects.toThrow(/KB/);
  });

  it("forgets a project whose avatar is cleared", async () => {
    const host = load();
    await host.harness.behavior.callRpc("setProjectAvatar", {
      projectId: "prj_1",
      custom: { kind: "monogram", color: "#123456", initials: "B" },
    });
    await host.harness.behavior.callRpc("setProjectAvatar", {
      projectId: "prj_1",
      custom: { kind: "clear" },
    });

    // Nothing custom and nothing fetched: the row has nothing left to say.
    expect(await listAvatars(host)).toEqual([]);
  });

  // Clearing a custom avatar is how a user asks for the fetched one back, so
  // it must not take the cache with it.
  it("keeps the fetched image when the custom one is cleared", async () => {
    const host = loadWithProject();
    stubFetch(() => imageResponse());
    await host.harness.behavior.runSchedule("project-avatars");

    await host.harness.behavior.callRpc("setProjectAvatar", {
      projectId: "prj_1",
      custom: { kind: "image", image: "data:image/png;base64,AAAA" },
    });
    await host.harness.behavior.callRpc("setProjectAvatar", {
      projectId: "prj_1",
      custom: { kind: "clear" },
    });

    const [row] = await listAvatars(host);
    expect(row?.customKind).toBeNull();
    expect(row?.remoteImage).toMatch(/^data:image\/png;base64,/);
  });
});

describe("remote avatar sweep", () => {
  it("caches the image the git host serves", async () => {
    const host = loadWithProject();
    const fake = stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    expect(fake.mock.calls[0]?.[0]).toBe(
      "https://github.com/get-bb.png?size=128",
    );
    const [row] = await listAvatars(host);
    expect(row).toMatchObject({
      projectId: "prj_1",
      remoteUrl: "https://github.com/get-bb.png?size=128",
      remoteImage: `data:image/png;base64,${PNG_BYTES.toString("base64")}`,
      failedAt: null,
      failureCount: 0,
    });
    expect(row?.fetchedAt).toBeGreaterThan(0);
  });

  // The switch is a promise about outbound requests, so it has to be checked
  // before anything is read, not before anything is stored.
  it("makes no request at all while the setting is off", async () => {
    const host = loadWithProject({ settings: { remoteAvatarsEnabled: false } });
    const fake = stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    expect(fake).not.toHaveBeenCalled();
    expect(await listAvatars(host)).toEqual([]);
  });

  // With both halves off there is nothing left for the sweep to decide, so it
  // does not even ask bb what the projects are.
  it("reads nothing at all when both avatar sources are off", async () => {
    const host = loadWithProject({
      settings: { remoteAvatarsEnabled: false, localFaviconsEnabled: false },
    });

    await host.harness.behavior.runSchedule("project-avatars");

    expect(host.harness.inspection.sdk.callsTo("projects.list")).toEqual([]);
  });

  it("asks nothing for a project with no usable remote", async () => {
    const host = loadWithProject({ gitRemoteUrl: null });
    const fake = stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    expect(fake).not.toHaveBeenCalled();
    expect(await listAvatars(host)).toEqual([]);
  });

  it("does not ask twice for an image it already has", async () => {
    const host = loadWithProject();
    const fake = stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");
    await host.harness.behavior.runSchedule("project-avatars");

    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("records a failure and backs off", async () => {
    const host = loadWithProject();
    stubFetch(() => new Response("nope", { status: 404 }));

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.failureCount).toBe(1);
    expect(row?.failedAt).toBeGreaterThan(0);
    expect(row?.remoteImage).toBeNull();
  });

  // A host that is briefly down must not cost the user an avatar they had.
  it("keeps the previous image when a later fetch fails", async () => {
    const host = loadWithProject();
    stubFetch(() => imageResponse());
    await host.harness.behavior.runSchedule("project-avatars");

    // The sweep never re-asks for an image it already has, so the second
    // attempt is the one the user asks for from the Settings panel.
    stubFetch(() => {
      throw new Error("connection refused");
    });
    await host.harness.behavior.callRpc("refreshProjectAvatar", {
      projectId: "prj_1",
    });

    const [row] = await listAvatars(host);
    expect(row?.remoteImage).toMatch(/^data:image\/png;base64,/);
    expect(row?.failureCount).toBe(1);
  });

  // A private forge answers a signed-out request with its sign-in page and a
  // 200, so the status alone does not mean we were given an image.
  it("refuses a response that is not an image", async () => {
    const host = loadWithProject();
    stubFetch(() => imageResponse(PNG_BYTES, "text/html"));

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.remoteImage).toBeNull();
    expect(row?.failureCount).toBe(1);
  });

  it("refuses a body past the size cap", async () => {
    const host = loadWithProject();
    stubFetch(() => imageResponse(Buffer.alloc(MAX_AVATAR_BYTES + 1)));

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.remoteImage).toBeNull();
    expect(row?.failureCount).toBe(1);
  });

  it("refetches when the project's remote changed", async () => {
    const host = loadWithProject();
    const fake = stubFetch(() => imageResponse());
    await host.harness.behavior.runSchedule("project-avatars");

    // The cached image belongs to a different owner now.
    host.bb.storage
      .database()
      .prepare(`UPDATE project_avatar SET remote_url = ? WHERE project_id = ?`)
      .run("https://github.com/someone-else.png?size=128", "prj_1");
    await host.harness.behavior.runSchedule("project-avatars");

    expect(fake).toHaveBeenCalledTimes(2);
  });

  it("runs a first sweep shortly after load", async () => {
    vi.useFakeTimers();
    try {
      const host = loadWithProject();
      const fake = stubFetch(() => imageResponse());

      await vi.advanceTimersByTimeAsync(20_000);

      expect(fake).toHaveBeenCalledTimes(1);
      expect(await listAvatars(host)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("refreshProjectAvatar", () => {
  it("fetches now, even inside the backoff", async () => {
    const host = loadWithProject();
    stubFetch(() => new Response("nope", { status: 500 }));
    await host.harness.behavior.runSchedule("project-avatars");

    const fake = stubFetch(() => imageResponse());
    const result = await host.harness.behavior.callRpc(
      "refreshProjectAvatar",
      { projectId: "prj_1" },
    );

    expect(result).toEqual({ ok: true });
    expect(fake).toHaveBeenCalledTimes(1);
    const [row] = await listAvatars(host);
    expect(row?.remoteImage).toMatch(/^data:image\/png;base64,/);
    // A success ends the backoff, so the next failure starts again from one.
    expect(row?.failureCount).toBe(0);
  });

  it("reports failure rather than changing nothing silently", async () => {
    const host = loadWithProject();
    stubFetch(() => new Response("nope", { status: 403 }));

    expect(
      await host.harness.behavior.callRpc("refreshProjectAvatar", {
        projectId: "prj_1",
      }),
    ).toEqual({ ok: false });
  });

  it("makes no request while the setting is off", async () => {
    const host = loadWithProject({ settings: { remoteAvatarsEnabled: false } });
    const fake = stubFetch(() => imageResponse());

    expect(
      await host.harness.behavior.callRpc("refreshProjectAvatar", {
        projectId: "prj_1",
      }),
    ).toEqual({ ok: false });
    expect(fake).not.toHaveBeenCalled();
  });
});

describe("setProjectAvatarFromUrl", () => {
  it("fetches the picture here and stores it as the custom avatar", async () => {
    const host = loadWithProject();
    const fake = stubFetch(() => imageResponse());

    const result = await host.harness.behavior.callRpc(
      "setProjectAvatarFromUrl",
      { projectId: "prj_1", url: "https://cdn.example.com/logo.png" },
    );

    expect(fake).toHaveBeenCalledTimes(1);
    expect((result as { image: string }).image).toMatch(
      /^data:image\/png;base64,/,
    );
    const [row] = await listAvatars(host);
    // It lands in the custom column, not the remote cache: this is the user's
    // choice, and the sweep must never overwrite or expire it.
    expect(row?.customKind).toBe("image");
    expect(row?.customImage).toMatch(/^data:image\/png;base64,/);
    expect(row?.remoteImage).toBeNull();
  });

  it("still works while automatic git-host fetching is switched off", async () => {
    // The switch is a promise about requests this plugin makes on its own
    // initiative, not about a button the user just pressed.
    const host = loadWithProject({ settings: { remoteAvatarsEnabled: false } });
    const fake = stubFetch(() => imageResponse());

    await host.harness.behavior.callRpc("setProjectAvatarFromUrl", {
      projectId: "prj_1",
      url: "https://cdn.example.com/logo.png",
    });

    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("refuses an address on this machine or its network, without asking", async () => {
    const host = loadWithProject();
    const fake = stubFetch(() => imageResponse());

    for (const url of [
      "http://localhost:8080/logo.png",
      "http://127.0.0.1/logo.png",
      "https://192.168.1.10/logo.png",
      "file:///etc/passwd",
    ]) {
      await expect(
        host.harness.behavior.callRpc("setProjectAvatarFromUrl", {
          projectId: "prj_1",
          url,
        }),
      ).rejects.toThrow();
    }
    expect(fake).not.toHaveBeenCalled();
  });

  it("refuses what the host sent when it is not an image the sidebar renders", async () => {
    const host = loadWithProject();
    stubFetch(() => new Response("<html>sign in</html>", {
      headers: { "content-type": "text/html" },
    }));

    await expect(
      host.harness.behavior.callRpc("setProjectAvatarFromUrl", {
        projectId: "prj_1",
        url: "https://forge.example.com/logo.png",
      }),
    ).rejects.toThrow(/text\/html/);
    expect(await listAvatars(host)).toEqual([]);
  });

  it("refuses an image bigger than the sidebar will carry", async () => {
    const host = loadWithProject();
    stubFetch(() =>
      imageResponse(Buffer.alloc(MAX_AVATAR_BYTES + 1, 0x41)),
    );

    await expect(
      host.harness.behavior.callRpc("setProjectAvatarFromUrl", {
        projectId: "prj_1",
        url: "https://cdn.example.com/huge.png",
      }),
    ).rejects.toThrow();
  });
});

/**
 * A real directory tree rather than a mocked `fs`.
 *
 * The scan is about what a filesystem actually answers — a missing directory,
 * a file that is really a directory, an mtime that moved — and a mock of `fs`
 * would only ever return what this test already believed. A temp directory
 * costs a few milliseconds and tests the thing that ships.
 */
const checkouts: string[] = [];

async function makeCheckout(
  files: Record<string, string | Buffer>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "triage-favicon-"));
  checkouts.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(root, relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(
    checkouts.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>';

const dataUrlOf = (mimeType: string, contents: string | Buffer): string =>
  `data:${mimeType};base64,${Buffer.from(contents).toString("base64")}`;

describe("localSourcePath", () => {
  const source = (overrides: Record<string, unknown> = {}) => ({
    type: "local_path",
    hostId: OWN_HOST,
    path: "/checkouts/app",
    isDefault: true,
    ...overrides,
  });

  it("takes the default source on this machine", () => {
    expect(
      localSourcePath(
        {
          id: "prj_1",
          gitRemoteUrl: null,
          sources: [
            source({ path: "/checkouts/extra", isDefault: false }),
            source({ path: "/checkouts/main" }),
          ],
        },
        OWN_HOST,
      ),
    ).toBe("/checkouts/main");
  });

  // The path describes a directory on the OTHER machine. That the same path
  // may exist here is a coincidence, not permission to open it.
  it("refuses a source enrolled on another machine", () => {
    expect(
      localSourcePath(
        {
          id: "prj_1",
          gitRemoteUrl: null,
          sources: [source({ hostId: "hst_someone_elses_laptop" })],
        },
        OWN_HOST,
      ),
    ).toBe(null);
  });

  it("refuses everything when the server cannot name its own machine", () => {
    expect(
      localSourcePath(
        { id: "prj_1", gitRemoteUrl: null, sources: [source()] },
        null,
      ),
    ).toBe(null);
  });

  it("has nothing to read for a project with no sources", () => {
    expect(
      localSourcePath({ id: "prj_1", gitRemoteUrl: null }, OWN_HOST),
    ).toBe(null);
    expect(
      localSourcePath(
        { id: "prj_1", gitRemoteUrl: null, sources: [source({ path: "  " })] },
        OWN_HOST,
      ),
    ).toBe(null);
  });
});

describe("local favicon scan", () => {
  it("reads the project's own icon and records where it came from", async () => {
    const root = await makeCheckout({ "public/favicon.svg": SVG });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row).toMatchObject({
      faviconImage: dataUrlOf("image/svg+xml", SVG),
      faviconPath: "public/favicon.svg",
      faviconMissingAt: null,
    });
    expect(row?.faviconScannedAt).toBeGreaterThan(0);
  });

  // The favicon is what the sidebar draws, so asking the git host for an
  // image nobody will see is noise on somebody else's server.
  it("stops fetching from the git host once a favicon is found", async () => {
    const root = await makeCheckout({ "public/favicon.svg": SVG });
    const host = loadWithProject({ sourcePath: root });
    const fake = stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    expect(fake).not.toHaveBeenCalled();
  });

  it("still fetches from the git host when the checkout has no icon", async () => {
    const root = await makeCheckout({ "README.md": "# hi" });
    const host = loadWithProject({ sourcePath: root });
    const fake = stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    expect(fake).toHaveBeenCalledTimes(1);
    const [row] = await listAvatars(host);
    expect(row?.faviconImage).toBeNull();
    // The memo that stops the next load walking these directories again.
    expect(row?.faviconMissingAt).toBeGreaterThan(0);
  });

  it("takes the best candidate the checkout offers", async () => {
    const root = await makeCheckout({
      "public/favicon.ico": "not really an icon",
      "public/favicon-32x32.png": PNG_BYTES,
      "public/apple-touch-icon.png": PNG_BYTES,
      "src/logo.svg": SVG,
    });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.faviconPath).toBe("public/apple-touch-icon.png");
  });

  // A repository whose only icon is favicon.ico is extremely common, so the
  // store accepts icon files even though they are usually 16 or 32 pixels.
  it("uses favicon.ico when it is the only icon", async () => {
    const root = await makeCheckout({ "public/favicon.ico": "icon bytes" });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.faviconPath).toBe("public/favicon.ico");
    expect(row?.faviconImage).toContain("data:image/x-icon;base64,");
  });

  // The best-ranked name can turn out to be unreadable — a directory here —
  // so the scan must fall through instead of giving up on the project.
  it("falls through a candidate it cannot read", async () => {
    const root = await makeCheckout({
      "public/apple-touch-icon.png/keep": "a directory, not a file",
      "public/logo.svg": SVG,
    });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.faviconPath).toBe("public/logo.svg");
  });

  it("refuses an icon past the size cap", async () => {
    const root = await makeCheckout({
      "public/favicon.png": Buffer.alloc(MAX_AVATAR_BYTES + 1),
    });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.faviconImage).toBeNull();
  });

  it("finds an icon one level down in a monorepo", async () => {
    const root = await makeCheckout({ "apps/web/public/favicon.svg": SVG });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.faviconPath).toBe("apps/web/public/favicon.svg");
  });

  it("does not walk a directory it was never told to search", async () => {
    const root = await makeCheckout({
      "node_modules/thing/favicon.svg": SVG,
      "docs/favicon.svg": SVG,
    });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.faviconImage).toBeNull();
  });

  // The sweep runs against every project every day; re-reading an unchanged
  // image would be the most expensive thing this plugin does.
  it("does not re-read an unchanged icon, and re-reads a changed one", async () => {
    const root = await makeCheckout({ "public/favicon.svg": SVG });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");
    const first = (await listAvatars(host))[0];

    await host.harness.behavior.runSchedule("project-avatars");
    expect((await listAvatars(host))[0]?.faviconScannedAt).toBe(
      first?.faviconScannedAt,
    );

    const changed = SVG.replace("rect", "circle");
    await writeFile(join(root, "public/favicon.svg"), changed);
    // Explicit mtime rather than trusting the clock: two writes inside the
    // same millisecond are entirely possible on a fast machine.
    const later = new Date(Date.now() + 60_000);
    await utimes(join(root, "public/favicon.svg"), later, later);

    await host.harness.behavior.runSchedule("project-avatars");
    expect((await listAvatars(host))[0]?.faviconImage).toBe(
      dataUrlOf("image/svg+xml", changed),
    );
  });

  it("forgets an icon that was deleted", async () => {
    const root = await makeCheckout({ "public/favicon.svg": SVG });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());
    await host.harness.behavior.runSchedule("project-avatars");

    await rm(join(root, "public/favicon.svg"));
    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.faviconImage).toBeNull();
    expect(row?.faviconPath).toBeNull();
  });

  // Once a project has been found to have no icon, the next scan is skipped
  // for half a day — long enough that a plugin reload is free, short enough
  // that the daily sweep always looks again.
  it("waits before walking an iconless project's directories again", async () => {
    const root = await makeCheckout({ "README.md": "# hi" });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());
    await host.harness.behavior.runSchedule("project-avatars");

    await writeFile(join(root, "favicon.svg"), SVG);
    await host.harness.behavior.runSchedule("project-avatars");
    expect((await listAvatars(host))[0]?.faviconImage).toBeNull();

    // A day later — which is when the daily schedule next runs anyway.
    host.bb.storage
      .database()
      .prepare(
        `UPDATE project_avatar SET favicon_missing_at = ? WHERE project_id = ?`,
      )
      .run(Date.now() - DAY_MS, "prj_1");
    await host.harness.behavior.runSchedule("project-avatars");
    expect((await listAvatars(host))[0]?.faviconPath).toBe("favicon.svg");
  });

  it("reads nothing while the setting is off", async () => {
    const root = await makeCheckout({ "public/favicon.svg": SVG });
    const host = loadWithProject({
      sourcePath: root,
      settings: { localFaviconsEnabled: false },
    });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.faviconImage).toBeNull();
    expect(row?.faviconScannedAt).toBeNull();
    // With no favicon in the way, the git host is asked as it always was.
    expect(row?.remoteImage).toMatch(/^data:image\/png;base64,/);
  });

  // The path names a directory on the other machine; the fact that it also
  // exists here is a coincidence.
  it("reads nothing for a checkout on another machine", async () => {
    const root = await makeCheckout({ "public/favicon.svg": SVG });
    const host = loadWithProject({
      sourcePath: root,
      sourceHostId: "hst_someone_elses_laptop",
    });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    expect((await listAvatars(host))[0]?.faviconImage).toBeNull();
  });

  it("reads nothing when the server cannot name its own machine", async () => {
    const root = await makeCheckout({ "public/favicon.svg": SVG });
    const host = loadWithProject({ sourcePath: root, primaryHostId: null });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    expect((await listAvatars(host))[0]?.faviconImage).toBeNull();
  });

  // A folder on an unmounted disk costs that project an icon, never the sweep.
  it("survives a source folder that is not there", async () => {
    const host = loadWithProject({ sourcePath: "/definitely/not/here" });
    const fake = stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    expect(fake).toHaveBeenCalledTimes(1);
    expect((await listAvatars(host))[0]?.remoteImage).toMatch(/^data:image/);
  });

  // The user is looking at the sidebar when they flip the switch; an avatar
  // that stayed until the next sweep would read as the setting doing nothing.
  it("forgets the icons it read when the setting is turned off", async () => {
    const root = await makeCheckout({ "public/favicon.svg": SVG });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());
    await host.harness.behavior.runSchedule("project-avatars");
    expect((await listAvatars(host))[0]?.faviconImage).not.toBeNull();

    await host.harness.behavior.setSettings({ localFaviconsEnabled: false });

    // Nothing custom, nothing fetched and nothing local: the row has nothing
    // left to say, exactly as it would have had the scan never run.
    expect(await listAvatars(host)).toEqual([]);
    expect(
      host.harness.inspection.realtimeSignals.some(
        (signal) => signal.channel === "project-avatars",
      ),
    ).toBe(true);
  });

  // Every sweep touches every project; a signal per project per sweep would
  // re-render every sidebar in every window for nothing.
  it("tells the frontend only when the icon actually changed", async () => {
    const root = await makeCheckout({ "public/favicon.svg": SVG });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");
    const after = host.harness.inspection.realtimeSignals.length;
    await host.harness.behavior.runSchedule("project-avatars");

    expect(host.harness.inspection.realtimeSignals.length).toBe(after);
  });
});

describe("reaping on settle", () => {
  const WORKTREE = "/Users/x/.bb/worktrees/env_wt/app";

  const environments = {
    env_wt: {
      environmentId: "env_wt",
      environmentHostId: "host_remote",
      environmentPath: WORKTREE,
      environmentIsWorktree: true,
    },
    env_main: {
      environmentId: "env_main",
      environmentHostId: "host_local",
      environmentPath: "/Users/x/app",
      environmentIsWorktree: false,
    },
  };

  /** The settled thread in a worktree, plus whoever else a test puts there. */
  const reaping = (
    overrides: {
      environment?: keyof typeof environments;
      others?: Array<{ id: string; status: string }>;
    } = {},
  ): CreateFakePluginHostOptions["sdk"] => ({
    threads: liveThreads(
      [{ id: "thr_done", status: "idle" }, ...(overrides.others ?? [])].map((thread) =>
        listRow({ ...thread, ...environments[overrides.environment ?? "env_wt"] }),
      ),
    ),
    terminals: {
      list: () => ({
        sessions: [
          { id: "term_live", status: "running", title: "pnpm dev" },
          // Already gone: closing it would be a call with nothing behind it.
          { id: "term_done", status: "exited", title: "old shell" },
        ],
      }),
      close: () => ({ id: "term_live", status: "exited" }),
    },
  });

  const killedVite = {
    killed: [{ pid: 4812, command: "node vite --port 4321" }],
    failed: 0,
    refused: null,
  };

  /** The `reaped` message the settle published once its reap finished. */
  const reapedMessage = (host: FakePluginHost) =>
    host.harness.inspection.realtimeSignals.find(
      (signal) =>
        signal.channel === "lifecycle" &&
        (signal.payload as { reaped?: unknown } | undefined)?.reaped !== undefined,
    )?.payload as { threadId: string; reaped: ReapSummary } | undefined;

  const settleAndReap = async (host: FakePluginHost, threadId = "thr_done") => {
    const result = await host.harness.behavior.callRpc("settle", { threadId });
    await flushTasks();
    return result;
  };

  // The settle is the user's decision and is answered at once; the reap
  // follows and reports on the channel.
  it("returns before the reap and publishes what it stopped", async () => {
    let releaseHost: (value: unknown) => void = () => {};
    const host = load({
      sdk: reaping(),
      experimental_callHostRpc: () =>
        new Promise((resolve) => {
          releaseHost = resolve;
        }),
    });

    expect(await host.harness.behavior.callRpc("settle", { threadId: "thr_done" })).toEqual({
      ok: true,
    });
    await flushTasks();
    expect(reapedMessage(host)).toBeUndefined();

    releaseHost(killedVite);
    await flushTasks();

    const message = reapedMessage(host);
    expect(message?.threadId).toBe("thr_done");
    // Named, not counted: the user has to be able to tell which server stopped.
    expect(message?.reaped.terminalsClosed).toEqual([
      { terminalId: "term_live", title: "pnpm dev" },
    ]);
    expect(message?.reaped.processesKilled).toEqual(killedVite.killed);
  });

  // The whole point of the host entry: the sweep runs on the machine that
  // holds the worktree, not on the server's.
  it("sweeps the worktree on the machine that holds it", async () => {
    const host = load({
      sdk: reaping(),
      experimental_callHostRpc: () => killedVite,
    });
    await settleAndReap(host);

    expect(
      host.harness.inspection.experimental_hostRpcCalls.map(
        ({ method, input, hostId }) => ({ method, input, hostId }),
      ),
    ).toEqual([
      { method: "reapDirectory", input: { directory: WORKTREE }, hostId: "host_remote" },
    ]);
  });

  // A project checkout is where the user works too, and nothing running there
  // can be told apart from what an agent left behind.
  it("closes terminals but sweeps nothing in a project checkout", async () => {
    const host = load({
      sdk: reaping({ environment: "env_main" }),
      experimental_callHostRpc: () => killedVite,
    });
    await settleAndReap(host);

    expect(host.harness.inspection.experimental_hostRpcCalls).toEqual([]);
    expect(reapedMessage(host)?.reaped.terminalsClosed).toHaveLength(1);
  });

  it("leaves a worktree alone while another thread is mid-turn in it", async () => {
    const host = load({
      sdk: reaping({ others: [{ id: "thr_sibling", status: "active" }] }),
      experimental_callHostRpc: () => killedVite,
    });
    await settleAndReap(host);

    expect(host.harness.inspection.experimental_hostRpcCalls).toEqual([]);
    expect(reapedMessage(host)?.reaped.worktreesSkipped).toEqual([
      { path: WORKTREE, reason: "in-use" },
    ]);
  });

  // An idle sibling does not protect the worktree: its dev server looks the
  // same as the settled thread's, and the SPEC chose to stop it.
  it("still sweeps a worktree shared with an idle thread", async () => {
    const host = load({
      sdk: reaping({ others: [{ id: "thr_sibling", status: "idle" }] }),
      experimental_callHostRpc: () => killedVite,
    });
    await settleAndReap(host);

    expect(host.harness.inspection.experimental_hostRpcCalls).toHaveLength(1);
  });

  it("reports an unreachable machine and stops nothing there", async () => {
    const host = load({
      sdk: reaping(),
      experimental_callHostRpc: () => {
        throw new Error("host offline");
      },
    });
    const result = await settleAndReap(host);

    expect(result).toEqual({ ok: true });
    expect(reapedMessage(host)?.reaped).toMatchObject({
      processesKilled: [],
      worktreesSkipped: [{ path: WORKTREE, reason: "unreachable" }],
    });
    expect(await listRows(host)).toHaveLength(1);
  });

  // Settle no longer waits for the reap, so an undo can land while it runs.
  // The user took the decision back; nothing more may be stopped for it.
  it("stops reaping when the settle is undone mid-reap", async () => {
    let releaseTerminals: () => void = () => {};
    const host = load({
      sdk: {
        ...reaping(),
        terminals: {
          list: () =>
            new Promise((resolve) => {
              releaseTerminals = () => resolve({ sessions: [] });
            }),
        },
      },
      experimental_callHostRpc: () => killedVite,
    });
    await host.harness.behavior.callRpc("settle", { threadId: "thr_done" });
    await flushTasks();
    await host.harness.behavior.callRpc("unsettle", { threadId: "thr_done" });
    releaseTerminals();
    await flushTasks();

    expect(host.harness.inspection.experimental_hostRpcCalls).toEqual([]);
  });

  it("leaves everything alone when the setting is off", async () => {
    const host = load({
      settings: { reapOnSettle: false },
      sdk: reaping(),
    });
    await settleAndReap(host);

    expect(host.harness.inspection.sdk.callsTo("terminals.list")).toEqual([]);
    expect(reapedMessage(host)).toBeUndefined();
  });

  // Without the list there is no knowing which thread is running now, and
  // nothing is closed or killed on a guess.
  it("stops nothing when the thread list cannot be read", async () => {
    const base = reaping();
    const host = load({
      sdk: {
        ...base,
        threads: {
          ...base?.threads,
          list: () => {
            throw new Error("no list for you");
          },
        },
      },
      experimental_callHostRpc: () => killedVite,
    });
    await settleAndReap(host);

    expect(host.harness.inspection.sdk.callsTo("terminals.close")).toEqual([]);
    expect(host.harness.inspection.experimental_hostRpcCalls).toEqual([]);
  });

  // The settled thread itself, resumed: its terminals serve the turn in
  // flight and its worktree is in use. The server decides, not the sidebar.
  it("spares a settled thread that is running again", async () => {
    const host = load({
      sdk: {
        ...reaping(),
        threads: liveThreads([
          listRow({ id: "thr_done", status: "active", ...environments.env_wt }),
        ]),
      },
      experimental_callHostRpc: () => killedVite,
    });
    await settleAndReap(host);

    expect(host.harness.inspection.sdk.callsTo("terminals.close")).toEqual([]);
    expect(host.harness.inspection.experimental_hostRpcCalls).toEqual([]);
    expect(reapedMessage(host)?.reaped.worktreesSkipped).toEqual([
      { path: WORKTREE, reason: "in-use" },
    ]);
  });

  // bb's archive takes a thread's lifetime dependents too; the reap walks
  // the same tree, so a dependent running in the worktree protects it.
  it("counts a running lifetime dependent as the worktree being in use", async () => {
    const host = load({
      sdk: {
        ...reaping(),
        threads: liveThreads([
          listRow({ id: "thr_done", ...environments.env_wt }),
          listRow({
            id: "thr_owned",
            status: "active",
            lifecycleOwnerThreadId: "thr_done",
            ...environments.env_wt,
          }),
        ]),
      },
      experimental_callHostRpc: () => killedVite,
    });
    await settleAndReap(host);

    expect(host.harness.inspection.experimental_hostRpcCalls).toEqual([]);
  });

  it("stops nothing if the settle is undone during the in-use check", async () => {
    let releaseEnvironment: () => void = () => {};
    const base = liveThreads([listRow({ id: "thr_done", ...environments.env_wt })]);
    const host = load({
      sdk: {
        ...reaping(),
        threads: {
          ...base,
          list: (args) =>
            args?.environmentId === undefined
              ? base.list(args)
              : (new Promise((resolve) => {
                  releaseEnvironment = () => resolve(base.list(args));
                }) as never),
        },
      },
      experimental_callHostRpc: () => killedVite,
    });
    await host.harness.behavior.callRpc("settle", { threadId: "thr_done" });
    await flushTasks();
    await host.harness.behavior.callRpc("unsettle", { threadId: "thr_done" });
    releaseEnvironment();
    await flushTasks();

    expect(host.harness.inspection.experimental_hostRpcCalls).toEqual([]);
  });

  it("reports a worktree with no machine on record as unreachable", async () => {
    const host = load({
      sdk: {
        ...reaping(),
        threads: liveThreads([
          listRow({ id: "thr_done", ...environments.env_wt, environmentHostId: null }),
        ]),
      },
      experimental_callHostRpc: () => killedVite,
    });
    await settleAndReap(host);

    expect(reapedMessage(host)?.reaped.worktreesSkipped).toEqual([
      { path: WORKTREE, reason: "unreachable" },
    ]);
  });

  // A call that ran out of time may already have killed something, so it is
  // not reported as "nothing stopped".
  it("reports a host that ran out of time as timed out, not unreachable", async () => {
    vi.useFakeTimers();
    try {
      const host = load({
        sdk: reaping(),
        experimental_callHostRpc: ({ signal }) =>
          new Promise((_, reject) =>
            signal?.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
      });
      await host.harness.behavior.callRpc("settle", { threadId: "thr_done" });
      await vi.advanceTimersByTimeAsync(61_000);

      expect(reapedMessage(host)?.reaped.worktreesSkipped).toEqual([
        { path: WORKTREE, reason: "timed-out" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a reap in flight when the plugin unloads", async () => {
    const host = load({
      sdk: reaping(),
      experimental_callHostRpc: ({ signal }) =>
        new Promise((_, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    });
    await host.harness.behavior.callRpc("settle", { threadId: "thr_done" });
    await flushTasks();
    const signal = host.harness.inspection.experimental_hostRpcCalls[0]?.signal;

    await host.harness.lifecycle.dispose();
    await flushTasks();

    expect(signal?.aborted).toBe(true);
  });

  // The settle is the user's decision; cleanup is housekeeping that follows
  // it. A host that cannot even list terminals must not undo the settle.
  it("still settles the thread when the reap fails", async () => {
    const host = load({
      sdk: {
        ...reaping(),
        terminals: {
          list: () => {
            throw new Error("no daemon");
          },
        },
      },
      experimental_callHostRpc: () => killedVite,
    });
    await settleAndReap(host);

    expect(reapedMessage(host)?.reaped.terminalsFailed).toBe(1);
    expect(await listRows(host)).toHaveLength(1);
  });
});
