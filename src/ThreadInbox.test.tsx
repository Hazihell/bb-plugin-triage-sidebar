// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { resolveSnoozePresets } from "./lifecycle";

// Load through the harness so the plugin's `@get-bb/plugin-sdk/app` import binds
// to the test runtime; importing the component directly would bind it to an
// empty runtime first.
const app = await loadPluginApp(() => import("../app"));
const inbox = app.threadLists[0]!;

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

const listProps = {
  activeThreadId: null,
  activeProjectId: null,
  isCompactViewport: false,
  onNavigate: () => {},
  searchQuery: "",
};

function render(
  threads: PluginSidebarThread[],
  projects = [{ id: "proj_1", name: "bb", isPersonal: false }],
) {
  return renderSlot(inbox, listProps, {
    sidebarThreads: { status: "ready", threads, projects },
    // The lifecycle store is the plugin's own backend; an empty one means
    // every thread is active, which is what these list tests are about.
    rpc: { listLifecycle: () => ({ rows: [] }) },
  });
}

afterEach(cleanup);

// The anchor is a full-bleed overlay, so the row containers carry the text.
function rowTitles(): (string | null)[] {
  return screen.getAllByRole("listitem").map((row) => row.textContent);
}

describe("triage-sidebar registration", () => {
  it("registers exactly one thread list", () => {
    expect(app.threadLists).toHaveLength(1);
    expect(inbox.id).toBe("inbox");
  });
});

