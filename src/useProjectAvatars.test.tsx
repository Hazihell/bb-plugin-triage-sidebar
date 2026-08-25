// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type { StoredAvatarRow } from "./server";
import type { ProjectAvatarsApi } from "./useProjectAvatars";

// The hook binds `@get-bb/plugin-sdk/app` at import time, so the test runtime
// has to be installed before this module is evaluated — the same reason the
// slot tests import `app.tsx` through `loadPluginApp`'s thunk.
installTestPluginRuntime();
const { useProjectAvatars } = await import("./useProjectAvatars");

afterEach(cleanup);

function row(overrides: Partial<StoredAvatarRow> = {}): StoredAvatarRow {
  return {
    projectId: "prj_1",
    customKind: null,
    customColor: null,
    customInitials: null,
    customEmoji: null,
    customImage: null,
    remoteImage: null,
    remoteUrl: null,
    fetchedAt: null,
    failedAt: null,
    failureCount: null,
    ...overrides,
  };
}

/** The hook needs a component to live in; this one also reports what it holds. */
let api: ProjectAvatarsApi;
function Probe() {
  api = useProjectAvatars();
  return (
    <ul>
      {[...api.rows.entries()].map(([projectId, stored]) => (
        <li key={projectId}>{`${projectId}:${stored.customEmoji ?? ""}`}</li>
      ))}
    </ul>
  );
}

const render = (rpc: Record<string, (input: never) => unknown>) =>
  renderSlot({ component: Probe }, {}, { rpc: rpc as never });

describe("useProjectAvatars", () => {
  it("reads the store once and keys the rows by project", async () => {
    const view = render({
      listProjectAvatars: () => ({
        rows: [row({ projectId: "prj_1" }), row({ projectId: "prj_2" })],
      }),
    });

    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(api.rows.get("prj_2")?.projectId).toBe("prj_2");
    expect(
      view.rpcCalls.filter((call) => call.method === "listProjectAvatars"),
    ).toHaveLength(1);
  });

  // The store is shared: another window, or the background fetch finishing,
  // has to reach this one without the user doing anything.
  it("re-reads when the backend signals the avatar channel", async () => {
    let emoji = "";
    const view = render({
      listProjectAvatars: () => ({ rows: [row({ customEmoji: emoji })] }),
    });
    await waitFor(() => expect(screen.getByText("prj_1:")).toBeDefined());

    emoji = "🐙";
    await view.emitRealtime("project-avatars", { projectId: "prj_1" });

    await waitFor(() => expect(screen.getByText("prj_1:🐙")).toBeDefined());
  });

  // Two reads in flight is the normal case — a signal arriving while the
  // first read is still out — and the older answer describes the store before
  // the change that caused the signal.
  it("lets the newest read win when responses land out of order", async () => {
    const pending: Array<(rows: StoredAvatarRow[]) => void> = [];
    const view = render({
      listProjectAvatars: () =>
        new Promise((resolve) => {
          pending.push((rows) => resolve({ rows }));
        }),
    });
    await waitFor(() => expect(pending).toHaveLength(1));

    await view.emitRealtime("project-avatars", { projectId: "prj_1" });
    await waitFor(() => expect(pending).toHaveLength(2));

    pending[1]!([row({ customEmoji: "🐙" })]);
    pending[0]!([row({ customEmoji: "🐝" })]);

    await waitFor(() => expect(screen.getByText("prj_1:🐙")).toBeDefined());
  });

  // Every project without a row already draws a monogram, so a store that
  // cannot be read degrades to the design's own fallback instead of taking
  // the sidebar down with it.
  it("keeps rendering when the store cannot be read", async () => {
    render({
      listProjectAvatars: () => {
        throw new Error("no database");
      },
    });

    await waitFor(() => expect(api.rows.size).toBe(0));
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("sends the user's choice as one write", async () => {
    const view = render({
      listProjectAvatars: () => ({ rows: [] }),
      setProjectAvatar: () => ({ ok: true }),
    });

    await api.set("prj_1", {
      kind: "monogram",
      color: "oklch(0.54 0.09 210)",
      initials: "BB",
    });

    expect(view.rpcCalls).toContainEqual({
      method: "setProjectAvatar",
      input: {
        projectId: "prj_1",
        custom: {
          kind: "monogram",
          color: "oklch(0.54 0.09 210)",
          initials: "BB",
        },
      },
    });
  });

  it("clears through the same write, so the fetched image survives", async () => {
    const view = render({
      listProjectAvatars: () => ({ rows: [] }),
      setProjectAvatar: () => ({ ok: true }),
    });

    await api.clear("prj_1");

    expect(view.rpcCalls).toContainEqual({
      method: "setProjectAvatar",
      input: { projectId: "prj_1", custom: { kind: "clear" } },
    });
  });

  // The caller asked for this fetch by hand, so it has to hear that the host
  // gave nothing rather than watch the avatar not change.
  it("reports whether a forced remote refresh found anything", async () => {
    let ok = true;
    render({
      listProjectAvatars: () => ({ rows: [] }),
      refreshProjectAvatar: () => ({ ok }),
    });

    expect(await api.refresh("prj_1")).toBe(true);
    ok = false;
    expect(await api.refresh("prj_1")).toBe(false);
  });

  // Unlike the read, a refused write is the user's own action failing, and
  // the sentence the backend wrote is the only thing that explains it.
  it("passes a refused write back to the caller", async () => {
    render({
      listProjectAvatars: () => ({ rows: [] }),
      setProjectAvatar: () => {
        throw new Error("An avatar must be a PNG, JPEG, WebP, GIF or SVG.");
      },
    });

    await expect(
      api.set("prj_1", { kind: "image", image: "data:text/html;base64,AA" }),
    ).rejects.toThrow(/must be a PNG/);
  });
});
