import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type CreateFakePluginHostOptions,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin, {
  parseAutoArchiveDays,
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

/** A thread that has been settled long enough for any sane retention period. */
async function settleLongAgo(
  host: FakePluginHost,
  threadId: string,
): Promise<void> {
  await host.harness.behavior.callRpc("settle", { threadId });
  host.bb.storage
    .database()
    .prepare(`UPDATE thread_lifecycle SET settled_at = ? WHERE thread_id = ?`)
    .run(Date.now() - 30 * DAY_MS, threadId);
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

describe("working duration", () => {
  it("records the start when bb reports a thread going active", async () => {
    const host = load();
    const before = Date.now();
    await host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_run" }),
    });

    const [row] = await listRows(host);
    expect(row?.threadId).toBe("thr_run");
    expect(row?.startedWorkingAt).toBeGreaterThanOrEqual(before);
    // The sidebar only re-reads on the channel, so a silent write would leave
    // the elapsed label missing until something unrelated refreshed.
    expect(
      host.harness.inspection.realtimeSignals.some(
        (signal) => signal.channel === "lifecycle",
      ),
    ).toBe(true);
  });

  it("clears the start when the thread goes idle", async () => {
    const host = load();
    await host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_run" }),
    });
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_run" }),
      lastAssistantText: null,
    });

    // Nothing parked it, so the row has nothing left to say and goes away
    // entirely rather than lingering as an all-null row.
    expect(await listRows(host)).toEqual([]);
  });

  it("keeps a parked thread's shelf when its run ends", async () => {
    const host = load();
    await host.harness.behavior.callRpc("settle", { threadId: "thr_parked" });
    await host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_parked" }),
    });
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "thr_parked" }),
      error: "boom",
    });

    const [row] = await listRows(host);
    expect(row?.settledAt).not.toBeNull();
    expect(row?.startedWorkingAt).toBeNull();
  });
});

describe("auto-archive sweep", () => {
  it("archives a settled thread once it is older than the retention period", async () => {
    const host = load({
      sdk: {
        threads: {
          get: ({ threadId }) => makeThreadResponse({ id: threadId }),
          interactions: { list: () => [] },
          archive: () => ({ archived: 1 }),
        },
      },
    });
    await settleLongAgo(host, "thr_old");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([
      [{ threadId: "thr_old" }],
    ]);
    // Archived threads have no shelf, and a leftover row would park the
    // thread again the moment it was unarchived.
    expect(await listRows(host)).toEqual([]);
  });

  it("leaves a thread that is working alone", async () => {
    const host = load({
      sdk: {
        threads: {
          get: ({ threadId }) =>
            makeThreadResponse({ id: threadId, status: "active" }),
          interactions: { list: () => [] },
          archive: () => ({ archived: 1 }),
        },
      },
    });
    await settleLongAgo(host, "thr_busy");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    // The row stays, so the thread keeps its place and the next sweep can
    // reconsider it once the work finishes.
    expect(await listRows(host)).toHaveLength(1);
  });

  it("leaves a thread that is waiting on the user alone", async () => {
    const host = load({
      sdk: {
        threads: {
          get: ({ threadId }) => makeThreadResponse({ id: threadId }),
          interactions: {
            list: ({ threadId }) => [
              { id: "int_1", threadId, status: "pending" },
            ],
          },
          archive: () => ({ archived: 1 }),
        },
      },
    });
    await settleLongAgo(host, "thr_asking");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  });

  it("does nothing while auto-archive is switched off", async () => {
    const host = load({
      settings: { autoArchiveEnabled: false },
      sdk: {
        threads: {
          get: ({ threadId }) => makeThreadResponse({ id: threadId }),
          interactions: { list: () => [] },
          archive: () => ({ archived: 1 }),
        },
      },
    });
    await settleLongAgo(host, "thr_old");

    await host.harness.behavior.runSchedule("auto-archive");

    // Not even a read: the switch is off, so the sweep never inspects a thread.
    expect(host.harness.inspection.sdk.calls).toEqual([]);
    expect(await listRows(host)).toHaveLength(1);
  });

  it("forgets the row of a thread bb no longer has", async () => {
    const host = load({
      sdk: {
        threads: {
          get: () => {
            throw new Error("not found");
          },
          interactions: { list: () => [] },
          archive: () => ({ archived: 1 }),
        },
      },
    });
    await settleLongAgo(host, "thr_gone");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    expect(await listRows(host)).toEqual([]);
  });

  it("honours a retention period the user set", async () => {
    const host = load({
      settings: { autoArchiveDays: "60" },
      sdk: {
        threads: {
          get: ({ threadId }) => makeThreadResponse({ id: threadId }),
          interactions: { list: () => [] },
          archive: () => ({ archived: 1 }),
        },
      },
    });
    // Settled 30 days ago: overdue at the default 7, still fresh at 60.
    await settleLongAgo(host, "thr_recent");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    expect(await listRows(host)).toHaveLength(1);
  });
});
