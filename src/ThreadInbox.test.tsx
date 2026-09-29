// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { resolveSnoozePresets } from "./lifecycle";
import type { ProviderRecord } from "./ProviderGlyph";
import { sidebarThread, sidebarProject } from "./test-fixtures";
import { snapshotKey } from "./local-snapshot";
import { AVATAR_SNAPSHOT, LIFECYCLE_SNAPSHOT } from "./snapshot-schemas";

const LIFECYCLE_KEY = snapshotKey("lifecycle", LIFECYCLE_SNAPSHOT);

// Load through the harness so the plugin's `@get-bb/plugin-sdk/app` import binds
// to the test runtime; importing the component directly would bind it to an
// empty runtime first.
const app = await loadPluginApp(() => import("../app"));
const inbox = app.threadLists[0]!;

const thread = sidebarThread;

const listProps = {
  activeThreadId: null,
  activeProjectId: null,
  isCompactViewport: false,
  onNavigate: () => {},
  searchQuery: "",
};

/** A lifecycle row that says only when the thread's newest turn ended. */
function endedRow(threadId: string, lastRunEndedAt: number) {
  return {
    threadId,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    startedWorkingAt: null,
    lastRunEndedAt,
    quietAttentionAt: null,
  };
}

/** Three hours and a minute ago: comfortably "3h" whatever the clock says. */
const THREE_HOURS_AGO = () => Date.now() - (3 * 3_600_000 + 60_000);

function render(
  threads: PluginSidebarThread[],
  projects = [sidebarProject("proj_1", "bb")],
  turnEnds: Record<string, number> = {},
) {
  return renderSlot(inbox, listProps, {
    sidebarThreads: { status: "ready", threads, projects },
    // The lifecycle store is the plugin's own backend; one with no parking
    // state means every thread is active, which is what these list tests are
    // about. It also carries the idle clock, so a test that reads an age
    // hands in when the thread's last turn ended.
    rpc: {
      listLifecycle: () => ({
        epoch: "test",
        seq: 0,
        rows: Object.entries(turnEnds).map(([id, at]) => endedRow(id, at)),
      }),
    },
  });
}

afterEach(cleanup);

/**
 * The list proper, once the parking store has been read: until then a first
 * launch shows a skeleton rather than rows it cannot yet rank.
 */
async function listReady(): Promise<void> {
  await waitFor(() =>
    expect(screen.queryByRole("status", { name: "Loading threads" })).toBeNull(),
  );
}

// The anchor is a full-bleed overlay, so the row containers carry the text.
function rowTitles(): string[] {
  return screen.getAllByRole("listitem").map((row) => row.textContent ?? "");
}

describe("triage-sidebar registration", () => {
  it("registers exactly one thread list", () => {
    expect(app.threadLists).toHaveLength(1);
    expect(inbox.id).toBe("inbox");
  });
});

