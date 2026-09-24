// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { sidebarThread, sidebarProject } from "./test-fixtures";
import type { ThreadLifecycleRow } from "./lifecycle";

const toasts = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn() });
  return { toast };
});
vi.mock("sonner", () => toasts);

const app = await loadPluginApp(() => import("../app"));
const inbox = app.threadLists[0]!;

const listProps = {
  activeThreadId: null,
  activeProjectId: null,
  isCompactViewport: false,
  onNavigate: () => {},
  searchQuery: "",
};

const row = (threadId: string, overrides: Partial<ThreadLifecycleRow> = {}) => ({
  threadId,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  startedWorkingAt: null,
  lastRunEndedAt: null,
  ...overrides,
});

function renderInbox(rpc: Record<string, (input: unknown) => unknown>) {
  return renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      threads: [sidebarThread({ id: "thr_a", title: "Alpha" })],
      projects: [sidebarProject("proj_1", "bb")],
    },
    rpc: rpc as never,
  });
}

const listCalls = (rendered: ReturnType<typeof renderInbox>) =>
  rendered.inspection.rpcCalls.filter((call) => call.method === "listLifecycle");

beforeEach(() => {
  toasts.toast.mockClear();
  toasts.toast.error.mockClear();
  toasts.toast.warning.mockClear();
});
afterEach(cleanup);

describe("lifecycle sync", () => {
  // The common path: the server says what changed and the client applies it,
  // with no second read of the whole table.
  it("applies a row message without reading the table again", async () => {
    const rendered = renderInbox({
      listLifecycle: () => ({ epoch: "e1", seq: 3, rows: [] }),
    });
    await screen.findByText("Alpha");
    await waitFor(() => expect(listCalls(rendered)).toHaveLength(1));

    await rendered.emitRealtime("lifecycle", {
      kind: "row",
      epoch: "e1",
      seq: 4,
      threadId: "thr_a",
      row: row("thr_a", { settledAt: Date.now() + 60_000 }),
    });

    expect(await screen.findByRole("region", { name: "Settled" })).toBeDefined();
    expect(listCalls(rendered)).toHaveLength(1);
  });

  it("reads the table again after a missed message", async () => {
    const rendered = renderInbox({
      listLifecycle: () => ({ epoch: "e1", seq: 3, rows: [] }),
    });
    await waitFor(() => expect(listCalls(rendered)).toHaveLength(1));

    await rendered.emitRealtime("lifecycle", {
      kind: "row",
      epoch: "e1",
      seq: 9,
      threadId: "thr_a",
      row: null,
    });

    await waitFor(() => expect(listCalls(rendered)).toHaveLength(2));
  });

  // Messages sent while the connection was down are lost; only a full read
  // can say what they were.
  it("reads the table again after a reconnect, not on the first connect", async () => {
    const rendered = renderInbox({
      listLifecycle: () => ({ epoch: "e1", seq: 0, rows: [] }),
    });
    await waitFor(() => expect(listCalls(rendered)).toHaveLength(1));

    await rendered.setRealtimeConnectionState("reconnecting");
    await rendered.setRealtimeConnectionState("connected");

    await waitFor(() => expect(listCalls(rendered)).toHaveLength(2));
  });

  it("tells the user when the first read fails, and retries on request", async () => {
    let fail = true;
    const rendered = renderInbox({
      listLifecycle: () => {
        if (fail) throw new Error("backend down");
        return { epoch: "e1", seq: 0, rows: [] };
      },
    });
    await waitFor(() => expect(toasts.toast.error).toHaveBeenCalledTimes(1));
    const [, options] = toasts.toast.error.mock.calls[0] as [
      string,
      { action: { onClick: () => void } },
    ];

    fail = false;
    options.action.onClick();

    await waitFor(() => expect(listCalls(rendered)).toHaveLength(2));
  });
});

describe("optimistic parking", () => {
  it("moves the row at once, before the server answers", async () => {
    let answer: (value: unknown) => void = () => {};
    renderInbox({
      listLifecycle: () => ({ epoch: "e1", seq: 0, rows: [] }),
      settle: () => new Promise((resolve) => (answer = resolve)),
    });
    fireEvent.click(await screen.findByLabelText("Settle thread"));

    expect(await screen.findByRole("region", { name: "Settled" })).toBeDefined();
    answer({ ok: true });
  });

  // A settle that did not happen must not look like one that did.
  it("takes a failed settle back and says so", async () => {
    renderInbox({
      listLifecycle: () => ({ epoch: "e1", seq: 0, rows: [] }),
      settle: () => {
        throw new Error("disk full");
      },
    });
    fireEvent.click(await screen.findByLabelText("Settle thread"));

    await waitFor(() =>
      expect(toasts.toast.error).toHaveBeenCalledWith(
        "Couldn't settle the thread",
        expect.objectContaining({ description: expect.stringContaining("disk full") }),
      ),
    );
    expect(screen.queryByRole("region", { name: "Settled" })).toBeNull();
    expect(screen.getByLabelText("Settle thread")).toBeDefined();
  });

  it("reports what the settle's reap stopped, in the window that settled", async () => {
    const rendered = renderInbox({
      listLifecycle: () => ({ epoch: "e1", seq: 0, rows: [] }),
      settle: () => ({ ok: true }),
    });
    fireEvent.click(await screen.findByLabelText("Settle thread"));

    await rendered.emitRealtime("lifecycle", {
      kind: "reaped",
      threadId: "thr_a",
      reaped: {
        enabled: true,
        terminalsClosed: [],
        terminalsFailed: 0,
        processesKilled: [{ pid: 1, command: "node vite" }],
        processesFailed: 0,
        worktreesSkipped: [],
      },
    });

    expect(toasts.toast).toHaveBeenCalledWith("Stopped 1 leftover process", {
      description: "node vite",
    });
  });

  // Every open window hears the report; only the one where the user acted
  // should speak.
  it("stays quiet about a reap another window started", async () => {
    const rendered = renderInbox({
      listLifecycle: () => ({ epoch: "e1", seq: 0, rows: [] }),
    });
    await screen.findByText("Alpha");

    await rendered.emitRealtime("lifecycle", {
      kind: "reaped",
      threadId: "thr_a",
      reaped: {
        enabled: true,
        terminalsClosed: [],
        terminalsFailed: 0,
        processesKilled: [{ pid: 1, command: "node vite" }],
        processesFailed: 0,
        worktreesSkipped: [],
      },
    });

    expect(toasts.toast).not.toHaveBeenCalled();
  });
});
