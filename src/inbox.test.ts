import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import {
  childrenOf,
  filterByProject,
  hideChildrenOfVisibleParents,
  parentOf,
  partitionPinned,
  searchThreadsByTitle,
  sortByAttentionDescending,
  threadDisplayTitle,
  visibleInboxThreads,
} from "./inbox";

function thread(
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id: "thr_1",
    projectId: "proj_1",
    title: "A thread",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  };
}

describe("sortByAttentionDescending", () => {
  it("puts the most recently needed thread first", () => {
    const ordered = sortByAttentionDescending([
      thread({ id: "a", latestAttentionAt: 1 }),
      thread({ id: "b", latestAttentionAt: 3 }),
      thread({ id: "c", latestAttentionAt: 2 }),
    ]);
    expect(ordered.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  // The one rule that beats the clock: a thread with a question on screen is
  // the only thread the user cannot make progress anywhere else without.
  it("floats a blocked thread above every timestamp", () => {
    const ordered = sortByAttentionDescending([
      thread({ id: "fresh", latestAttentionAt: 9_000 }),
      thread({
        id: "blocked",
        latestAttentionAt: 1,
        hasPendingInteraction: true,
      }),
    ]);
    expect(ordered.map((t) => t.id)).toEqual(["blocked", "fresh"]);
  });

  // A parent's own attention time is stale while the work happens on rows the
  // flat list does not show, so busy is a tier rather than a bonus.
  it("floats a busy thread above quieter ones but below a blocked one", () => {
    const ordered = sortByAttentionDescending(
      [
        thread({ id: "fresh", latestAttentionAt: 9_000 }),
        thread({ id: "busy", latestAttentionAt: 1 }),
        thread({
          id: "blocked",
          latestAttentionAt: 2,
          hasPendingInteraction: true,
        }),
      ],
      (candidate) => candidate.id === "busy",
    );
    expect(ordered.map((t) => t.id)).toEqual(["blocked", "busy", "fresh"]);
  });

  it("ranks two busy threads by attention time", () => {
    const ordered = sortByAttentionDescending(
      [
        thread({ id: "older", latestAttentionAt: 1 }),
        thread({ id: "newer", latestAttentionAt: 5 }),
      ],
      () => true,
    );
    expect(ordered.map((t) => t.id)).toEqual(["newer", "older"]);
  });

  it("ranks two blocked threads by attention time", () => {
    const ordered = sortByAttentionDescending([
      thread({
        id: "older",
        hasPendingInteraction: true,
        latestAttentionAt: 1,
      }),
      thread({
        id: "newer",
        hasPendingInteraction: true,
        latestAttentionAt: 2,
      }),
    ]);
    expect(ordered.map((t) => t.id)).toEqual(["newer", "older"]);
  });

  // Creation time no longer decides anything, and a thread that was touched
  // long after it was created has to rise.
  it("ignores creation time", () => {
    const ordered = sortByAttentionDescending([
      thread({ id: "old-but-active", createdAt: 1, latestAttentionAt: 9 }),
      thread({ id: "new-but-quiet", createdAt: 9, latestAttentionAt: 1 }),
    ]);
    expect(ordered.map((t) => t.id)).toEqual([
      "old-but-active",
      "new-but-quiet",
    ]);
  });

  // A total order, so the same set renders in the same order every time no
  // matter how the host happened to hand it over.
  it("breaks ties on id so the order is stable", () => {
    const input = [
      thread({ id: "b", latestAttentionAt: 5 }),
      thread({ id: "a", latestAttentionAt: 5 }),
      thread({ id: "c", latestAttentionAt: 5 }),
    ];
    expect(sortByAttentionDescending(input).map((t) => t.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(
      sortByAttentionDescending([...input].reverse()).map((t) => t.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("does not mutate its input", () => {
    const input = [
      thread({ id: "a", latestAttentionAt: 1 }),
      thread({ id: "b", latestAttentionAt: 2 }),
    ];
    sortByAttentionDescending(input);
    expect(input.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("threadDisplayTitle", () => {
  it("prefers the title, then the fallback, then a placeholder", () => {
    expect(threadDisplayTitle(thread({ title: "Real" }))).toBe("Real");
    expect(
      threadDisplayTitle(thread({ title: null, titleFallback: "Fallback" })),
    ).toBe("Fallback");
    expect(
      threadDisplayTitle(thread({ title: null, titleFallback: null })),
    ).toBe("Untitled thread");
  });

  it("treats a whitespace-only title as absent", () => {
    expect(
      threadDisplayTitle(thread({ title: "   ", titleFallback: "Fallback" })),
    ).toBe("Fallback");
  });
});

describe("searchThreadsByTitle", () => {
  it("matches case-insensitively on the visible title", () => {
    const threads = [
      thread({ id: "a", title: "Sidebar work" }),
      thread({ id: "b", title: "Something else" }),
      thread({ id: "c", title: null, titleFallback: "sidebar fallback" }),
    ];
    expect(searchThreadsByTitle(threads, "SIDEBAR").map((t) => t.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("returns everything for a blank query", () => {
    const threads = [thread({ id: "a" }), thread({ id: "b" })];
    expect(searchThreadsByTitle(threads, "   ")).toHaveLength(2);
  });
});

describe("filtering", () => {
  it("scopes to one project, or to all", () => {
    const threads = [
      thread({ id: "a", projectId: "p1" }),
      thread({ id: "b", projectId: "p2" }),
    ];
    expect(filterByProject(threads, "p1").map((t) => t.id)).toEqual(["a"]);
    expect(filterByProject(threads, null)).toHaveLength(2);
  });

  it("drops archived threads", () => {
    const threads = [
      thread({ id: "a" }),
      thread({ id: "b", isArchived: true }),
    ];
    expect(visibleInboxThreads(threads).map((t) => t.id)).toEqual(["a"]);
  });

  it("splits pinned from the rest, keeping order", () => {
    const { pinned, inbox } = partitionPinned([
      thread({ id: "a" }),
      thread({ id: "b", isPinned: true }),
      thread({ id: "c" }),
    ]);
    expect(pinned.map((t) => t.id)).toEqual(["b"]);
    expect(inbox.map((t) => t.id)).toEqual(["a", "c"]);
  });
});

describe("child threads", () => {
  it("hides a child whose parent is on screen", () => {
    const visible = hideChildrenOfVisibleParents([
      thread({ id: "parent" }),
      thread({ id: "child", parentThreadId: "parent" }),
    ]);
    expect(visible.map((t) => t.id)).toEqual(["parent"]);
  });

  // An orphan must stay visible: hidden here AND absent from any header chip
  // would make it unreachable everywhere.
  it("keeps a child whose parent is not on screen", () => {
    const visible = hideChildrenOfVisibleParents([
      thread({ id: "child", parentThreadId: "archived-parent" }),
    ]);
    expect(visible.map((t) => t.id)).toEqual(["child"]);
  });

  it("lists a thread's children oldest first", () => {
    const children = childrenOf(
      [
        thread({ id: "parent" }),
        thread({ id: "b", parentThreadId: "parent", createdAt: 20 }),
        thread({ id: "a", parentThreadId: "parent", createdAt: 10 }),
        thread({ id: "other", parentThreadId: "elsewhere" }),
      ],
      "parent",
    );
    expect(children.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("parentOf", () => {
  // The list hides an archived parent, but the child's header must still get
  // it back — otherwise the child is a dead end.
  it("finds a parent the inbox filters out", () => {
    const parent = parentOf(
      [
        thread({ id: "parent", isArchived: true, projectId: "other" }),
        thread({ id: "child", parentThreadId: "parent" }),
      ],
      "child",
    );
    expect(parent?.id).toBe("parent");
  });

  it("returns null for a root thread", () => {
    expect(parentOf([thread({ id: "root" })], "root")).toBeNull();
  });

  it("returns null when the parent row is gone", () => {
    const threads = [thread({ id: "child", parentThreadId: "deleted" })];
    expect(parentOf(threads, "child")).toBeNull();
  });
});