describe("ThreadInbox", () => {
  it("lists the most recently needed thread first", async () => {
    render([
      thread({ id: "a", title: "Quiet", latestAttentionAt: 1 }),
      thread({ id: "b", title: "Touched", latestAttentionAt: 2 }),
    ]);
    await listReady();
    expect(rowTitles()[0]).toContain("Touched");
    expect(rowTitles()[1]).toContain("Quiet");
  });

  // The sort's headline promise, end to end: a question waiting for an answer
  // outranks a thread that was busy seconds ago.
  it("floats a thread blocked on the user to the top", async () => {
    render([
      thread({ id: "a", title: "Busy", latestAttentionAt: 9_000 }),
      thread({
        id: "b",
        title: "Asking",
        latestAttentionAt: 1,
        hasPendingInteraction: true,
      }),
    ]);
    await listReady();
    expect(rowTitles()[0]).toContain("Asking");
  });

  // The DOM contract behind numbered thread shortcuts and thread.next/previous.
  // A plugin that drops these attributes silently breaks nine host shortcuts.
  it("marks every row as a host shortcut target", async () => {
    render([thread({ id: "thr_x" })]);
    await listReady();
    const row = screen.getByRole("link");
    expect(row.hasAttribute("data-sidebar-thread-shortcut-target")).toBe(true);
    expect(row.getAttribute("data-sidebar-thread-id")).toBe("thr_x");
  });

  it("opens a thread on click and closes the mobile drawer", async () => {
    let navigated = 0;
    const rendered = renderSlot(
      inbox,
      { ...listProps, onNavigate: () => (navigated += 1) },
      {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "thr_open" })],
          projects: [sidebarProject("proj_1", "bb")],
        },
        rpc: { listLifecycle: () => ({ epoch: "test", seq: 0, rows: [] }) },
      },
    );
    await listReady();
    await listReady();
    await listReady();
    const link = screen.getByRole("link");
    // A real link: the host routes the plain click in place, so the row lets
    // it through rather than opening the thread itself. The host's router is
    // a bubbling document listener that cancels the click it routes; this one
    // stands in for it, so jsdom never tries to navigate, and records whether
    // the row had already cancelled the click before the router saw it.
    let cancelledByRow: boolean | null = null;
    const router = (event: MouseEvent) => {
      cancelledByRow = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", router);
    try {
      expect(link.getAttribute("href")).toBe(
        "/projects/proj_1/threads/thr_open",
      );
      fireEvent.click(link);
    } finally {
      document.removeEventListener("click", router);
    }
    expect(cancelledByRow).toBe(false);
    expect(rendered.sidebarActionCalls).toEqual([]);
    expect(navigated).toBe(1);
  });

  it("opens in a split with the platform modifier held", async () => {
    const rendered = render([thread({ id: "thr_split" })]);
    await listReady();
    expect(fireEvent.click(screen.getByRole("link"), { metaKey: true })).toBe(
      false,
    );
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "thr_split",
      options: { split: true },
    });
  });

  it("separates pinned threads from the inbox", async () => {
    render([
      thread({ id: "a", title: "Plain" }),
      thread({ id: "b", title: "Stuck", isPinned: true }),
    ]);
    await listReady();
    const pinned = screen.getByRole("region", { name: /pinned/i });
    expect(within(pinned).getByText("Stuck")).toBeDefined();
  });

  // Search moved to the host's quick palette, and the prop that carried the
  // old field's text is always "". A stale value must not hide rows.
  it("ignores the deprecated search query", async () => {
    renderSlot(
      inbox,
      { ...listProps, searchQuery: "sidebar" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "a", title: "Sidebar work" }),
            thread({ id: "b", title: "Something else" }),
          ],
          projects: [sidebarProject("proj_1", "bb")],
        },
        rpc: { listLifecycle: () => ({ epoch: "test", seq: 0, rows: [] }) },
      },
    );
    await listReady();
    await listReady();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("ships no search field of its own", async () => {
    render([thread({ id: "a" })]);
    await listReady();
    expect(screen.queryByLabelText("Search threads")).toBeNull();
  });

  it("ships no new-thread button of its own", async () => {
    render([thread({ id: "a" })]);
    await listReady();
    expect(screen.queryByLabelText("New thread")).toBeNull();
  });

  it("scopes to one project", async () => {
    render(
      [
        thread({ id: "a", title: "In bb", projectId: "proj_1" }),
        thread({ id: "b", title: "In other", projectId: "proj_2" }),
      ],
      [
        sidebarProject("proj_1", "bb"),
        sidebarProject("proj_2", "other"),
      ],
    );
    await listReady();
    // Radix opens on keyboard too, which jsdom can drive without pointer
    // capture. Enter opens the list; the option click picks the scope.
    fireEvent.keyDown(screen.getByLabelText(/Project scope/), { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "other" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("In other")).toBeDefined();
  });

  it("hides archived threads", async () => {
    render([thread({ id: "a", isArchived: true })]);
    await listReady();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("reports an empty inbox", async () => {
    render([]);
    await listReady();
    expect(screen.getByText("No threads yet")).toBeDefined();
  });
});

describe("parking threads", () => {
  it("moves a settled thread to the Settled shelf", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_done", title: "Finished work" })],
        projects: [sidebarProject("proj_1", "bb")],
      },
      rpc: {
        listLifecycle: () => ({
          epoch: "test",
          seq: 0,
          rows: [
            {
              threadId: "thr_done",
              settledAt: 200,
              snoozedUntil: null,
              snoozedAt: null,
            },
          ],
        }),
      },
    });
    // The shelf renders once the lifecycle read resolves.
    const shelf = await screen.findByRole("region", { name: "Settled" });
    expect(within(shelf).getByText(/Settled \(1\)/)).toBeDefined();
    // Collapsed by default: parked work is out of the way, never gone.
    expect(screen.queryByText("Finished work")).toBeNull();
    fireEvent.click(within(shelf).getByRole("button"));
    expect(within(shelf).getByText("Finished work")).toBeDefined();
  });

  it("keeps a working thread out of the shelves and offers no park action", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "thr_busy",
            title: "Still running",
            status: "active",
            indicator: "runtime",
            activity: {
              workflows: 0,
              backgroundAgents: 0,
              backgroundCommands: 0,
              planMode: 0,
              goals: 0,
            },
          }),
        ],
        projects: [sidebarProject("proj_1", "bb")],
      },
      // Settled in the store, but still working: it must stay visible.
      rpc: {
        listLifecycle: () => ({
          epoch: "test",
          seq: 0,
          rows: [
            {
              threadId: "thr_busy",
              settledAt: 200,
              snoozedUntil: null,
              snoozedAt: null,
            },
          ],
        }),
      },
    });
    expect(await screen.findByText("Still running")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Settled" })).toBeNull();
    expect(screen.queryByLabelText("Settle thread")).toBeNull();
  });

  const activityOf = (counts: Partial<PluginSidebarThread["activity"]>) => ({
    workflows: 0,
    backgroundAgents: 0,
    backgroundCommands: 0,
    planMode: 0,
    goals: 0,
    ...counts,
  });

  function renderSettled(threads: PluginSidebarThread[]) {
    return renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads,
        projects: [sidebarProject("proj_1", "bb")],
      },
      rpc: {
        listLifecycle: () => ({
          epoch: "test",
          seq: 0,
          rows: threads.map((t) => ({
            threadId: t.id,
            settledAt: t.latestAttentionAt + 1,
            snoozedUntil: null,
            snoozedAt: null,
          })),
        }),
      },
    });
  }

  // A dev server left running after the turn does not pull a settled thread
  // back: settling is how the user stops it. Its glyph stays on the row.
  it("keeps a thread whose background command runs on the Settled shelf", async () => {
    renderSettled([
      thread({
        id: "thr_cmd",
        title: "Dev server left up",
        indicator: "background-command",
        indicatorLabel: "Background command running",
        activity: activityOf({ backgroundCommands: 1 }),
      }),
    ]);
    const shelf = await screen.findByRole("region", { name: "Settled" });
    expect(within(shelf).getByText(/Settled \(1\)/)).toBeDefined();
    fireEvent.click(within(shelf).getByRole("button"));
    expect(within(shelf).getByText("Dev server left up")).toBeDefined();
    expect(
      within(shelf).getByLabelText("Background command running"),
    ).toBeDefined();
  });

  // A child's background command does not block its parent either, even if
  // bb rolls it up into the parent's "runtime" indicator: parking reads the
  // activity counts, never the indicator.
  it("lets a parent settle while its child's background command runs", async () => {
    render([
      thread({
        id: "thr_par",
        title: "Parent",
        indicator: "runtime",
        indicatorLabel: "Thread working",
      }),
      thread({
        id: "thr_kid",
        title: "Child",
        parentThreadId: "thr_par",
        activity: activityOf({ backgroundCommands: 1 }),
      }),
    ]);
    await listReady();
    expect(screen.getByLabelText("Settle thread")).toBeDefined();
  });

  it("still keeps a thread with a background agent off the shelves", async () => {
    renderSettled([
      thread({
        id: "thr_agent",
        title: "Agent still out",
        indicator: "background-agent",
        indicatorLabel: "Background agent running",
        activity: activityOf({ backgroundAgents: 1 }),
      }),
    ]);
    expect(await screen.findByText("Agent still out")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Settled" })).toBeNull();
    expect(screen.queryByLabelText("Settle thread")).toBeNull();
  });

  it("offers settle and snooze on a parkable thread", async () => {
    render([thread({ id: "thr_park", title: "Quiet" })]);
    // Rendered (not merely accepted as props): a card whose park controls
    // never mount leaves the whole feature unreachable.
    expect(await screen.findByLabelText("Settle thread")).toBeDefined();
    expect(screen.getByLabelText("Snooze")).toBeDefined();
  });

  // One preset is the wrong answer half the day; the strip offers them all.
  it("snoozes to the preset the user picks from the strip", async () => {
    let snoozedUntil: number | null = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_park", title: "Quiet" })],
        projects: [sidebarProject("proj_1", "bb")],
      },
      rpc: {
        listLifecycle: () => ({ epoch: "test", seq: 0, rows: [] }),
        snooze: (input) => {
          snoozedUntil = (input as { snoozedUntil: number }).snoozedUntil;
          return { ok: true };
        },
      },
    });
    fireEvent.keyDown(await screen.findByLabelText("Snooze"), { key: "Enter" });
    const menu = await screen.findByRole("menu", { name: "Snooze" });
    const presets = resolveSnoozePresets(new Date());
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(presets.map((preset) => preset.label));
    // Portaled out of the list, but still inside the plugin's style scope.
    expect(menu.closest("[data-bb-plugin-root]")).not.toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Next week" }));
    await waitFor(() =>
      expect(snoozedUntil).toBe(
        presets.find((preset) => preset.id === "next-week")!.snoozedUntil,
      ),
    );
  });

  it("settles a thread when the user clicks Settle", async () => {
    let settled: string | null = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_park", title: "Quiet" })],
        projects: [sidebarProject("proj_1", "bb")],
      },
      rpc: {
        listLifecycle: () => ({ epoch: "test", seq: 0, rows: [] }),
        settle: (input) => {
          settled = (input as { threadId: string }).threadId;
          return { ok: true };
        },
      },
    });
    fireEvent.click(await screen.findByLabelText("Settle thread"));
    await waitFor(() => expect(settled).toBe("thr_park"));
  });

  it("shows the wake countdown on a snoozed row", async () => {
    // Just under two hours, as a fresh two-hour snooze is a moment later.
    // The list's clock is floored to the minute; read from it, this would
    // round up to "3h".
    const wakeAt = Date.now() + 2 * 60 * 60 * 1000 - 5_000;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_snz", title: "Later" })],
        projects: [sidebarProject("proj_1", "bb")],
      },
      rpc: {
        listLifecycle: () => ({
          epoch: "test",
          seq: 0,
          rows: [
            {
              threadId: "thr_snz",
              settledAt: null,
              snoozedUntil: wakeAt,
              snoozedAt: Date.now(),
            },
          ],
        }),
      },
    });
    const shelf = await screen.findByRole("region", { name: "Snoozed" });
    fireEvent.click(within(shelf).getByRole("button"));
    expect(within(shelf).getByLabelText("Wakes in 2h")).toBeDefined();
    expect(
      within(shelf).getByRole("button", { name: "Wake thread now", hidden: true }),
    ).toBeDefined();
  });
});

