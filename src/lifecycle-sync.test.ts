import { describe, expect, it } from "vitest";
import {
  applyRowMessage,
  blankRow,
  describeReap,
  parseLifecycleMessage,
  predictParkingRow,
  stateFromSnapshot,
  stateFromSnapshotAndBuffer,
  type LifecycleRowMessage,
} from "./lifecycle-sync";
import type { ReapSummary } from "./server";

const settledRow = (threadId: string, settledAt = 100) => ({
  ...blankRow(threadId),
  settledAt,
});

const message = (
  seq: number,
  threadId: string,
  row: ReturnType<typeof blankRow> | null,
  epoch = "e1",
): LifecycleRowMessage => ({ kind: "row", epoch, seq, threadId, row });

const snapshot = stateFromSnapshot({ epoch: "e1", seq: 5, rows: [settledRow("a")] });

describe("applyRowMessage", () => {
  it("applies the next change", () => {
    const { state, stale } = applyRowMessage(snapshot, message(6, "b", settledRow("b")));
    expect(stale).toBe(false);
    expect(state.seq).toBe(6);
    expect(state.rows.get("b")?.settledAt).toBe(100);
  });

  it("removes a row the server deleted", () => {
    const { state } = applyRowMessage(snapshot, message(6, "a", null));
    expect(state.rows.has("a")).toBe(false);
  });

  // The snapshot already contains it; applying it again could only go back
  // in time.
  it("drops a change the snapshot already covers", () => {
    const { state, stale } = applyRowMessage(snapshot, message(5, "a", null));
    expect(stale).toBe(false);
    expect(state).toBe(snapshot);
  });

  it("applies a change past a gap but marks the copy stale", () => {
    const { state, stale } = applyRowMessage(snapshot, message(8, "b", settledRow("b")));
    expect(stale).toBe(true);
    expect(state.rows.has("b")).toBe(true);
  });

  // A reloaded server numbers from scratch; its counter says nothing about
  // this copy.
  it("marks the copy stale on a message from another server run", () => {
    expect(applyRowMessage(snapshot, message(1, "b", null, "e2")).stale).toBe(true);
  });
});

describe("stateFromSnapshotAndBuffer", () => {
  // The race it exists for: a change published after the read began, and
  // delivered before the read returned.
  it("applies buffered changes the snapshot does not contain, in order", () => {
    const { state, stale } = stateFromSnapshotAndBuffer(
      { epoch: "e1", seq: 5, rows: [settledRow("a")] },
      [message(7, "b", null), message(4, "a", null), message(6, "b", settledRow("b"))],
    );
    expect(stale).toBe(false);
    expect(state.seq).toBe(7);
    expect(state.rows.has("a")).toBe(true);
    expect(state.rows.has("b")).toBe(false);
  });

  it("ignores buffered changes from an older server run", () => {
    const { state, stale } = stateFromSnapshotAndBuffer(
      { epoch: "e2", seq: 0, rows: [] },
      [message(9, "a", settledRow("a"), "e1")],
    );
    expect(stale).toBe(false);
    expect(state.rows.size).toBe(0);
  });
});

describe("predictParkingRow", () => {
  const timed = { ...blankRow("a"), lastRunEndedAt: 50, startedWorkingAt: null };

  // The idle age belongs to bb; a parking change never touches it.
  it("keeps bb's timing columns through every change", () => {
    expect(predictParkingRow(timed, "a", { kind: "settle", at: 9 })).toMatchObject({
      settledAt: 9,
      lastRunEndedAt: 50,
    });
    expect(
      predictParkingRow(timed, "a", { kind: "snooze", at: 9, until: 99 }),
    ).toMatchObject({ settledAt: null, snoozedUntil: 99, snoozedAt: 9, lastRunEndedAt: 50 });
    expect(predictParkingRow(settledRow("a"), "a", { kind: "unpark" })).toMatchObject({
      settledAt: null,
      snoozedUntil: null,
    });
  });
});

describe("parseLifecycleMessage", () => {
  it("rejects anything that is not a lifecycle message", () => {
    expect(parseLifecycleMessage(null)).toBeNull();
    expect(parseLifecycleMessage({ threadId: "a" })).toBeNull();
    expect(parseLifecycleMessage({ kind: "row", threadId: "a", seq: "1" })).toBeNull();
  });
});

const reaped = (overrides: Partial<ReapSummary> = {}): ReapSummary => ({
  enabled: true,
  terminalsClosed: [],
  terminalsFailed: 0,
  processesKilled: [],
  processesFailed: 0,
  worktreesSkipped: [],
  ...overrides,
});

describe("describeReap", () => {
  it("says nothing when nothing happened", () => {
    expect(describeReap(reaped())).toBeNull();
  });

  it("names what it stopped", () => {
    expect(
      describeReap(
        reaped({
          terminalsClosed: [{ terminalId: "t", title: "pnpm dev" }],
          processesKilled: [{ pid: 1, command: "node vite" }],
        }),
      ),
    ).toEqual({
      tone: "info",
      title: "Stopped 2 leftover processes",
      description: "pnpm dev\nnode vite",
    });
  });

  it("warns about a worktree it left running", () => {
    const report = describeReap(
      reaped({ worktreesSkipped: [{ path: "/w/app", reason: "unreachable" }] }),
    );
    expect(report?.tone).toBe("warning");
    expect(report?.description).toContain("could not be reached");
  });

  it("says a timed-out sweep may have stopped some processes", () => {
    const report = describeReap(
      reaped({ worktreesSkipped: [{ path: "/w/app", reason: "timed-out" }] }),
    );
    expect(report?.tone).toBe("warning");
    expect(report?.description).toBe(
      "Timed out sweeping /w/app; some processes may have stopped.",
    );
  });
});
