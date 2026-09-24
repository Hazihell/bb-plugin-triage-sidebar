// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { StoredAvatarRow } from "./server";
import { avatarBackground } from "./project-avatar";
import { sidebarProject } from "./test-fixtures";

// Loaded through the harness for the same reason the sidebar tests are: the
// plugin's `@get-bb/plugin-sdk/app` import binds at module evaluation.
const app = await loadPluginApp(() => import("../app"));
const section = app.settingsSections.find((s) => s.id === "project-avatars")!;

const PROJECTS = [
  sidebarProject("prj_1", "my cool app"),
  sidebarProject("prj_2", "captouro"),
];

function row(overrides: Partial<StoredAvatarRow> = {}): StoredAvatarRow {
  return {
    projectId: "prj_1",
    customKind: null,
    customColor: null,
    customInitials: null,
    customEmoji: null,
    customImage: null,
    faviconImage: null,
    faviconPath: null,
    faviconMtime: null,
    faviconScannedAt: null,
    faviconMissingAt: null,
    remoteImage: null,
    remoteUrl: null,
    fetchedAt: null,
    failedAt: null,
    failureCount: null,
    ...overrides,
  };
}

function render(
  options: {
    rows?: StoredAvatarRow[];
    setProjectAvatar?: () => { ok: boolean };
    setProjectAvatarFromUrl?: () => { image: string };
    refreshProjectAvatar?: () => { ok: boolean };
    projects?: typeof PROJECTS;
  } = {},
) {
  return renderSlot(
    section,
    {},
    {
      sidebarThreads: {
        status: "ready",
        threads: [],
        projects: options.projects ?? PROJECTS,
      },
      rpc: {
        listProjectAvatars: () => ({ rows: options.rows ?? [] }),
        setProjectAvatar: options.setProjectAvatar ?? (() => ({ ok: true })),
        setProjectAvatarFromUrl:
          options.setProjectAvatarFromUrl ??
          (() => ({ image: "data:image/png;base64,AQID" })),
        refreshProjectAvatar:
          options.refreshProjectAvatar ?? (() => ({ ok: true })),
      } as never,
    },
  );
}