describe("working duration", () => {
  function renderWorking(startedWorkingAt: number | null) {
    return renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "thr_run",
            title: "Running",
            status: "active",
            indicator: "runtime",
          }),
        ],
        projects: [sidebarProject("proj_1", "bb")],
      },
      rpc: {
        listLifecycle: () => ({
          epoch: "test",
          seq: 0,
          rows: [
            {
              threadId: "thr_run",
              settledAt: null,
              snoozedUntil: null,
              snoozedAt: null,
              startedWorkingAt,
            },
          ],
        }),
      },
    });
  }

  // The one question a spinner cannot answer. Without this wiring the store
  // records the start time and nothing ever reads it.
  it("shows how long a working thread has been running", async () => {
    // Anchored to the same minute boundary the list quantizes its clock to,
    // or the label lands on either side of a bucket depending on the second
    // the test happens to run in.
    renderWorking(Math.floor(Date.now() / 60_000) * 60_000 - 7 * 60_000);
    expect(await screen.findByText("7m")).toBeDefined();
  });

  it("shows no elapsed label when the store has no start time", async () => {
    renderWorking(null);
    expect(await screen.findByText("Running")).toBeDefined();
    expect(screen.queryByText(/^\d+m$/)).toBeNull();
  });

  // The either/or rule the slot is built on: an idle row spends the slot on
  // its age, never on a duration it is not accruing.
  it("shows no elapsed label on a thread that is not working", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_idle", title: "Idle" })],
        projects: [sidebarProject("proj_1", "bb")],
      },
      rpc: {
        listLifecycle: () => ({
          epoch: "test",
          seq: 0,
          rows: [
            {
              threadId: "thr_idle",
              settledAt: null,
              snoozedUntil: null,
              snoozedAt: null,
              startedWorkingAt:
                Math.floor(Date.now() / 60_000) * 60_000 - 7 * 60_000,
            },
          ],
        }),
      },
    });
    expect(await screen.findByText("Idle")).toBeDefined();
    expect(screen.queryByText("7m")).toBeNull();
  });
});

describe("child work", () => {
  const MINUTE = 60_000;
  const parentAndChild = (
    childOverrides: Partial<PluginSidebarThread>,
  ): PluginSidebarThread[] => [
    thread({ id: "thr_parent", title: "Parent" }),
    thread({
      id: "thr_child",
      title: "Child",
      parentThreadId: "thr_parent",
      ...childOverrides,
    }),
  ];

  const runningChild = () =>
    parentAndChild({
      status: "active",
      indicator: "runtime",
      indicatorLabel: "Working",
    });

  // Seen in the live app: bb rolls a running child up into the parent's own
  // indicator. The parent is still idle — its status says so — and keeps its
  // idle age rather than a dash for a turn it is not running.
  it("keeps the parent's idle age when bb rolls the child's run up", async () => {
    render(
      [
        thread({
          id: "thr_parent",
          title: "Parent",
          indicator: "runtime",
          indicatorLabel: "Thread working",
        }),
        thread({
          id: "thr_child",
          title: "Child",
          parentThreadId: "thr_parent",
          status: "active",
          indicator: "runtime",
        }),
      ],
      undefined,
      { thr_parent: THREE_HOURS_AGO() },
    );
    expect(await screen.findByLabelText("Thread working")).toBeDefined();
    expect(screen.getByText("3h")).toBeDefined();
    expect(screen.queryByText("–")).toBeNull();
  });

  // The whole point: the child is not in the list, so without this the parent
  // is a card with nothing to say while its subagent works.
  it("spins the parent's slot while a child is running", async () => {
    render(runningChild());
    expect(await screen.findByLabelText("Child thread working")).toBeDefined();
  });

  // The spinner is the child's; the clock is the parent's own idle age. There
  // is no child clock anywhere in this sidebar.
  it("keeps the parent's idle age beside that spinner", async () => {
    render(
      runningChild(),
      undefined,
      { thr_parent: THREE_HOURS_AGO() },
    );
    expect(await screen.findByLabelText("Child thread working")).toBeDefined();
    expect(screen.getByText("3h")).toBeDefined();
  });

  it("counts running children on the parent's third line", async () => {
    render(runningChild());
    expect(await screen.findByLabelText("1 running child threads")).toBeDefined();
    expect(screen.queryByLabelText(/child threads needing you/)).toBeNull();
  });

  it("counts children that need you, with the question glyph", async () => {
    render(parentAndChild({ hasPendingInteraction: true }));
    const badge = await screen.findByLabelText("1 child threads needing you");
    expect(badge.querySelector('[data-icon="CircleQuestion"]')).not.toBeNull();
  });

  it("shows neither counter when the children are quiet", async () => {
    render(parentAndChild({}));
    expect(await screen.findByText("Parent")).toBeDefined();
    expect(screen.queryByLabelText(/running child threads/)).toBeNull();
    expect(screen.queryByLabelText(/child threads needing you/)).toBeNull();
  });

  // Busy is what decides parking, so the parent may not be filed away while
  // work it cannot see is still running.
  it("refuses to park a parent whose child is working", async () => {
    render(runningChild());
    expect(await screen.findByText("Parent")).toBeDefined();
    expect(screen.queryByLabelText("Settle thread")).toBeNull();
  });

  it("floats a busy parent above a quieter thread", async () => {
    render([
      thread({ id: "thr_fresh", title: "Fresh", latestAttentionAt: 9_000 }),
      thread({ id: "thr_parent", title: "Parent", latestAttentionAt: 1 }),
      thread({
        id: "thr_child",
        title: "Child",
        parentThreadId: "thr_parent",
        status: "active",
        indicator: "runtime",
        latestAttentionAt: 1,
      }),
    ]);
    await screen.findByText("Parent");
    expect(rowTitles().map((text) => text?.slice(0, 20))).toEqual([
      expect.stringContaining("Parent"),
      expect.stringContaining("Fresh"),
    ]);
  });
});

describe("the cache window", () => {
  const MINUTE = 60_000;
  /** An idle thread whose last run ended `minutes` ago, and the thresholds. */
  function renderIdle(minutes: number) {
    const minuteBoundary = Math.floor(Date.now() / MINUTE) * MINUTE;
    return renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_idle", title: "Idle" })],
        projects: [sidebarProject("proj_1", "bb")],
      },
      rpc: {
        listLifecycle: () => ({
          epoch: "test",
          seq: 0,
          rows: [
            {
              threadId: "thr_idle",
              settledAt: null,
              snoozedUntil: null,
              snoozedAt: null,
              startedWorkingAt: null,
              lastRunEndedAt: minuteBoundary - minutes * MINUTE,
            },
          ],
        }),
        getSettings: () => ({
          cacheWarnAfterMinutes: 50,
          cacheColdAfterMinutes: 60,
        }),
      },
    });
  }

  it("starts the idle age at 'now' rather than seconds", async () => {
    renderIdle(0);
    const label = await screen.findByText("now");
    expect(label.className).toContain("text-muted-foreground");
  });

  // The age is read to answer "is the cache still warm", so the answer is in
  // the colour rather than in arithmetic the user has to do.
  it("turns the idle age amber inside the warning band", async () => {
    renderIdle(55);
    const label = await screen.findByText("55m");
    expect(label.className).toContain("text-attention");
  });

  it("leaves it neutral before the band", async () => {
    renderIdle(10);
    const label = await screen.findByText("10m");
    expect(label.className).toContain("text-muted-foreground");
  });

  // Past the cold edge the window is already gone: an age that stayed amber
  // would nag about a decision there is nothing left to make.
  it("leaves it neutral once the window has lapsed", async () => {
    renderIdle(75);
    const label = await screen.findByText("1h");
    expect(label.className).toContain("text-muted-foreground");
  });

  // The idle age is this plugin's own clock. bb's updatedAt moves for a
  // retitle or a queued message, neither of which resets a prompt cache.
  it("measures from the run's end rather than bb's updatedAt", async () => {
    const minuteBoundary = Math.floor(Date.now() / MINUTE) * MINUTE;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "thr_idle", title: "Idle", updatedAt: minuteBoundary }),
        ],
        projects: [sidebarProject("proj_1", "bb")],
      },
      rpc: {
        listLifecycle: () => ({
          epoch: "test",
          seq: 0,
          rows: [
            {
              threadId: "thr_idle",
              settledAt: null,
              snoozedUntil: null,
              snoozedAt: null,
              startedWorkingAt: null,
              lastRunEndedAt: minuteBoundary - 12 * MINUTE,
            },
          ],
        }),
      },
    });
    expect(await screen.findByText("12m")).toBeDefined();
  });
});

