import { describe, expect, it } from "vitest";
import {
  backgroundWakeFromRows,
  forEachLimited,
  isRunningStatus,
  readNewestTurnRows,
  readStartedTiming,
  readTurnTiming,
  timingFromRows,
  type TurnEventLog,
  type TurnEventRow,
} from "./turn-timing";

const row = (
  seq: number,
  createdAt: number,
  type: "turn/started" | "turn/completed",
): TurnEventRow => ({ seq, createdAt, type });

describe("backgroundWakeFromRows", () => {
  const row = (seq: number, type: string) => ({ seq, createdAt: seq, type });

  it("reads a turn with no input, right after a background task ended, as a wake", () => {
    expect(
      backgroundWakeFromRows([
        row(5, "turn/started"),
        row(4, "item/backgroundTask/completed"),
        row(2, "turn/input/accepted"),
      ]),
    ).toBe(true);
  });

  it("reads a turn bb started with input as the thread's own", () => {
    expect(
      backgroundWakeFromRows([
        row(6, "turn/input/accepted"),
        row(5, "turn/started"),
        row(4, "item/backgroundTask/completed"),
      ]),
    ).toBe(false);
  });

  it("needs the background task's end right before the start", () => {
    expect(
      backgroundWakeFromRows([row(5, "turn/started"), row(3, "turn/input/accepted")]),
    ).toBe(false);
    expect(backgroundWakeFromRows([])).toBe(false);
  });
});

describe("timingFromRows", () => {
  it("reads an idle thread's end and no start", () => {
    expect(
      timingFromRows(
        { started: row(1, 10, "turn/started"), completed: row(2, 20, "turn/completed") },
        false,
      ),
    ).toEqual({ startedWorkingAt: null, lastRunEndedAt: 20, endedStartSeq: 1 });
  });

  it("reads a running thread's start and its previous end", () => {
    expect(
      timingFromRows(
        { started: row(3, 30, "turn/started"), completed: row(2, 20, "turn/completed") },
        true,
      ),
    ).toEqual({ startedWorkingAt: 30, lastRunEndedAt: 20, endedStartSeq: null });
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
    ).toEqual({ startedWorkingAt: null, lastRunEndedAt: null, endedStartSeq: 1 });
  });

  // The start that already stopped is not the new turn's, whatever bb's
  // status says: that start is hours old.
  it("never reads a start known to have stopped as the turn in flight", () => {
    expect(
      timingFromRows({ started: row(7, 10, "turn/started"), completed: null }, true, 7)
        .startedWorkingAt,
    ).toBeNull();
  });
});

describe("readStartedTiming", () => {
  it("waits past a stopped start for the new turn's own row", async () => {
    const waits: unknown[] = [];
    const log: TurnEventLog = {
      list: async () => [row(7, 10, "turn/started"), row(5, 5, "turn/completed")],
      wait: async (args) => {
        waits.push(args.afterSeq);
        return row(9, 900, "turn/started");
      },
    };
    const timing = await readStartedTiming(log, "thr", { endedStartSeq: 7 });
    expect(waits).toEqual(["7"]);
    expect(timing.startedWorkingAt).toBe(900);
  });
});

describe("readTurnTiming", () => {
  // The status is asked for only when the log shows a turn in flight, and at
  // that moment — never taken from a list read before the log was.
  it("asks for the status only when the log shows a turn in flight", async () => {
    let asked = 0;
    const status = async () => {
      asked += 1;
      return "idle";
    };
    const idleLog: TurnEventLog = {
      list: async () => [row(2, 20, "turn/completed"), row(1, 10, "turn/started")],
      wait: async () => null,
    };
    await readTurnTiming(idleLog, "thr", status);
    expect(asked).toBe(0);

    const openLog: TurnEventLog = {
      list: async () => [row(3, 30, "turn/started"), row(2, 20, "turn/completed")],
      wait: async () => null,
    };
    const timing = await readTurnTiming(openLog, "thr", status);
    expect(asked).toBe(1);
    // bb says idle now, so the open start lost its completion.
    expect(timing).toEqual({ startedWorkingAt: null, lastRunEndedAt: 20, endedStartSeq: 3 });
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
