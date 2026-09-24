import { describe, expect, it } from "vitest";
import {
  buildThreadIndex,
  isThreadWorking,
  isTurnLive,
  type IndexedThread,
} from "./thread-index";

const thread = (overrides: Partial<IndexedThread> & { id: string }): IndexedThread => ({
  status: "idle",
  parentThreadId: null,
  environmentId: null,
  environmentHostId: null,
  environmentPath: null,
  environmentIsWorktree: null,
  hasPendingInteraction: false,
  latestAttentionAt: 0,
  lastReadAt: null,
  title: null,
  titleFallback: null,
  activity: {
    activeBackgroundAgentCount: 0,
    activeBackgroundCommandCount: 0,
    activeGoalCount: 0,
    activePlanModeCount: 0,
    activeWorkflowCount: 0,
  },
  ...overrides,
});

describe("isTurnLive", () => {
  it("reads a running status or runtime, and background agents", () => {
    expect(isTurnLive(thread({ id: "a", status: "active" }))).toBe(true);
    expect(isTurnLive(thread({ id: "a", runtime: { displayStatus: "provisioning" } }))).toBe(true);
    expect(
      isTurnLive(
        thread({
          id: "a",
          activity: { ...thread({ id: "x" }).activity, activeBackgroundAgentCount: 1 },
        }),
      ),
    ).toBe(true);
    expect(isTurnLive(thread({ id: "a" }))).toBe(false);
  });

  // A sibling's plan mode or goal has no process to kill under; it does not
  // make the worktree off-limits to the reap.
  it("does not count activity that runs no turn", () => {
    expect(
      isTurnLive(
        thread({
          id: "a",
          activity: { ...thread({ id: "x" }).activity, activePlanModeCount: 1, activeGoalCount: 1 },
        }),
      ),
    ).toBe(false);
  });
});

describe("isThreadWorking", () => {
  // Every kind the sidebar counts, so the sweep and the sidebar agree.
  it("counts every kind of activity the sidebar counts", () => {
    for (const key of [
      "activeBackgroundCommandCount",
      "activeGoalCount",
      "activePlanModeCount",
      "activeWorkflowCount",
    ] as const) {
      expect(
        isThreadWorking(
          thread({ id: "a", activity: { ...thread({ id: "x" }).activity, [key]: 1 } }),
        ),
      ).toBe(true);
    }
  });
});

describe("buildThreadIndex", () => {
  it("answers lookups and children from one list", () => {
    const index = buildThreadIndex([
      thread({ id: "root" }),
      thread({ id: "kid", parentThreadId: "root" }),
    ]);
    expect(index.get("kid")?.parentThreadId).toBe("root");
    expect(index.childrenOf("root").map((child) => child.id)).toEqual(["kid"]);
    expect(index.childrenOf("kid")).toEqual([]);
  });
});