describe("row context menu", () => {
  it("offers the plugin's own thread actions on right-click", async () => {
    render([thread({ id: "thr_menu", title: "Right click me" })]);
    const row = await screen.findByText("Right click me");
    fireEvent.contextMenu(row);
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(menu.closest("[data-bb-plugin-root]")).not.toBeNull();
    // The plugin builds this menu itself — the SDK ships no menu component —
    // so the items are this plugin's choice, backed by the action hook.
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      // Parking leads the menu: it is the one thing this sidebar does that
      // bb's own list does not.
      "Settle",
      "Snooze",
      // The project's commands, when the list knows the thread's project.
      "Project commands…",
      "Open in split",
      "Mark unread",
      "Pin",
      "Archive",
      "Delete",
    ]);
  });

  describe("long-press on touch", () => {
    afterEach(() => vi.useRealTimers());

    const press = (row: HTMLElement, moves: Array<[number, number]>) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const at = (x: number, y: number) => ({
        pointerType: "touch",
        pointerId: 1,
        isPrimary: true,
        clientX: x,
        clientY: y,
      });
      fireEvent.pointerDown(row, at(20, 20));
      for (const [x, y] of moves) fireEvent.pointerMove(row, at(x, y));
      act(() => vi.advanceTimersByTime(700));
      vi.useRealTimers();
    };

    // A held finger drifts a pixel or two; Radix alone drops the press at
    // the first move, which left the menu unreliable on a phone.
    it("opens the row menu with its park actions despite a small drift", async () => {
      render([thread({ id: "thr_lp", title: "Hold me" })]);
      press(await screen.findByText("Hold me"), [
        [22, 21],
        [26, 27],
      ]);
      const menu = await screen.findByRole("menu", { name: "Thread actions" });
      const items = within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent);
      expect(items).toContain("Settle");
      expect(items).toContain("Snooze");
    });

    // The menu opens under the finger, so the click that ends the press
    // lands on an item. It must not settle the thread the user only held.
    it("ignores the release click, then takes a deliberate tap", async () => {
      let settled: string | null = null;
      renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "thr_rel", title: "Held" })],
          projects: [sidebarProject("proj_1", "bb")],
        },
        rpc: {
          listLifecycle: () => ({ epoch: "test", seq: 0, rows: [] }),
          settle: (input) => {
            settled = (input as { threadId: string }).threadId;
            return { ok: true };
          },
        },
      });
      press(await screen.findByText("Held"), []);
      const menu = await screen.findByRole("menu", { name: "Thread actions" });
      const settle = within(menu).getByText("Settle");
      fireEvent.click(settle);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBeNull();
      expect(screen.getByRole("menu", { name: "Thread actions" })).toBeDefined();

      fireEvent.pointerDown(settle, { pointerType: "touch", isPrimary: true });
      fireEvent.click(settle);
      await waitFor(() => expect(settled).toBe("thr_rel"));
    });

    it("leaves a moving finger to scroll", async () => {
      render([thread({ id: "thr_sc", title: "Scroll past" })]);
      press(await screen.findByText("Scroll past"), [[20, 40]]);
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });

  // The mobile route: a touch device draws no settle or snooze on the card,
  // so the items below, opened by long-press, are the only park route there.
  it("parks a thread from the menu", async () => {
    let settled: string | null = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_park", title: "Park me" })],
        projects: [sidebarProject("proj_1", "bb")],
      },
      rpc: {
        listLifecycle: () => ({ epoch: "test", seq: 0, rows: [] }),
        settle: (input) => {
          settled = (input as { threadId: string }).threadId;
          return { ok: true };
        },
      },
    });
    fireEvent.contextMenu(await screen.findByText("Park me"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    fireEvent.click(within(menu).getByText("Settle"));
    await waitFor(() => expect(settled).toBe("thr_park"));
  });

  // The desktop gap: the card has room for ONE preset ("tomorrow"), and the
  // other three are unreachable without this submenu.
  it("offers every snooze preset in the submenu", async () => {
    let snoozedUntil: number | null = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_snz", title: "Later please" })],
        projects: [sidebarProject("proj_1", "bb")],
      },
      rpc: {
        listLifecycle: () => ({ epoch: "test", seq: 0, rows: [] }),
        snooze: (input) => {
          snoozedUntil = (input as { snoozedUntil: number }).snoozedUntil;
          return { ok: true };
        },
      },
    });
    fireEvent.contextMenu(await screen.findByText("Later please"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    // Keyboard rather than hover: Radix opens a submenu on pointer-move only
    // for a real mouse pointer, and jsdom's synthetic event has no pointerType.
    fireEvent.keyDown(within(menu).getByText("Snooze"), { key: "ArrowRight" });
    // Named "Snooze" after its trigger — Radix labels a submenu that way — and
    // queried with `hidden` because it marks everything outside the open
    // submenu aria-hidden, including the submenu's own ancestors.
    const submenu = await screen.findByRole("menu", {
      name: "Snooze",
      hidden: true,
    });
    const labels = within(submenu)
      .getAllByRole("menuitem", { hidden: true })
      .map((item) => item.textContent);
    // "This evening" drops out of the list after ~5pm, so it is the one preset
    // this cannot assert unconditionally.
    expect(labels).toContain("In 1 hour");
    expect(labels).toContain("Tomorrow");
    expect(labels).toContain("Next week");
    expect(resolveSnoozePresets(new Date()).map((p) => p.label)).toEqual(
      labels,
    );

    fireEvent.click(within(submenu).getByText("In 1 hour"));
    await waitFor(() => expect(snoozedUntil).not.toBeNull());
    expect(snoozedUntil!).toBeGreaterThan(Date.now());
  });

  it("offers the inverse actions on a thread that is already parked", async () => {
    let unsettled: string | null = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_done", title: "Filed away" })],
        projects: [sidebarProject("proj_1", "bb")],
      },
      rpc: {
        listLifecycle: () => ({
          epoch: "test",
          seq: 0,
          rows: [
            {
              threadId: "thr_done",
              settledAt: 200,
              snoozedUntil: null,
              snoozedAt: null,
            },
          ],
        }),
        unsettle: (input) => {
          unsettled = (input as { threadId: string }).threadId;
          return { ok: true };
        },
      },
    });
    const shelf = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(shelf).getByRole("button"));
    fireEvent.contextMenu(within(shelf).getByText("Filed away"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toContain("Un-settle");
    expect(within(menu).queryByText("Settle")).toBeNull();
    fireEvent.click(within(menu).getByText("Un-settle"));
    await waitFor(() => expect(unsettled).toBe("thr_done"));
  });

  it("offers Wake now instead of Snooze on a snoozed thread", async () => {
    let woken: string | null = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_snz", title: "Sleeping" })],
        projects: [sidebarProject("proj_1", "bb")],
      },
      rpc: {
        listLifecycle: () => ({
          epoch: "test",
          seq: 0,
          rows: [
            {
              threadId: "thr_snz",
              settledAt: null,
              snoozedUntil: Date.now() + 60 * 60 * 1000,
              snoozedAt: Date.now(),
            },
          ],
        }),
        unsnooze: (input) => {
          woken = (input as { threadId: string }).threadId;
          return { ok: true };
        },
      },
    });
    const shelf = await screen.findByRole("region", { name: "Snoozed" });
    fireEvent.click(within(shelf).getByRole("button"));
    fireEvent.contextMenu(within(shelf).getByText("Sleeping"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(within(menu).queryByText("Snooze")).toBeNull();
    fireEvent.click(within(menu).getByText("Wake now"));
    await waitFor(() => expect(woken).toBe("thr_snz"));
  });

  // The rule the whole feature turns on: hiding a thread that is still working
  // is the one failure parking cannot afford, and the menu must not offer a
  // route around the card's own refusal.
  it("hides the park actions on a working thread", async () => {
    render([
      thread({
        id: "thr_busy",
        title: "Still running",
        status: "active",
        indicator: "runtime",
      }),
    ]);
    fireEvent.contextMenu(await screen.findByText("Still running"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Project commands…",
      "Open in split",
      "Mark unread",
      "Pin",
      "Archive",
      "Delete",
    ]);
  });

  it("hides the park actions on a thread blocked on the user", async () => {
    render([
      thread({
        id: "thr_ask",
        title: "Asking you",
        hasPendingInteraction: true,
      }),
    ]);
    fireEvent.contextMenu(await screen.findByText("Asking you"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(within(menu).queryByText("Settle")).toBeNull();
    expect(within(menu).queryByText("Snooze")).toBeNull();
  });

  it("routes deletion through the host's confirmation", async () => {
    const rendered = render([thread({ id: "thr_del", title: "Delete me" })]);
    fireEvent.contextMenu(await screen.findByText("Delete me"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    fireEvent.click(within(menu).getByText("Delete"));
    await waitFor(() =>
      expect(rendered.sidebarActionCalls).toContainEqual({
        method: "requestDelete",
        threadId: "thr_del",
      }),
    );
  });
});

describe("card metadata", () => {
  it("draws the provider with bb's artwork and name", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_p", providerId: "claude-code" })],
        projects: [sidebarProject("proj_1", "bb")],
      },
      // Only the fields the glyph reads; the directory record is far wider.
      providers: {
        status: "ready",
        providers: [
          {
            id: "claude-code",
            displayName: "Claude Code",
            logoUrl: "/logos/claude.svg",
          } as ProviderRecord,
        ],
      },
      rpc: { listLifecycle: () => ({ epoch: "test", seq: 0, rows: [] }) },
    });
    const glyph = await screen.findByLabelText("Claude Code");
    const icon = glyph.querySelector("[data-provider-id]");
    expect(icon?.getAttribute("data-provider-kind")).toBe("agent");
    expect(icon?.getAttribute("data-provider-logo")).toBe("/logos/claude.svg");
  });

  it("falls back to a neutral glyph for an unknown provider", async () => {
    render([thread({ id: "thr_p", providerId: "some-new-agent" })]);
    expect(await screen.findByLabelText("some-new-agent")).toBeDefined();
  });

  // A personal-project thread has a machine but no worktree, so the machine
  // takes the branch's place instead of leaving the line blank.
  it("shows the machine when the thread has no branch", async () => {
    render([
      thread({
        id: "thr_m",
        host: { id: "host_1", name: "Sawyer's MacBook" },
      }),
    ]);
    expect(await screen.findByText("Sawyer's MacBook")).toBeDefined();
  });

  it("prefers the branch over the machine when both exist", async () => {
    render([
      thread({
        id: "thr_b",
        host: { id: "host_1", name: "Sawyer's MacBook" },
        environment: {
          id: "env_1",
          name: "Worktree",
          branchName: "bb/feature",
          path: "/work/bb-feature",
          isWorktree: true,
          providerId: null,
          workspaceDisplayKind: null,
        },
      }),
    ]);
    expect(await screen.findByText("bb/feature")).toBeDefined();
    expect(screen.queryByText("Sawyer's MacBook")).toBeNull();
  });

  // Not exactly 3h: the card's clock is quantized to the minute, so a
  // timestamp sitting on a bucket boundary legitimately reads one unit lower.
  it("shows how long ago the thread's last turn ended", async () => {
    render([thread({ id: "thr_t" })], undefined, { thr_t: THREE_HOURS_AGO() });
    expect(await screen.findByText("3h")).toBeDefined();
  });

  // No turn has ended, so there is no cache window to measure; but the time is
  // never left out. The slot falls back to bb's last activity on the thread,
  // dimmed and never amber, because it is not a cache clock. bb's updatedAt is
  // not that clock: it moves on a rename or a pin.
  it("shows the last activity, dimmed, for a thread whose turn has never ended", async () => {
    render([
      thread({
        id: "thr_new",
        latestAttentionAt: THREE_HOURS_AGO(),
        updatedAt: Date.now(),
      }),
    ]);
    const label = await screen.findByText("3h");
    expect(label.className).toContain("text-muted-foreground/50");
    expect(label.getAttribute("title")).toMatch(/no finished turn/i);
  });

  // A turn is running and the server has not pushed its logged start yet.
  // Nothing replaces the time: the clock counts from when this client saw the
  // turn, then steps to the logged start when it lands.
  it("counts a new turn from when it was seen until the logged start lands", async () => {
    const rendered = render([
      thread({
        id: "thr_run",
        status: "active",
        indicator: "runtime",
        indicatorLabel: "Agent is working",
        latestAttentionAt: Date.now() - (3 * 3_600_000 + 60_000),
      }),
    ]);
    expect(await screen.findByLabelText("Agent is working")).toBeDefined();
    expect(screen.getByText(/^\d+s$/)).toBeDefined();
    expect(screen.queryByText("–")).toBeNull();

    const logged = Date.now() - 4 * 60_000 - 5_000;
    await rendered.emitRealtime("lifecycle", {
      kind: "row",
      epoch: "test",
      seq: 1,
      threadId: "thr_run",
      row: { ...endedRow("thr_run", logged - 60_000), startedWorkingAt: logged },
    });
    expect(await screen.findByText("4m")).toBeDefined();
  });

  // A start saved last session belongs to a turn that is over; a turn running
  // now must not count from it on the first frame.
  it("ignores a turn start saved in last session's snapshot", () => {
    localStorage.setItem(
      LIFECYCLE_KEY,
      JSON.stringify([
          {
            ...endedRow("thr_run", Date.now() - 4 * 3_600_000),
            startedWorkingAt: Date.now() - 3 * 3_600_000 - 60_000,
          },
      ]),
    );
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_run", status: "active", indicator: "runtime" })],
        projects: [sidebarProject("proj_1", "bb")],
      },
      rpc: { listLifecycle: () => new Promise<never>(() => {}) },
    });
    expect(screen.queryByText("3h")).toBeNull();
    expect(screen.getByText(/^\d+s$/)).toBeDefined();
  });

  // The bug this rule was written for: a background terminal is not a turn.
  // The thread is idle as far as the prompt cache goes, so it keeps its idle
  // age and the terminal glyph sits beside it.
  it("keeps the idle age beside a background-work glyph", async () => {
    render(
      [
        thread({
          id: "thr_bg",
          indicator: "background-command",
          indicatorLabel: "Background command running",
          activity: {
            workflows: 0,
            backgroundAgents: 0,
            backgroundCommands: 1,
            planMode: 0,
            goals: 0,
          },
        }),
      ],
      undefined,
      { thr_bg: THREE_HOURS_AGO() },
    );
    expect(
      await screen.findByLabelText("Background command running"),
    ).toBeDefined();
    expect(screen.getByText("3h")).toBeDefined();
    // A leftover command is what settling stops, so it may be parked.
    expect(await screen.findByLabelText("Settle thread")).toBeDefined();
  });

  it("counts a running turn from bb's status, whatever the indicator", async () => {
    const start = Math.floor(Date.now() / 60_000) * 60_000 - 4 * 60_000;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_act", status: "active" })],
        projects: [sidebarProject("proj_1", "bb")],
      },
      rpc: {
        listLifecycle: () => ({
          epoch: "test",
          seq: 0,
          rows: [{ ...endedRow("thr_act", start - 60_000), startedWorkingAt: start }],
        }),
      },
    });
    expect(await screen.findByText("4m")).toBeDefined();
  });

  // An indicator this plugin does not know must fall through to the age label
  // rather than leave the slot blank.
  it("keeps the age label for an unrecognized indicator", async () => {
    render(
      [
        thread({
          id: "thr_new",
          indicator: "something-bb-ships-later" as never,
        }),
      ],
      undefined,
      { thr_new: THREE_HOURS_AGO() },
    );
    expect(await screen.findByText("3h")).toBeDefined();
  });
});