/** The row for one project, so two projects' controls never get mixed up. */
function projectRow(name: string): HTMLElement {
  return screen.getByText(name).closest("li") as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("registration", () => {
  it("is registered as a settings section of its own", () => {
    expect(section.title).toBe("Project avatars");
    // Avatars and auto-archive are separate sections rather than one
    // "Settings" pile: they share nothing but the page they land on.
    expect(app.settingsSections.map((s) => s.id)).toEqual([
      "project-avatars",
      "auto-archive",
    ]);
  });

  // Editing lives in Settings and nowhere else, so the sidebar's per-thread
  // menu stays about the thread under the cursor.
  it("adds no thread menu surface of its own", () => {
    expect(app.threadPanelActions).toHaveLength(0);
    expect(app.messageActions).toHaveLength(0);
  });
});

describe("ProjectAvatarSettings", () => {
  it("lists every project, customized or not", async () => {
    render();
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(screen.getByText("my cool app")).toBeDefined();
    expect(screen.getByText("captouro")).toBeDefined();
  });

  it("previews the avatar the sidebar would draw", async () => {
    render({ rows: [row({ customKind: "emoji", customEmoji: "🐙" })] });

    // prj_1 has a stored emoji; prj_2 has nothing and falls back to letters.
    await waitFor(() => expect(screen.getByText("🐙")).toBeDefined());
    expect(within(projectRow("captouro")).getByText("C")).toBeDefined();
  });

  it("says where each project's avatar comes from", async () => {
    render({ rows: [row({ remoteImage: "data:image/png;base64,AA" })] });
    await waitFor(() =>
      expect(
        within(projectRow("my cool app")).getByText("From the git host"),
      ).toBeDefined(),
    );
    expect(within(projectRow("captouro")).getByText("Generated")).toBeDefined();
  });

  // The path is the only thing that explains a wrong icon, and the only thing
  // the user can go and change.
  it("names the file a project's own icon came from", async () => {
    render({
      rows: [
        row({
          faviconImage: "data:image/svg+xml;base64,AA",
          faviconPath: "apps/web/public/favicon.svg",
          // A cached host image is still in the row; the favicon outranks it,
          // and the caption has to say which one is actually being drawn.
          remoteImage: "data:image/png;base64,AA",
        }),
      ],
    });

    await waitFor(() =>
      expect(
        within(projectRow("my cool app")).getByText(
          "Project folder: apps/web/public/favicon.svg",
        ),
      ).toBeDefined(),
    );
  });

  it("stores the typed initials on the chosen preset hue", async () => {
    const view = render();
    const target = projectRow("my cool app");

    fireEvent.change(
      within(target).getByLabelText("Initials for my cool app"),
      { target: { value: "MX" } },
    );
    fireEvent.click(within(target).getByLabelText("Hue 210"));
    fireEvent.click(within(target).getByText("Use monogram"));

    await waitFor(() =>
      expect(view.rpcCalls).toContainEqual({
        method: "setProjectAvatar",
        input: {
          projectId: "prj_1",
          custom: {
            kind: "monogram",
            color: avatarBackground(210),
            initials: "MX",
          },
        },
      }),
    );
  });

  // A free colour input can be told to pick white, and the monogram's text is
  // white. Every preset comes out of `avatarBackground`, which is where the
  // contrast and gamut guarantees live.
  it("offers a preset grid rather than an open colour picker", async () => {
    const { container } = render();
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));

    expect(container.querySelector('input[type="color"]')).toBeNull();
    const swatches = within(projectRow("captouro")).getByRole("group", {
      name: "Background colour for captouro",
    });
    expect(within(swatches).getAllByRole("button")).toHaveLength(12);
  });

  it("stores an emoji with the same background as the monogram", async () => {
    const view = render();
    const target = projectRow("captouro");

    fireEvent.change(within(target).getByLabelText("Emoji for captouro"), {
      target: { value: "🐝" },
    });
    fireEvent.click(within(target).getByLabelText("Hue 60"));
    fireEvent.click(within(target).getByText("Use emoji"));

    await waitFor(() =>
      expect(view.rpcCalls).toContainEqual({
        method: "setProjectAvatar",
        input: {
          projectId: "prj_2",
          custom: { kind: "emoji", emoji: "🐝", color: avatarBackground(60) },
        },
      }),
    );
  });

  it("passes a pasted data URL straight through", async () => {
    const view = render();
    const target = projectRow("my cool app");
    const image = "data:image/png;base64,AAAA";

    fireEvent.change(
      within(target).getByLabelText("Image URL for my cool app"),
      { target: { value: image } },
    );
    fireEvent.click(within(target).getByText("Use image"));

    await waitFor(() =>
      expect(view.rpcCalls).toContainEqual({
        method: "setProjectAvatar",
        input: { projectId: "prj_1", custom: { kind: "image", image } },
      }),
    );
  });

  // The download happens on the server, never in this window: an image host
  // that sends no permissive CORS header is readable in a browser tab and
  // invisible to `fetch` here, and the user can neither see that difference
  // nor fix it.
  it("hands a pasted link to the backend instead of fetching it", async () => {
    const browserFetch = vi.fn();
    vi.stubGlobal("fetch", browserFetch);
    const view = render();
    const target = projectRow("my cool app");

    fireEvent.change(
      within(target).getByLabelText("Image URL for my cool app"),
      { target: { value: "https://example.org/logo.png" } },
    );
    fireEvent.click(within(target).getByText("Use image"));

    await waitFor(() =>
      expect(view.rpcCalls).toContainEqual({
        method: "setProjectAvatarFromUrl",
        input: { projectId: "prj_1", url: "https://example.org/logo.png" },
      }),
    );
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it("shows the backend's own sentence about an address", async () => {
    const target = (
      render({
        setProjectAvatarFromUrl: () => {
          throw new Error("That address answered 404.");
        },
      }),
      projectRow("my cool app")
    );

    fireEvent.change(
      within(target).getByLabelText("Image URL for my cool app"),
      { target: { value: "https://example.org/gone.png" } },
    );
    fireEvent.click(within(target).getByText("Use image"));

    await waitFor(() =>
      expect(within(target).getByRole("alert").textContent).toContain("404"),
    );
  });

  // The backend refuses in one sentence written for a person; showing it is
  // the whole point of letting the mutation reject.
  it("shows the backend's own refusal", async () => {
    const target = (
      render({
        setProjectAvatar: () => {
          throw new Error("An avatar must be a PNG, JPEG, WebP, GIF or SVG.");
        },
      }),
      projectRow("my cool app")
    );

    fireEvent.change(
      within(target).getByLabelText("Image URL for my cool app"),
      { target: { value: "data:text/html;base64,AAAA" } },
    );
    fireEvent.click(within(target).getByText("Use image"));

    await waitFor(() =>
      expect(within(target).getByRole("alert").textContent).toContain(
        "must be a PNG",
      ),
    );
  });

  it("clears a custom avatar back to remote-or-monogram", async () => {
    const view = render({ rows: [row({ customKind: "emoji", customEmoji: "🐙" })] });
    const target = projectRow("my cool app");

    await waitFor(() =>
      expect(within(target).getByText("Clear").hasAttribute("disabled")).toBe(
        false,
      ),
    );
    fireEvent.click(within(target).getByText("Clear"));

    await waitFor(() =>
      expect(view.rpcCalls).toContainEqual({
        method: "setProjectAvatar",
        input: { projectId: "prj_1", custom: { kind: "clear" } },
      }),
    );
  });

  // Offering an undo for a change nobody made is a promise the row cannot keep.
  it("offers nothing to clear when the user has set nothing", async () => {
    render();
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    const clear = within(projectRow("captouro")).getByText("Clear");
    expect(clear.hasAttribute("disabled")).toBe(true);
  });

  it("forces one project's remote fetch and reports an empty answer", async () => {
    const view = render({ refreshProjectAvatar: () => ({ ok: false }) });
    const target = projectRow("captouro");

    fireEvent.click(within(target).getByText("Refresh from git host"));

    await waitFor(() =>
      expect(view.rpcCalls).toContainEqual({
        method: "refreshProjectAvatar",
        input: { projectId: "prj_2" },
      }),
    );
    expect(within(target).getByRole("alert").textContent).toContain(
      "no avatar",
    );
  });

  it("says so when there are no projects at all", async () => {
    render({ projects: [] });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("No projects"),
    );
  });
});
