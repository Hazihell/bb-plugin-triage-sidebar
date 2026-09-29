// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ProjectCommand } from "./project-commands";
import { sidebarProject } from "./test-fixtures";

const app = await loadPluginApp(() => import("../app"));
const section = app.settingsSections.find((s) => s.id === "project-commands")!;

function render(
  stored: ProjectCommand[],
  save: (input: { commands: unknown[] }) => { commands: ProjectCommand[] } = (input) => ({
    commands: (input.commands as ProjectCommand[]).map((c, i) => ({ ...c, id: c.id ?? `id${i}` })),
  }),
) {
  return renderSlot(
    section,
    {},
    {
      sidebarThreads: {
        status: "ready",
        threads: [],
        projects: [sidebarProject("prj_1", "app"), sidebarProject("prj_2", "api")],
      },
      rpc: {
        listProjectCommands: () => ({ commands: stored }),
        saveProjectCommands: save,
      } as never,
    },
  );
}

afterEach(cleanup);

const DEV: ProjectCommand = { id: "a", name: "dev", command: "pnpm dev", isDevServer: true };
const TEST: ProjectCommand = { id: "b", name: "test", command: "pnpm test", isDevServer: false };

describe("ProjectCommandsSettings", () => {
  it("adds a command and saves the whole list, new rows without an id", async () => {
    const rendered = render([DEV]);
    fireEvent.click(await screen.findByRole("button", { name: /Add command/ }));
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    // An empty row cannot be saved.
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name of command 2"), { target: { value: "test" } });
    fireEvent.change(screen.getByLabelText("Shell command 2"), { target: { value: "pnpm test" } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(rendered.rpcCalls.find((c) => c.method === "saveProjectCommands")?.input).toEqual({
        projectId: "prj_1",
        commands: [DEV, { name: "test", command: "pnpm test", isDevServer: false }],
      }),
    );
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  it("reorders, keeps one dev server, and deletes", async () => {
    const rendered = render([DEV, TEST]);
    fireEvent.click(await screen.findByRole("button", { name: "Move command 2 up" }));
    // Now test is first; marking it the dev server unmarks dev.
    fireEvent.click(screen.getAllByRole("radio")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Delete command 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(rendered.rpcCalls.find((c) => c.method === "saveProjectCommands")?.input).toEqual({
        projectId: "prj_1",
        commands: [{ ...TEST, isDevServer: true }],
      }),
    );
  });

  it("shows the server's refusal as it words it", async () => {
    render([DEV], () => {
      throw new Error('Two commands are named "dev"');
    });
    fireEvent.change(await screen.findByLabelText("Shell command 1"), { target: { value: "vite" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText('Two commands are named "dev"')).toBeTruthy();
  });
});