// The three states that want the user take the slot from the age label, and
// they use bb's own glyphs: the two lists sit in one window, and a user who
// switches between them should not have to learn a second vocabulary.
describe("attention states", () => {
  const states = [
    ["waiting-for-input", "Thread needs user input"],
    ["unread-error", "Unread thread failed"],
    ["unread-success", "Unread thread succeeded"],
    ["queued-failed", "Queued message failed to send"],
    ["queued-waiting", "Thread has a message waiting to send"],
  ] as const;

  for (const [indicator, label] of states) {
    // Both, now. The glyph says what state the thread is in and the age says
    // how long it has been in it, and on an idle thread that second number is
    // what decides whether replying resumes a cached conversation.
    it(`shows the ${indicator} glyph beside the age`, async () => {
      render(
        [
          thread({
            id: `thr_${indicator}`,
            indicator,
            indicatorLabel: label,
          }),
        ],
        undefined,
        { [`thr_${indicator}`]: THREE_HOURS_AGO() },
      );
      expect(await screen.findByLabelText(label)).toBeDefined();
      expect(screen.getByText("3h")).toBeDefined();
    });
  }

  // Running work is the one state the user does NOT have to act on, so it gets
  // the neutral spinner and no notification dot.
  it("shows the spinner, not a dot, while work runs", async () => {
    render([
      thread({
        id: "thr_busy",
        isUnread: true,
        status: "active",
        indicator: "runtime",
        indicatorLabel: "Thread working",
      }),
    ]);
    expect(await screen.findByLabelText("Thread working")).toBeDefined();
    expect(screen.queryByLabelText("Unread thread succeeded")).toBeNull();
  });
});

