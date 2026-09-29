// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ProjectCommandStatus } from "./project-commands";

const app = await loadPluginApp(() => import("../app"));
const chip = app.threadHeaderActions.find((slot) => slot.id === "run-command")!;

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

function render(
  commands: () => ProjectCommandStatus[],
  run: () => { outcome: "started" | "already-running"; terminalId: string } = () => ({
    outcome: "started",
    terminalId: "term_new",
  }),
) {
  return renderSlot(
    chip,
    { threadId: "thr_1", projectId: "prj_1", isCompactViewport: false },
    {
      rpc: {
        threadCommandStatus: () => ({ commands: commands() }),
        runProjectCommand: run,
        stopProjectCommand: () => ({ outcome: "stopped" }),
      } as never,
    },
  );
}

const callsTo = (rendered: ReturnType<typeof render>, method: string) =>
  rendered.rpcCalls.filter((call) => call.method === method);

afterEach(cleanup);

describe("RunCommandChip", () => {
  it("renders nothing for a project without commands", async () => {
    const rendered = render(() => []);
    await waitFor(() => expect(callsTo(rendered, "threadCommandStatus")).toHaveLength(1));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("starts the dev server from the play button", async () => {
    let running = false;
    const rendered = render(
      () => [dev(running ? "term_new" : null), test()],
      () => {
        running = true;
        return { outcome: "started", terminalId: "term_new" };
      },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Run dev" }));
    await waitFor(() =>
      expect(callsTo(rendered, "runProjectCommand")).toEqual([
        { method: "runProjectCommand", input: { threadId: "thr_1", commandId: "cmd_dev" } },
      ]),
    );
    // Refreshed after the run, so the button now offers the opposite.
    expect(await screen.findByRole("button", { name: "Stop dev" })).toBeTruthy();
  });

  it("offers stop, not a second copy, when the dev server is running", async () => {
    const rendered = render(() => [dev("term_live")]);
    fireEvent.click(await screen.findByRole("button", { name: "Stop dev" }));
    await waitFor(() =>
      expect(callsTo(rendered, "stopProjectCommand")).toEqual([
        { method: "stopProjectCommand", input: { threadId: "thr_1", commandId: "cmd_dev" } },
      ]),
    );
    expect(callsTo(rendered, "runProjectCommand")).toHaveLength(0);
  });

  it("says a command is already running when the server finds it live, and offers stop", async () => {
    const rendered = render(
      () => [dev()],
      () => ({ outcome: "already-running", terminalId: "term_live" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Run dev" }));
    const notice = await screen.findByText("dev is already running");
    fireEvent.click(within(notice.closest("[role=status]") as HTMLElement).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(callsTo(rendered, "stopProjectCommand")).toHaveLength(1));
  });

  it("lists the other commands in the menu, with stop for a running one", async () => {
    const rendered = render(() => [dev(), test("term_t")]);
    fireEvent.keyDown(await screen.findByRole("button", { name: "More commands" }), { key: "Enter" });
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([expect.stringContaining("Stop test")]);
    fireEvent.click(items[0]!);
    await waitFor(() =>
      expect(callsTo(rendered, "stopProjectCommand")).toEqual([
        { method: "stopProjectCommand", input: { threadId: "thr_1", commandId: "cmd_test" } },
      ]),
    );
  });

  it("uses a Run menu when the project has no dev server", async () => {
    const rendered = render(() => [test()]);
    fireEvent.keyDown(await screen.findByRole("button", { name: "Run a command" }), { key: "Enter" });
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /test/ }));
    await waitFor(() => expect(callsTo(rendered, "runProjectCommand")).toHaveLength(1));
  });
});
