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
import { sidebarThread as thread, sidebarProject } from "./test-fixtures";

const app = await loadPluginApp(() => import("../app"));
const childrenChip = app.threadHeaderActions.find(
  (slot) => slot.id === "children",
)!;

function render() {
  return renderSlot(
    childrenChip,
    { threadId: "parent", projectId: "proj_1", isCompactViewport: false },
    {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "parent", title: "Parent" }),
          thread({
            id: "kid_a",
            title: "First child",
            parentThreadId: "parent",
            createdAt: 1,
          }),
          thread({
            id: "kid_b",
            title: "Second child",
            parentThreadId: "parent",
            createdAt: 2,
          }),
        ],
        projects: [sidebarProject("proj_1", "bb")],
      },
    },
  );
}

afterEach(cleanup);

describe("SubagentsChip", () => {
  it("lists the children, oldest first, in a portaled menu", async () => {
    render();
    fireEvent.keyDown(screen.getByRole("button", { name: "2 child threads" }), {
      key: "Enter",
    });
    const menu = await screen.findByRole("menu", { name: "2 child threads" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("First child"),
      expect.stringContaining("Second child"),
    ]);
    expect(menu.closest("[data-bb-plugin-root]")).not.toBeNull();
  });

  it("opens the child the user picks", async () => {
    const rendered = render();
    fireEvent.keyDown(screen.getByRole("button", { name: "2 child threads" }), {
      key: "Enter",
    });
    const menu = await screen.findByRole("menu", { name: "2 child threads" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Second child/ }));
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "kid_b",
      options: undefined,
    });
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "2 child threads" })).toBeNull(),
    );
  });

  it("closes on Escape", async () => {
    render();
    fireEvent.keyDown(screen.getByRole("button", { name: "2 child threads" }), {
      key: "Enter",
    });
    const menu = await screen.findByRole("menu", { name: "2 child threads" });
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "2 child threads" })).toBeNull(),
    );
  });
});