// The host never reports a draft in `indicator`; the row reads this client's
// composer and folds it in.
describe("unsent drafts", () => {
  function renderWithDraft(row: PluginSidebarThread) {
    return renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [row],
        projects: [sidebarProject("proj_1", "bb")],
      },
      sidebarDraftThreadIds: [row.id],
      rpc: { listLifecycle: () => ({ epoch: "test", seq: 0, rows: [] }) },
    });
  }

  it("shows the pencil on a quiet thread", async () => {
    renderWithDraft(thread({ id: "thr_d" }));
    expect(
      await screen.findByLabelText("Thread has unsubmitted draft"),
    ).toBeDefined();
  });

  it("shows the working pencil while the thread runs", async () => {
    renderWithDraft(
      thread({
        id: "thr_wd",
        status: "active",
        indicator: "runtime",
        indicatorLabel: "Thread working",
      }),
    );
    expect(
      await screen.findByLabelText("Thread working with unsubmitted draft"),
    ).toBeDefined();
    expect(screen.queryByLabelText("Thread working")).toBeNull();
  });

  // A thread whose turn has ended but whose terminal still runs is live work
  // to bb, which shows the working pencil; the turn-only rule is the clock's.
  it("shows the working pencil beside background work", async () => {
    renderWithDraft(
      thread({
        id: "thr_bgd",
        indicator: "background-command",
        indicatorLabel: "Background command running",
        activity: {
          workflows: 0,
          backgroundAgents: 0,
          backgroundCommands: 1,
          planMode: 0,
          goals: 0,
        },
      }),
    );
    expect(
      await screen.findByLabelText("Thread working with unsubmitted draft"),
    ).toBeDefined();
    expect(screen.queryByLabelText("Background command running")).toBeNull();
  });

  // bb rolls a running child up into the parent's "runtime" indicator and
  // draws the working pencil for a draft on it; so does this list.
  it("shows the working pencil on a parent whose child runs", async () => {
    renderWithDraft(
      thread({
        id: "thr_pd",
        indicator: "runtime",
        indicatorLabel: "Thread working",
      }),
    );
    expect(
      await screen.findByLabelText("Thread working with unsubmitted draft"),
    ).toBeDefined();
  });

  // Another plugin's row status follows bb's rule: shown over anything but a
  // running turn, a failure or a question — including over a draft.
  it("draws another plugin's row status over a draft", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_rs" })],
        projects: [sidebarProject("proj_1", "bb")],
      },
      sidebarDraftThreadIds: ["thr_rs"],
      sidebarRowStatuses: {
        thr_rs: { icon: "Zap", label: "Deploying", tone: "running" },
      },
      rpc: { listLifecycle: () => ({ epoch: "test", seq: 0, rows: [] }) },
    });
    const glyph = await screen.findByLabelText("Deploying");
    expect(glyph.getAttribute("class")).toContain("animate-shine-icon");
    // bb's running treatment: a pulsing wrapper in the success colour.
    expect(glyph.parentElement?.className).toContain("motion-safe:animate-pulse");
    expect(screen.queryByLabelText("Thread has unsubmitted draft")).toBeNull();
  });

  function renderWithRowStatus(row: PluginSidebarThread) {
    return renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [row],
        projects: [sidebarProject("proj_1", "bb")],
      },
      sidebarRowStatuses: { [row.id]: { icon: "Zap", label: "Deploying" } },
      rpc: { listLifecycle: () => ({ epoch: "test", seq: 0, rows: [] }) },
    });
  }

  // Not ranked as a draft: an unread result does not hide it.
  it("shows a row status over an unread result", async () => {
    renderWithRowStatus(
      thread({
        id: "thr_ru",
        indicator: "unread-success",
        indicatorLabel: "Unread thread succeeded",
      }),
    );
    expect(await screen.findByLabelText("Deploying")).toBeDefined();
    expect(screen.queryByLabelText("Unread thread succeeded")).toBeNull();
  });

  // And not a draft either: a running turn keeps its spinner.
  it("keeps the spinner over a row status while a turn runs", async () => {
    renderWithRowStatus(
      thread({
        id: "thr_rr",
        status: "active",
        indicator: "runtime",
        indicatorLabel: "Thread working",
      }),
    );
    expect(await screen.findByLabelText("Thread working")).toBeDefined();
    expect(screen.queryByLabelText("Deploying")).toBeNull();
  });

  it("never lets a row status hide a question", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "thr_rq",
            hasPendingInteraction: true,
            indicator: "waiting-for-input",
            indicatorLabel: "Thread needs user input",
          }),
        ],
        projects: [sidebarProject("proj_1", "bb")],
      },
      sidebarRowStatuses: { thr_rq: { icon: "Zap", label: "Deploying" } },
      rpc: { listLifecycle: () => ({ epoch: "test", seq: 0, rows: [] }) },
    });
    expect(await screen.findByLabelText("Thread needs user input")).toBeDefined();
    expect(screen.queryByLabelText("Deploying")).toBeNull();
  });

  it("never hides a thread that is waiting on you", async () => {
    renderWithDraft(
      thread({
        id: "thr_wait",
        hasPendingInteraction: true,
        indicator: "waiting-for-input",
        indicatorLabel: "Thread needs user input",
      }),
    );
    expect(await screen.findByLabelText("Thread needs user input")).toBeDefined();
    expect(screen.queryByLabelText("Thread has unsubmitted draft")).toBeNull();
  });
});

