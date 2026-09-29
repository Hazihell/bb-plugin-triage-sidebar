// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ProjectCommand, ProjectCommandStatus } from "./project-commands";

type Handlers = Record<string, (input: never) => unknown>;
let handlers: Handlers = {};
const calls: Array<{ method: string; input: unknown }> = [];
// One object for the whole file, as bb hands a component one client.
const rpc = {
  call: async (method: string, input: unknown) => {
    calls.push({ method, input });
    const handler = handlers[method];
    if (handler === undefined) throw new Error(`no handler for ${method}`);
    return handler(input as never);
  },
};
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => rpc }));

const { ThreadCommandsProvider } = await import("./ThreadCommandsProvider");
const { ThreadCommandsButton } = await import("./ThreadCommandsMenu");

const dev = (terminalId: string | null = null): ProjectCommandStatus => ({
  id: "cmd_dev",
  name: "dev",
  command: "pnpm dev",
  isDevServer: true,
  terminalId,
});
const test = (terminalId: string | null = null): ProjectCommandStatus => ({
  id: "cmd_test",
  name: "test",
  command: "pnpm test",
  isDevServer: false,
  terminalId,
});

/** Status answers for thr_1, read afresh on every call. */
function serve(status: () => ProjectCommandStatus[], extra: Handlers = {}) {
  handlers = {
    threadsCommandStatus: () => ({ statuses: [{ threadId: "thr_1", commands: status() }] }),
    runProjectCommand: () => ({ outcome: "started", terminalId: "term_new" }),
    stopProjectCommand: () => ({ outcome: "stopped" }),
    ...extra,
  };
}

/** A stand-in for the row, whose full-bleed link must not see the click. */
function Row({ onRow, projectId = "prj_1" }: { onRow?: () => void; projectId?: string }) {
  return (
    <ThreadCommandsProvider projects={[{ id: "prj_1", name: "app" }]}>
      <div onClick={onRow}>
        <ThreadCommandsButton thread={{ id: "thr_1", projectId }} row="card" />
      </div>
    </ThreadCommandsProvider>
  );
}

const callsTo = (method: string) => calls.filter((call) => call.method === method);
const openPopover = async () => {
  fireEvent.click(await screen.findByRole("button", { name: /^Project commands/ }));
  return screen.findByRole("dialog", { name: "Commands for app" });
};

beforeEach(() => {
  calls.length = 0;
});
afterEach(cleanup);

describe("ThreadCommandsButton", () => {
  it("renders nothing for a thread whose project the list does not know", () => {
    serve(() => []);
    render(<Row projectId="prj_gone" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers to add the first command when the project has none", async () => {
    serve(() => []);
    render(<Row />);
    const popover = await openPopover();
    expect(await within(popover).findByText("No commands for app yet.")).toBeDefined();
    expect(within(popover).getByRole("button", { name: "Edit commands…" })).toBeDefined();
  });

  it("lists the dev server first with a play glyph, and runs a command", async () => {
    serve(() => [test(), dev()]);
    render(<Row />);
    const popover = await openPopover();
    const rows = await within(popover).findAllByRole("button", { name: /^Run / });
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["Run dev", "Run test"]);
    expect(rows[0]!.querySelector("[data-icon]")!.getAttribute("data-icon")).toBe("Play");
    fireEvent.click(rows[1]!);
    await waitFor(() =>
      expect(callsTo("runProjectCommand").map((call) => call.input)).toEqual([
        { threadId: "thr_1", commandId: "cmd_test" },
      ]),
    );
  });

  it("shows a running command as Stop, with a dot on the icon, and stops it", async () => {
    let running = true;
    serve(() => [dev(running ? "term_live" : null)], {
      stopProjectCommand: () => {
        running = false;
        return { outcome: "stopped" };
      },
    });
    render(<Row />);
    const trigger = await screen.findByRole("button", { name: "Project commands, one running" });
    // Always drawn while something runs, not only on hover.
    expect(trigger.className).not.toContain("opacity-0");
    fireEvent.click(trigger);
    const popover = await screen.findByRole("dialog", { name: "Commands for app" });
    fireEvent.click(within(popover).getByRole("button", { name: "Stop dev" }));
    await waitFor(() =>
      expect(callsTo("stopProjectCommand").map((call) => call.input)).toEqual([
        { threadId: "thr_1", commandId: "cmd_dev" },
      ]),
    );
    expect(await within(popover).findByRole("button", { name: "Run dev" })).toBeDefined();
    // Nothing runs any more: the dot goes, and the icon is drawn only while open.
    expect(screen.getByRole("button", { name: "Project commands" })).toBeDefined();
  });

  it("says a command is already running and offers to stop it", async () => {
    serve(() => [dev()], {
      runProjectCommand: () => ({ outcome: "already-running", terminalId: "term_live" }),
    });
    render(<Row />);
    const popover = await openPopover();
    fireEvent.click(await within(popover).findByRole("button", { name: "Run dev" }));
    const notice = await within(popover).findByText("dev is already running");
    fireEvent.click(within(notice.parentElement!).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(callsTo("stopProjectCommand")).toHaveLength(1));
  });

  it("edits the project's list in the shared editor and re-reads the row after saving", async () => {
    let stored: ProjectCommand[] = [];
    serve(() => stored.map((command) => ({ ...command, terminalId: null })), {
      listProjectCommands: () => ({ commands: stored }),
      saveProjectCommands: (input: { commands: ProjectCommand[] }) => {
        stored = input.commands.map((command, index) => ({ ...command, id: `id${index}` }));
        return { commands: stored };
      },
    });
    render(<Row />);
    const popover = await openPopover();
    fireEvent.click(within(popover).getByRole("button", { name: "Edit commands…" }));
    fireEvent.click(await within(popover).findByRole("button", { name: /Add command/ }));
    fireEvent.change(within(popover).getByLabelText("Name of command 1"), { target: { value: "dev" } });
    fireEvent.change(within(popover).getByLabelText("Shell command 1"), {
      target: { value: "pnpm dev" },
    });
    fireEvent.click(within(popover).getByRole("radio"));
    const reads = callsTo("threadsCommandStatus").length;
    fireEvent.click(within(popover).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(callsTo("saveProjectCommands").map((call) => call.input)).toEqual([
        {
          projectId: "prj_1",
          commands: [{ name: "dev", command: "pnpm dev", isDevServer: true }],
        },
      ]),
    );
    await waitFor(() => expect(callsTo("threadsCommandStatus").length).toBeGreaterThan(reads));
    fireEvent.click(within(popover).getByRole("button", { name: "Back to commands" }));
    expect(await within(popover).findByRole("button", { name: "Run dev" })).toBeDefined();
  });

  it("never selects the row, from the icon or from inside the popover", async () => {
    serve(() => [dev()]);
    const onRow = vi.fn();
    render(<Row onRow={onRow} />);
    const popover = await openPopover();
    fireEvent.click(await within(popover).findByRole("button", { name: "Run dev" }));
    fireEvent.click(within(popover).getByRole("button", { name: "Edit commands…" }));
    await waitFor(() => expect(callsTo("runProjectCommand")).toHaveLength(1));
    expect(onRow).not.toHaveBeenCalled();
  });
});