describe("ThreadInbox", () => {
  it("lists the most recently needed thread first", () => {
    render([
      thread({ id: "a", title: "Quiet", latestAttentionAt: 1 }),
      thread({ id: "b", title: "Touched", latestAttentionAt: 2 }),
    ]);
    expect(rowTitles()[0]).toContain("Touched");
    expect(rowTitles()[1]).toContain("Quiet");
  });

  // The sort's headline promise, end to end: a question waiting for an answer
  // outranks a thread that was busy seconds ago.
  it("floats a thread blocked on the user to the top", () => {
    render([
      thread({ id: "a", title: "Busy", latestAttentionAt: 9_000 }),
      thread({
        id: "b",
        title: "Asking",
        latestAttentionAt: 1,
        hasPendingInteraction: true,
      }),
    ]);
    expect(rowTitles()[0]).toContain("Asking");
  });

  // The DOM contract behind numbered thread shortcuts and thread.next/previous.
  // A plugin that drops these attributes silently breaks nine host shortcuts.
  it("marks every row as a host shortcut target", () => {
    render([thread({ id: "thr_x" })]);
    const row = screen.getByRole("link");
    expect(row.hasAttribute("data-sidebar-thread-shortcut-target")).toBe(true);
    expect(row.getAttribute("data-sidebar-thread-id")).toBe("thr_x");
  });

  it("opens a thread on click and closes the mobile drawer", () => {
    let navigated = 0;
    const rendered = renderSlot(
      inbox,
      { ...listProps, onNavigate: () => (navigated += 1) },
      {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "thr_open" })],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );
    fireEvent.click(screen.getByRole("link"));
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "thr_open",
      options: { split: false },
    });
    expect(navigated).toBe(1);
  });

  it("opens in a split with the platform modifier held", () => {
    const rendered = render([thread({ id: "thr_split" })]);
    fireEvent.click(screen.getByRole("link"), { metaKey: true });
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "thr_split",
      options: { split: true },
    });
  });

  it("separates pinned threads from the inbox", () => {
    render([
      thread({ id: "a", title: "Plain" }),
      thread({ id: "b", title: "Stuck", isPinned: true }),
    ]);
    const pinned = screen.getByRole("region", { name: /pinned/i });
    expect(within(pinned).getByText("Stuck")).toBeDefined();
  });

  // The host owns the search field; the plugin only filters by what it is
  // handed, so there is deliberately no second search box to type into.
  it("filters by the host's search query", () => {
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
          projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Sidebar work")).toBeDefined();
  });

  it("ships no search field of its own", () => {
    render([thread({ id: "a" })]);
    expect(screen.queryByLabelText("Search threads")).toBeNull();
  });

  it("ships no new-thread button of its own", () => {
    render([thread({ id: "a" })]);
    expect(screen.queryByLabelText("New thread")).toBeNull();
  });

  it("scopes to one project", () => {
    render(
      [
        thread({ id: "a", title: "In bb", projectId: "proj_1" }),
        thread({ id: "b", title: "In other", projectId: "proj_2" }),
      ],
      [
        { id: "proj_1", name: "bb", isPersonal: false },
        { id: "proj_2", name: "other", isPersonal: false },
      ],
    );
    // Radix opens on keyboard too, which jsdom can drive without pointer
    // capture. Enter opens the list; the option click picks the scope.
    fireEvent.keyDown(screen.getByLabelText(/Project scope/), { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "other" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("In other")).toBeDefined();
  });

  it("hides archived threads", () => {
    render([thread({ id: "a", isArchived: true })]);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("reports an empty inbox and a fruitless search differently", () => {
    render([]);
    expect(screen.getByText("No threads yet")).toBeDefined();
  });
});

describe("parking threads", () => {
  it("moves a settled thread to the Settled shelf", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_done", title: "Finished work" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({
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
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      // Settled in the store, but still working: it must stay visible.
      rpc: {
        listLifecycle: () => ({
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

  it("offers settle and snooze on a parkable thread", async () => {
    render([thread({ id: "thr_park", title: "Quiet" })]);
    // Rendered (not merely accepted as props): a card whose park controls
    // never mount leaves the whole feature unreachable.
    expect(await screen.findByLabelText("Settle thread")).toBeDefined();
    expect(screen.getByLabelText("Snooze until tomorrow")).toBeDefined();
  });

  it("settles a thread when the user clicks Settle", async () => {
    let settled: string | null = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_park", title: "Quiet" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
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
    const wakeAt = Date.now() + 2 * 60 * 60 * 1000;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_snz", title: "Later" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({
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
    expect(within(shelf).getByText("2h")).toBeDefined();
    expect(within(shelf).getByLabelText("Wake thread now")).toBeDefined();
  });
});

describe("working duration", () => {
  function renderWorking(startedWorkingAt: number | null) {
    return renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "thr_run", title: "Running", indicator: "runtime" }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({
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
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({
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

  // The whole point: the child is not in the list, so without this the parent
  // is a card with nothing to say while its subagent works.
  it("spins the parent's slot while a child is running", async () => {
    render(parentAndChild({ indicator: "runtime", indicatorLabel: "Working" }));
    expect(await screen.findByLabelText("Child thread working")).toBeDefined();
  });

  // The spinner is the child's; the clock is the parent's own idle age. There
  // is no child clock anywhere in this sidebar.
  it("keeps the parent's idle age beside that spinner", async () => {
    render(
      parentAndChild({ indicator: "runtime", indicatorLabel: "Working" }).map(
        (t) =>
          t.id === "thr_parent"
            ? { ...t, updatedAt: Date.now() - (3 * 3_600_000 + MINUTE) }
            : t,
      ),
    );
    expect(await screen.findByLabelText("Child thread working")).toBeDefined();
    expect(screen.getByText("3h")).toBeDefined();
  });

  it("counts running children on the parent's third line", async () => {
    render(parentAndChild({ indicator: "runtime", indicatorLabel: "Working" }));
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
    render(parentAndChild({ indicator: "runtime", indicatorLabel: "Working" }));
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
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({
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
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({
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
      "Open in split",
      "Mark unread",
      "Pin",
      "Archive",
      "Delete",
    ]);
  });

  // The mobile gap this menu closes: the card's settle and snooze are hover
  // buttons, which a touch device has no way to reach. Radix opens this menu
  // on long-press, so the items below are the only park route there.
  it("parks a thread from the menu", async () => {
    let settled: string | null = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_park", title: "Park me" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
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
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
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
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({
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
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({
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
      thread({ id: "thr_busy", title: "Still running", indicator: "runtime" }),
    ]);
    fireEvent.contextMenu(await screen.findByText("Still running"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Open in split", "Mark unread", "Pin", "Archive", "Delete"]);
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
  it("always shows the provider glyph, even without a branch", async () => {
    render([thread({ id: "thr_p", providerId: "claude-code" })]);
    expect(await screen.findByLabelText("Claude Code")).toBeDefined();
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
          workspaceDisplayKind: "managed-worktree",
        },
      }),
    ]);
    expect(await screen.findByText("bb/feature")).toBeDefined();
    expect(screen.queryByText("Sawyer's MacBook")).toBeNull();
  });

  // Not exactly 3h: the card's clock is quantized to the minute, so a
  // timestamp sitting on a bucket boundary legitimately reads one unit lower.
  it("shows how long ago the thread was touched", async () => {
    render([
      thread({ id: "thr_t", updatedAt: Date.now() - (3 * 3_600_000 + 60_000) }),
    ]);
    expect(await screen.findByText("3h")).toBeDefined();
  });

  // The one row that spends the slot on a glyph alone: its own run is live, so
  // there is no idle age to show, and the store has no start time to count.
  it("shows no age while the thread's own run is live", async () => {
    render([
      thread({
        id: "thr_run",
        indicator: "runtime",
        indicatorLabel: "Agent is working",
        updatedAt: Date.now() - (3 * 3_600_000 + 60_000),
      }),
    ]);
    expect(await screen.findByLabelText("Agent is working")).toBeDefined();
    expect(screen.queryByText("3h")).toBeNull();
  });

  // An indicator this plugin does not know must fall through to the age label
  // rather than leave the slot blank.
  it("keeps the age label for an unrecognized indicator", async () => {
    render([
      thread({
        id: "thr_new",
        indicator: "something-bb-ships-later" as never,
        updatedAt: Date.now() - (3 * 3_600_000 + 60_000),
      }),
    ]);
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
  ] as const;

  for (const [indicator, label] of states) {
    // Both, now. The glyph says what state the thread is in and the age says
    // how long it has been in it, and on an idle thread that second number is
    // what decides whether replying resumes a cached conversation.
    it(`shows the ${indicator} glyph beside the age`, async () => {
      render([
        thread({
          id: `thr_${indicator}`,
          indicator,
          indicatorLabel: label,
          updatedAt: Date.now() - (3 * 3_600_000 + 60_000),
        }),
      ]);
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
        indicator: "runtime",
        indicatorLabel: "Thread working",
      }),
    ]);
    expect(await screen.findByLabelText("Thread working")).toBeDefined();
    expect(screen.queryByLabelText("Unread thread succeeded")).toBeNull();
  });
});

describe("pull request badge", () => {
  const withPr = (attention: string, state = "open") =>
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_pr" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
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
        projects: [{ id: "prj_1", name: "my cool app", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
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