describe("jump shortcuts", () => {
  it("shows the key bb assigned beside the status while held", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "thr_k",
            indicator: "unread-success",
            indicatorLabel: "Unread thread succeeded",
          }),
        ],
        projects: [sidebarProject("proj_1", "bb")],
      },
      sidebarShortcuts: { thr_k: { label: "⌘1", ariaKeyshortcuts: "Meta+1" } },
      rpc: {
        listLifecycle: () => ({
          epoch: "test",
          seq: 0,
          rows: [endedRow("thr_k", THREE_HOURS_AGO())],
        }),
      },
    });
    expect(await screen.findByText("⌘1")).toBeDefined();
    // Nothing replaces the status or the time.
    expect(screen.getByLabelText("Unread thread succeeded")).toBeDefined();
    expect(screen.getByText("3h")).toBeDefined();
    expect(screen.getByRole("link").getAttribute("aria-keyshortcuts")).toBe(
      "Meta+1",
    );
  });

  // The park actions stay mounted under the key pill, so a snooze menu that
  // is open when the modifier goes down is not torn out from under focus.
  it("keeps the park actions mounted while the key shows", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_k" })],
        projects: [sidebarProject("proj_1", "bb")],
      },
      sidebarShortcuts: { thr_k: { label: "⌘1", ariaKeyshortcuts: "Meta+1" } },
      rpc: { listLifecycle: () => ({ epoch: "test", seq: 0, rows: [] }) },
    });
    await listReady();
    expect(screen.getByText("⌘1")).toBeDefined();
    fireEvent.keyDown(screen.getByLabelText("Snooze"), { key: "Enter" });
    expect(await screen.findByRole("menu", { name: "Snooze" })).toBeDefined();
  });

  // Visually hidden at rest, not removed from the tab order, so Shift+Tab
  // from the next row reaches Settle and Snooze.
  it("keeps the park actions in the tab order at rest", async () => {
    render([thread({ id: "thr_t" })]);
    await listReady();
    const strip = screen.getByLabelText("Settle thread").parentElement!;
    expect(strip.className).toContain("sr-only");
    expect(strip.className.split(" ")).not.toContain("hidden");
  });

  // jsdom evaluates no media queries, so this pins the contract instead: no
  // rule draws the actions without hover, so a touch device leaves them
  // visually hidden, and a long-press on the row is the row menu's rather than
  // the browser's link callout.
  it("draws no park actions on touch and keeps long-press for the row menu", async () => {
    render([thread({ id: "thr_touch" })]);
    await listReady();
    const strip = screen.getByLabelText("Settle thread").parentElement!;
    expect(strip.className).toContain("sr-only");
    expect(strip.className).not.toContain("hover:none");
    expect(screen.getByLabelText("Settle thread").className).not.toContain(
      "hover:none",
    );
    expect(screen.getByRole("link").className).toContain(
      "[-webkit-touch-callout:none]",
    );
  });

  it("shows no key when the modifier is up", async () => {
    render([thread({ id: "thr_k" })]);
    await listReady();
    expect(
      screen.getByRole("link").hasAttribute("aria-keyshortcuts"),
    ).toBe(false);
    expect(document.querySelector("kbd")).toBeNull();
  });
});

describe("pull request badge", () => {
  const withPr = (attention: string, state = "open") =>
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_pr" })],
        projects: [sidebarProject("proj_1", "bb")],
      },
      rpc: { listLifecycle: () => ({ epoch: "test", seq: 0, rows: [] }) },
      sidebarPullRequests: {
        thr_pr: {
          number: 412,
          title: "Fix the flake",
          url: "https://github.com/o/r/pull/412",
          state,
          attention,
        } as never,
      },
    });

  it("links the PR number out to the git host", async () => {
    withPr("none");
    const badge = await screen.findByRole("link", { name: "#412" });
    expect(badge.getAttribute("href")).toBe("https://github.com/o/r/pull/412");
    expect(badge.getAttribute("title")).toBe("Fix the flake");
  });

  it("shows no badge when the branch has no PR", async () => {
    render([thread({ id: "thr_nopr" })]);
    await screen.findByText("A thread");
    expect(screen.queryByRole("link", { name: /^#/ })).toBeNull();
  });

  // The attention state is bb's rolled-up "does this need you" signal, so the
  // badge can colour itself without reading checks/review/mergeability.
  it("colors the badge from the attention state", async () => {
    const failing = withPr("checks_failed");
    expect(
      (await screen.findByRole("link", { name: "#412" })).className,
    ).toContain("destructive");
    failing.unmount();

    withPr("ready_to_merge");
    expect(
      (await screen.findByRole("link", { name: "#412" })).className,
    ).toContain("success");
  });
});

describe("project avatars in the list", () => {
  const withAvatars = (rows: unknown[]) =>
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "a", projectId: "prj_1" })],
        projects: [sidebarProject("prj_1", "my cool app")],
      },
      rpc: {
        listLifecycle: () => ({ epoch: "test", seq: 0, rows: [] }),
        listProjectAvatars: () => ({ rows }),
      } as never,
    });

  /** The card's first line: project, then the fixed-width status slot. */
  function firstLine(): HTMLElement {
    const row = screen.getAllByRole("listitem")[0]!;
    return row.querySelectorAll(":scope > div > div")[0] as HTMLElement;
  }

  it("puts the avatar immediately before the project name", async () => {
    withAvatars([]);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    const line = firstLine();
    // The generated monogram for "my cool app".
    expect(line.children[0]!.textContent).toBe("MC");
    expect(line.children[1]!.textContent).toBe("my cool app");
  });

  // The card was explicitly not to be redesigned: one line, one status slot,
  // one width, and the avatar has to fit inside that without moving anything.
  it("leaves the line height and the status slot where they were", async () => {
    withAvatars([]);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    const line = firstLine();
    expect(line.className).toContain("h-5");
    expect(line.lastElementChild!.className).toContain("w-12");
    // Fixed size and no shrinking: an avatar that measured its own content
    // would move the project name every time an image finished loading.
    expect(line.children[0]!.className).toContain("size-3.5");
    expect(line.children[0]!.className).toContain("shrink-0");
  });

  it("draws the stored avatar rather than the generated one", async () => {
    withAvatars([
      {
        projectId: "prj_1",
        customKind: "emoji",
        customColor: null,
        customInitials: null,
        customEmoji: "🐙",
        customImage: null,
        remoteImage: null,
        remoteUrl: null,
        fetchedAt: null,
        failedAt: null,
        failureCount: null,
      },
    ]);
    await waitFor(() => expect(screen.getAllByText("🐙").length).toBeGreaterThan(0));
  });

  // "All projects" is a scope, not a project: there is no identity to draw.
  it("gives every project in the scope picker an avatar, and the scope none", async () => {
    // Radix's Select drives its trigger through the Pointer Capture API, which
    // jsdom does not implement; without these the menu cannot be opened here.
    Object.assign(window.HTMLElement.prototype, {
      hasPointerCapture: () => false,
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      scrollIntoView: () => {},
    });
    withAvatars([]);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));

    const trigger = screen.getByLabelText("Project scope: All projects");
    // The trigger mirrors the selection, so at "All projects" it shows no
    // avatar either.
    expect(within(trigger).queryByText("MC")).toBeNull();

    // Opened from the keyboard: Radix's pointer path needs layout jsdom does
    // not do, and the menu it renders is the same either way.
    fireEvent.keyDown(trigger, { key: "Enter" });
    const option = await screen.findByRole("option", { name: /my cool app/ });
    expect(within(option).getByText("MC")).toBeDefined();
    expect(
      within(screen.getByRole("option", { name: "All projects" })).queryByText(
        "MC",
      ),
    ).toBeNull();
  });
});

