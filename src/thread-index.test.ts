import { describe, expect, it } from "vitest";
import {
  archiveTreeOf,
  buildThreadIndex,
  isThreadWorking,
  isTurnLive,
  type IndexedThread,
} from "./thread-index";

const thread = (overrides: Partial<IndexedThread> & { id: string }): IndexedThread => ({
  status: "idle",
  parentThreadId: null,
  lifecycleOwnerThreadId: null,
  sourceThreadId: null,
  visibility: "visible",
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

describe("archiveTreeOf", () => {
  // bb's archive walks three links, not one. A dependent the sweep did not
  // see would be archived — and its run stopped — without being checked.
  it("follows children, owned lifetimes and hidden spin-offs, deepest first", () => {
    const index = buildThreadIndex([
      thread({ id: "root" }),
      thread({ id: "kid", parentThreadId: "root" }),
      thread({ id: "grandkid", parentThreadId: "kid" }),
      thread({ id: "owned", lifecycleOwnerThreadId: "root" }),
      thread({ id: "spinoff", sourceThreadId: "root", visibility: "hidden" }),
      // A visible fork is the user's own thread, not something archive takes.
      thread({ id: "fork", sourceThreadId: "root", visibility: "visible" }),
    ]);
    const tree = archiveTreeOf(index, "root");
    expect(new Set(tree)).toEqual(new Set(["root", "kid", "grandkid", "owned", "spinoff"]));
    expect(tree.indexOf("grandkid")).toBeLessThan(tree.indexOf("kid"));
    expect(tree.at(-1)).toBe("root");
  });

  it("survives a cycle", () => {
    const index = buildThreadIndex([
      thread({ id: "a", parentThreadId: "b" }),
      thread({ id: "b", parentThreadId: "a" }),
    ]);
    expect(archiveTreeOf(index, "a").sort()).toEqual(["a", "b"]);
  });
});
