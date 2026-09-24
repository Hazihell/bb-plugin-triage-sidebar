import { describe, expect, it } from "vitest";
import {
  forEachLimited,
  isRunningStatus,
  readNewestTurnRows,
  timingFromRows,
  type TurnEventLog,
  type TurnEventRow,
} from "./turn-timing";

const row = (
  seq: number,
  createdAt: number,
  type: "turn/started" | "turn/completed",
): TurnEventRow => ({ seq, createdAt, type });

describe("timingFromRows", () => {
  it("reads an idle thread's end and no start", () => {
    expect(
      timingFromRows(
        { started: row(1, 10, "turn/started"), completed: row(2, 20, "turn/completed") },
        false,
      ),
    ).toEqual({ startedWorkingAt: null, lastRunEndedAt: 20 });
  });

  it("reads a running thread's start and its previous end", () => {
    expect(
      timingFromRows(
        { started: row(3, 30, "turn/started"), completed: row(2, 20, "turn/completed") },
        true,
      ),
    ).toEqual({ startedWorkingAt: 30, lastRunEndedAt: 20 });
  });

  // Same millisecond, different turns: the sequence decides, not the clock.
  it("orders rows by sequence rather than timestamp", () => {
    expect(
      timingFromRows(
        { started: row(3, 20, "turn/started"), completed: row(2, 20, "turn/completed") },
        true,
      ).startedWorkingAt,
    ).toBe(20);
  });

  // A start with no end, on a thread bb says is idle, lost its completion. A
  // timer counting from it would count forever.
  it("ignores an unfinished start on a thread that is not running", () => {
    expect(
      timingFromRows({ started: row(1, 10, "turn/started"), completed: null }, false),
    ).toEqual({ startedWorkingAt: null, lastRunEndedAt: null });
  });
});

describe("isRunningStatus", () => {
  it("treats idle, failed and never-started threads as not running", () => {
    expect(isRunningStatus("idle")).toBe(false);
    expect(isRunningStatus("error")).toBe(false);
    expect(isRunningStatus("pending")).toBe(false);
    expect(isRunningStatus("active")).toBe(true);
    expect(isRunningStatus("starting")).toBe(true);
    expect(isRunningStatus("stopping")).toBe(true);
  });
});

describe("readNewestTurnRows", () => {
  const logOf = (pages: TurnEventRow[][]) => {
    const calls: unknown[] = [];
    const log: TurnEventLog = {
      list: async (args) => {
        calls.push(args);
        return pages.shift() ?? [];
      },
      wait: async () => null,
    };
    return { log, calls };
  };

  it("reads both rows in one call when turns alternate", async () => {
    const { log, calls } = logOf([
      [row(4, 40, "turn/started"), row(3, 30, "turn/completed")],
    ]);
    expect(await readNewestTurnRows(log, "thr")).toEqual({
      started: row(4, 40, "turn/started"),
      completed: row(3, 30, "turn/completed"),
    });
    expect(calls).toHaveLength(1);
  });

  it("asks for the completion alone when two starts are on top", async () => {
    const { log, calls } = logOf([
      [row(5, 50, "turn/started"), row(4, 40, "turn/started")],
      [row(2, 20, "turn/completed")],
    ]);
    expect((await readNewestTurnRows(log, "thr")).completed).toEqual(
      row(2, 20, "turn/completed"),
    );
    expect(calls).toHaveLength(2);
  });

  it("makes one call for a thread with a single turn row", async () => {
    const { log, calls } = logOf([[row(1, 10, "turn/started")]]);
    expect(await readNewestTurnRows(log, "thr")).toEqual({
      started: row(1, 10, "turn/started"),
      completed: null,
    });
    expect(calls).toHaveLength(1);
  });
});

describe("forEachLimited", () => {
  it("never runs more than the limit at once, and runs everything", async () => {
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];
    await forEachLimited([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      done.push(item);
    });
    expect(peak).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