describe("order freeze", () => {
  /** Two quiet threads and a snoozed one that outranks both once it wakes. */
  function renderWithSnoozed() {
    const snoozedRow = {
      threadId: "thr_top",
      settledAt: null,
      snoozedUntil: Date.now() + 3_600_000,
      snoozedAt: Date.now() - 1_000,
      startedWorkingAt: null,
      lastRunEndedAt: null,
    };
    return renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "thr_mid", title: "Middle", latestAttentionAt: 200 }),
          thread({ id: "thr_low", title: "Lowest", latestAttentionAt: 100 }),
          thread({ id: "thr_top", title: "Topmost", latestAttentionAt: 300 }),
        ],
        projects: [sidebarProject("proj_1", "bb")],
      },
      rpc: {
        listLifecycle: () => ({ epoch: "test", seq: 0, rows: [snoozedRow] }),
      },
    });
  }

  const wake = {
    kind: "row",
    epoch: "test",
    seq: 1,
    threadId: "thr_top",
    row: null,
  };

  function scrollArea(): HTMLElement {
    return screen.getAllByRole("listitem")[0]!.closest(".overflow-y-auto")!;
  }

  it("re-ranks at once when nobody is using the list", async () => {
    const rendered = renderWithSnoozed();
    await screen.findByRole("region", { name: "Snoozed" });
    await rendered.emitRealtime("lifecycle", wake);
    expect(rowTitles()[0]).toContain("Topmost");
  });

  it("holds the order while the pointer is over the list", async () => {
    const rendered = renderWithSnoozed();
    await screen.findByRole("region", { name: "Snoozed" });
    fireEvent.pointerEnter(scrollArea());
    await rendered.emitRealtime("lifecycle", wake);
    // Woken, so it is back in the inbox, but below the rows under the pointer.
    expect(rowTitles().map((text) => text.slice(0, 40))).toEqual([
      expect.stringContaining("Middle"),
      expect.stringContaining("Lowest"),
      expect.stringContaining("Topmost"),
    ]);
    fireEvent.pointerLeave(scrollArea());
    await waitFor(() => expect(rowTitles()[0]).toContain("Topmost"));
  });

  it("holds the order while a row has keyboard focus", async () => {
    const rendered = renderWithSnoozed();
    await screen.findByRole("region", { name: "Snoozed" });
    // Tabbed to, as a keyboard user gets there.
    fireEvent.keyDown(document.body, { key: "Tab" });
    screen.getAllByRole("link")[1]!.focus();
    await rendered.emitRealtime("lifecycle", wake);
    expect(rowTitles()[0]).toContain("Middle");
    (document.activeElement as HTMLElement).blur();
    await waitFor(() => expect(rowTitles()[0]).toContain("Topmost"));
  });

  // Settling from the keyboard unmounts the focused card, and Firefox and
  // Safari (and jsdom) send no focusout for a removed element. The freeze must
  // still notice the focus is gone, or nothing re-ranks until the next focus.
  it("releases when the focused row is removed without a focusout", async () => {
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "thr_low", title: "Lowest", latestAttentionAt: 100 }),
          thread({ id: "thr_mid", title: "Middle", latestAttentionAt: 200 }),
          thread({ id: "thr_top", title: "Topmost", latestAttentionAt: 300 }),
        ],
        projects: [sidebarProject("proj_1", "bb")],
      },
      rpc: {
        listLifecycle: () => ({
          epoch: "test",
          seq: 0,
          rows: [
            {
              threadId: "thr_top",
              settledAt: null,
              snoozedUntil: Date.now() + 3_600_000,
              snoozedAt: Date.now() - 1_000,
              startedWorkingAt: null,
              lastRunEndedAt: null,
            },
          ],
        }),
        settle: () => ({ ok: true }),
      },
    });
    await listReady();
    fireEvent.keyDown(document.body, { key: "Tab" });
    const middle = screen.getByText("Middle").closest("li")!;
    const settle = within(middle).getByLabelText("Settle thread");
    settle.focus();
    fireEvent.click(settle);
    // The card is gone; jsdom sent no focusout for it.
    await waitFor(() => expect(screen.queryByText("Middle")).toBeNull());
    await rendered.emitRealtime("lifecycle", wake);
    await waitFor(() =>
      expect(rowTitles().map((text) => text.slice(0, 40))).toEqual([
        expect.stringContaining("Topmost"),
        expect.stringContaining("Lowest"),
      ]),
    );
  });

  // A click focuses the row's link too, and that focus can sit there for
  // minutes after the pointer has gone: it must not pin the order.
  it("does not hold the order for focus a click left behind", async () => {
    const rendered = renderWithSnoozed();
    await screen.findByRole("region", { name: "Snoozed" });
    fireEvent.pointerDown(document.body);
    screen.getAllByRole("link")[1]!.focus();
    await rendered.emitRealtime("lifecycle", wake);
    await waitFor(() => expect(rowTitles()[0]).toContain("Topmost"));
  });
});

describe("first paint", () => {
  const threads = [
    thread({ id: "thr_open", title: "Open work", latestAttentionAt: 200 }),
    thread({ id: "thr_done", title: "Finished", latestAttentionAt: 100 }),
  ];
  // Never answers: whatever frame 1 shows came from the snapshot.
  const neverRead = () => new Promise<never>(() => {});

  function renderFirstFrame() {
    return renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads,
        projects: [sidebarProject("proj_1", "bb")],
      },
      rpc: { listLifecycle: neverRead, listProjectAvatars: neverRead },
    });
  }

  it("paints last session's shelves on the first frame", () => {
    localStorage.setItem(
      LIFECYCLE_KEY,
      JSON.stringify([{ ...endedRow("thr_done", 50), settledAt: 150 }]),
    );
    renderFirstFrame();
    expect(screen.queryByRole("status", { name: "Loading threads" })).toBeNull();
    expect(screen.getByRole("region", { name: "Settled" })).toBeDefined();
    expect(rowTitles()).toEqual([expect.stringContaining("Open work")]);
  });

  it("paints last session's avatars on the first frame", () => {
    localStorage.setItem(
      LIFECYCLE_KEY,
      JSON.stringify([]),
    );
    localStorage.setItem(
      snapshotKey("avatars", AVATAR_SNAPSHOT),
      JSON.stringify([
        {
          ...Object.fromEntries(
            Object.keys(AVATAR_SNAPSHOT).map((field) => [field, null]),
          ),
          projectId: "proj_1",
          customKind: "emoji",
          customEmoji: "🐙",
        },
      ]),
    );
    renderFirstFrame();
    expect(screen.getAllByText("🐙").length).toBeGreaterThan(0);
  });

  // With nothing to rank by, the list would appear unshelved and re-sort a
  // moment later. It shows a still placeholder instead, and no rows.
  it("shows a skeleton, never an unshelved list, with no snapshot", () => {
    renderFirstFrame();
    expect(screen.getByRole("status", { name: "Loading threads" })).toBeDefined();
    expect(screen.queryByText("Open work")).toBeNull();
  });

  it("keeps a snapshot of what the server said for the next launch", async () => {
    render(threads, undefined, { thr_open: 42 });
    await listReady();
    // Written a second after the last change, and only the listed thread
    // that has a row.
    await waitFor(
      () => {
        const saved = JSON.parse(localStorage.getItem(LIFECYCLE_KEY) ?? "null");
        expect(saved).toEqual([endedRow("thr_open", 42)]);
      },
      { timeout: 2_500 },
    );
  });

  // A snapshot from an older build, or one damaged in storage, is not
  // trusted by halves: one bad field and the skeleton shows instead.
  it("discards a snapshot with a row of the wrong shape", () => {
    localStorage.setItem(
      LIFECYCLE_KEY,
      JSON.stringify([
        { ...endedRow("thr_open", 42) },
        { ...endedRow("thr_done", 50), settledAt: "yesterday" },
      ]),
    );
    renderFirstFrame();
    expect(screen.getByRole("status", { name: "Loading threads" })).toBeDefined();
  });
});

describe("menus hold the order", () => {
  it("keeps the row in place while its context menu is open", async () => {
    const snoozedRow = {
      threadId: "thr_top",
      settledAt: null,
      snoozedUntil: Date.now() + 3_600_000,
      snoozedAt: Date.now() - 1_000,
      startedWorkingAt: null,
      lastRunEndedAt: null,
    };
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "thr_mid", title: "Middle", latestAttentionAt: 200 }),
          thread({ id: "thr_top", title: "Topmost", latestAttentionAt: 300 }),
        ],
        projects: [sidebarProject("proj_1", "bb")],
      },
      rpc: {
        listLifecycle: () => ({ epoch: "test", seq: 0, rows: [snoozedRow] }),
      },
    });
    fireEvent.contextMenu(await screen.findByText("Middle"));
    await screen.findByRole("menu", { name: "Thread actions" });
    await rendered.emitRealtime("lifecycle", {
      kind: "row",
      epoch: "test",
      seq: 1,
      threadId: "thr_top",
      row: null,
    });
    // The open menu hides the rest of the page from assistive tech.
    const firstRow = () =>
      screen.getAllByRole("listitem", { hidden: true })[0]!.textContent;
    expect(firstRow()).toContain("Middle");
    fireEvent.keyDown(screen.getByRole("menu", { name: "Thread actions" }), {
      key: "Escape",
    });
    await waitFor(() => expect(firstRow()).toContain("Topmost"));
  });
});
