import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type CreateFakePluginHostOptions,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin, {
  isAllowedAvatarDataUrl,
  localSourcePath,
  MAX_AVATAR_BYTES,
  parseAutoArchiveDays,
  type StoredAvatarRow,
  type StoredLifecycleRow,
} from "./server";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The plugin loaded against the fake host, so these tests exercise the real
 * registrations — migrations, events, schedule — rather than a copy of them.
 */
function load(options: CreateFakePluginHostOptions = {}): FakePluginHost {
  const host = createFakePluginHost({ pluginId: "triage-sidebar", ...options });
  plugin(host.bb);
  return host;
}

const listRows = async (host: FakePluginHost): Promise<StoredLifecycleRow[]> =>
  ((await host.harness.behavior.callRpc("listLifecycle", {})) as {
    rows: StoredLifecycleRow[];
  }).rows;

/** A thread that has been settled long enough for any sane retention period. */
async function settleLongAgo(
  host: FakePluginHost,
  threadId: string,
): Promise<void> {
  await host.harness.behavior.callRpc("settle", { threadId });
  host.bb.storage
    .database()
    .prepare(`UPDATE thread_lifecycle SET settled_at = ? WHERE thread_id = ?`)
    .run(Date.now() - 30 * DAY_MS, threadId);
}

describe("parseAutoArchiveDays", () => {
  it("reads a whole number of days", () => {
    expect(parseAutoArchiveDays("14")).toBe(14);
  });

  // The setting is a free-text string, so the sweep must survive a typo
  // without deciding that everything settled is already overdue.
  it("falls back to 7 on anything unusable", () => {
    expect(parseAutoArchiveDays("soon")).toBe(7);
    expect(parseAutoArchiveDays("0")).toBe(7);
    expect(parseAutoArchiveDays("-3")).toBe(7);
    expect(parseAutoArchiveDays("1.5")).toBe(7);
    expect(parseAutoArchiveDays(undefined)).toBe(7);
  });
});

describe("working duration", () => {
  it("records the start when bb reports a thread going active", async () => {
    const host = load();
    const before = Date.now();
    await host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_run" }),
    });

    const [row] = await listRows(host);
    expect(row?.threadId).toBe("thr_run");
    expect(row?.startedWorkingAt).toBeGreaterThanOrEqual(before);
    // The sidebar only re-reads on the channel, so a silent write would leave
    // the elapsed label missing until something unrelated refreshed.
    expect(
      host.harness.inspection.realtimeSignals.some(
        (signal) => signal.channel === "lifecycle",
      ),
    ).toBe(true);
  });

  it("clears the start when the thread goes idle", async () => {
    const host = load();
    await host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_run" }),
    });
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_run" }),
      lastAssistantText: null,
    });

    // Nothing parked it, so the row has nothing left to say and goes away
    // entirely rather than lingering as an all-null row.
    expect(await listRows(host)).toEqual([]);
  });

  it("keeps a parked thread's shelf when its run ends", async () => {
    const host = load();
    await host.harness.behavior.callRpc("settle", { threadId: "thr_parked" });
    await host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_parked" }),
    });
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "thr_parked" }),
      error: "boom",
    });

    const [row] = await listRows(host);
    expect(row?.settledAt).not.toBeNull();
    expect(row?.startedWorkingAt).toBeNull();
  });
});

describe("auto-archive sweep", () => {
  it("archives a settled thread once it is older than the retention period", async () => {
    const host = load({
      sdk: {
        threads: {
          get: ({ threadId }) => makeThreadResponse({ id: threadId }),
          interactions: { list: () => [] },
          archive: () => ({ archived: 1 }),
        },
      },
    });
    await settleLongAgo(host, "thr_old");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([
      [{ threadId: "thr_old" }],
    ]);
    // Archived threads have no shelf, and a leftover row would park the
    // thread again the moment it was unarchived.
    expect(await listRows(host)).toEqual([]);
  });

  it("leaves a thread that is working alone", async () => {
    const host = load({
      sdk: {
        threads: {
          get: ({ threadId }) =>
            makeThreadResponse({ id: threadId, status: "active" }),
          interactions: { list: () => [] },
          archive: () => ({ archived: 1 }),
        },
      },
    });
    await settleLongAgo(host, "thr_busy");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    // The row stays, so the thread keeps its place and the next sweep can
    // reconsider it once the work finishes.
    expect(await listRows(host)).toHaveLength(1);
  });

  it("leaves a thread that is waiting on the user alone", async () => {
    const host = load({
      sdk: {
        threads: {
          get: ({ threadId }) => makeThreadResponse({ id: threadId }),
          interactions: {
            list: ({ threadId }) => [
              { id: "int_1", threadId, status: "pending" },
            ],
          },
          archive: () => ({ archived: 1 }),
        },
      },
    });
    await settleLongAgo(host, "thr_asking");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  });

  it("does nothing while auto-archive is switched off", async () => {
    const host = load({
      settings: { autoArchiveEnabled: false },
      sdk: {
        threads: {
          get: ({ threadId }) => makeThreadResponse({ id: threadId }),
          interactions: { list: () => [] },
          archive: () => ({ archived: 1 }),
        },
      },
    });
    await settleLongAgo(host, "thr_old");

    await host.harness.behavior.runSchedule("auto-archive");

    // Not even a read: the switch is off, so the sweep never inspects a thread.
    expect(host.harness.inspection.sdk.calls).toEqual([]);
    expect(await listRows(host)).toHaveLength(1);
  });

  it("forgets the row of a thread bb no longer has", async () => {
    const host = load({
      sdk: {
        threads: {
          get: () => {
            throw new Error("not found");
          },
          interactions: { list: () => [] },
          archive: () => ({ archived: 1 }),
        },
      },
    });
    await settleLongAgo(host, "thr_gone");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    expect(await listRows(host)).toEqual([]);
  });

  it("does not archive a thread that spoke to the user since the settle", async () => {
    // The regression. The sidebar reads new attention after a settle as
    // un-settling, so this thread is visibly back in the inbox — but nothing
    // clears `settled_at`, and the sweep used to select on that column alone
    // and guard only with "is it busy right now".
    const host = load({
      sdk: {
        threads: {
          get: ({ threadId }) =>
            makeThreadResponse({
              id: threadId,
              status: "idle",
              latestAttentionAt: Date.now() - DAY_MS,
            }),
          interactions: { list: () => [] },
          archive: () => ({ archived: 1 }),
        },
      },
    });
    await settleLongAgo(host, "thr_spoke");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    // And the stale row goes, so this is not a candidate the sweep has to talk
    // itself out of again every hour.
    expect(await listRows(host)).toEqual([]);
  });

  it("honours a retention period the user set", async () => {
    const host = load({
      settings: { autoArchiveDays: "60" },
      sdk: {
        threads: {
          get: ({ threadId }) => makeThreadResponse({ id: threadId }),
          interactions: { list: () => [] },
          archive: () => ({ archived: 1 }),
        },
      },
    });
    // Settled 30 days ago: overdue at the default 7, still fresh at 60.
    await settleLongAgo(host, "thr_recent");

    await host.harness.behavior.runSchedule("auto-archive");

    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    expect(await listRows(host)).toHaveLength(1);
  });
});

const listAvatars = async (host: FakePluginHost): Promise<StoredAvatarRow[]> =>
  ((await host.harness.behavior.callRpc("listProjectAvatars", {})) as {
    rows: StoredAvatarRow[];
  }).rows;

/** A one-pixel PNG, small enough to write out in full. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * A fake `fetch`, so no test here touches a git host. Returns the recorder as
 * well, because "did not ask at all" is the assertion several of these make.
 */
function stubFetch(
  respond: (url: string) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const fake = vi.fn(async (input: unknown) => respond(String(input)));
  vi.stubGlobal("fetch", fake);
  return fake;
}

const imageResponse = (
  bytes: Buffer = PNG_BYTES,
  contentType = "image/png",
): Response =>
  // A copy into a plain Uint8Array: Buffer is not in the DOM's BodyInit.
  new Response(new Uint8Array(bytes), {
    headers: { "content-type": contentType },
  });

/** The host id `system.config` reports for the machine running the server. */
const OWN_HOST = "hst_this_machine";

/** A host with one project, its git remote pointing at GitHub. */
function loadWithProject(
  options: {
    gitRemoteUrl?: string | null;
    settings?: CreateFakePluginHostOptions["settings"];
    /** A checkout on this machine, when the test is about the local scan. */
    sourcePath?: string;
    /** The machine the source is enrolled on; defaults to this one. */
    sourceHostId?: string;
    /** What `system.config` answers, for the cases where it cannot say. */
    primaryHostId?: string | null;
  } = {},
): FakePluginHost {
  const project = {
    id: "prj_1",
    gitRemoteUrl:
      options.gitRemoteUrl === undefined
        ? "git@github.com:get-bb/bb.git"
        : options.gitRemoteUrl,
    sources:
      options.sourcePath === undefined
        ? []
        : [
            {
              id: "src_1",
              projectId: "prj_1",
              isDefault: true,
              type: "local_path",
              hostId: options.sourceHostId ?? OWN_HOST,
              path: options.sourcePath,
            },
          ],
  };
  return load({
    settings: options.settings,
    sdk: {
      projects: {
        list: () => [project],
        get: () => project,
      },
      system: {
        config: () => ({
          primaryHostId:
            options.primaryHostId === undefined
              ? OWN_HOST
              : options.primaryHostId,
        }),
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isAllowedAvatarDataUrl", () => {
  it("accepts the image types the sidebar renders", () => {
    for (const type of ["png", "jpeg", "webp", "gif", "svg+xml"]) {
      expect(isAllowedAvatarDataUrl(`data:image/${type};base64,AAAA`)).toBe(
        true,
      );
    }
  });

  // The string ends up in an `<img src>` in bb's own window, so anything that
  // is not plainly an image must never reach it.
  it("rejects anything that is not a base64 image data URL", () => {
    expect(isAllowedAvatarDataUrl("https://example.org/a.png")).toBe(false);
    expect(isAllowedAvatarDataUrl("data:text/html;base64,AAAA")).toBe(false);
    expect(isAllowedAvatarDataUrl("data:image/png,AAAA")).toBe(false);
    expect(
      isAllowedAvatarDataUrl("javascript:alert(1)//data:image/png;base64,AA"),
    ).toBe(false);
    expect(isAllowedAvatarDataUrl("data:image/png;base64,<svg>")).toBe(false);
  });

  it("rejects an image past the size cap", () => {
    const huge = `data:image/png;base64,${"A".repeat(MAX_AVATAR_BYTES)}`;
    expect(isAllowedAvatarDataUrl(huge)).toBe(false);
  });
});

describe("setProjectAvatar", () => {
  it("stores a colour and initials, and tells the frontend", async () => {
    const host = load();
    await host.harness.behavior.callRpc("setProjectAvatar", {
      projectId: "prj_1",
      custom: { kind: "monogram", color: "oklch(0.7 0.1 250)", initials: "BB" },
    });

    expect(await listAvatars(host)).toEqual([
      expect.objectContaining({
        projectId: "prj_1",
        customKind: "monogram",
        customColor: "oklch(0.7 0.1 250)",
        customInitials: "BB",
      }),
    ]);
    expect(
      host.harness.inspection.realtimeSignals.some(
        (signal) => signal.channel === "project-avatars",
      ),
    ).toBe(true);
  });

  it("stores an emoji with its background colour", async () => {
    const host = load();
    await host.harness.behavior.callRpc("setProjectAvatar", {
      projectId: "prj_1",
      custom: { kind: "emoji", emoji: "🐝", color: "#ffcc00" },
    });

    const [row] = await listAvatars(host);
    expect(row).toMatchObject({
      customKind: "emoji",
      customEmoji: "🐝",
      customColor: "#ffcc00",
      customInitials: null,
    });
  });

  it("stores an image data URL", async () => {
    const host = load();
    const image = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;
    await host.harness.behavior.callRpc("setProjectAvatar", {
      projectId: "prj_1",
      custom: { kind: "image", image },
    });

    const [row] = await listAvatars(host);
    expect(row).toMatchObject({ customKind: "image", customImage: image });
  });

  it("refuses an image that is not one of the allowed types", async () => {
    const host = load();
    await expect(
      host.harness.behavior.callRpc("setProjectAvatar", {
        projectId: "prj_1",
        custom: { kind: "image", image: "data:text/html;base64,AAAA" },
      }),
    ).rejects.toThrow(/data URL/);

    expect(await listAvatars(host)).toEqual([]);
  });

  it("refuses an image past the size cap", async () => {
    const host = load();
    await expect(
      host.harness.behavior.callRpc("setProjectAvatar", {
        projectId: "prj_1",
        custom: {
          kind: "image",
          image: `data:image/png;base64,${"A".repeat(MAX_AVATAR_BYTES)}`,
        },
      }),
    ).rejects.toThrow(/KB/);
  });

  it("forgets a project whose avatar is cleared", async () => {
    const host = load();
    await host.harness.behavior.callRpc("setProjectAvatar", {
      projectId: "prj_1",
      custom: { kind: "monogram", color: "#123456", initials: "B" },
    });
    await host.harness.behavior.callRpc("setProjectAvatar", {
      projectId: "prj_1",
      custom: { kind: "clear" },
    });

    // Nothing custom and nothing fetched: the row has nothing left to say.
    expect(await listAvatars(host)).toEqual([]);
  });

  // Clearing a custom avatar is how a user asks for the fetched one back, so
  // it must not take the cache with it.
  it("keeps the fetched image when the custom one is cleared", async () => {
    const host = loadWithProject();
    stubFetch(() => imageResponse());
    await host.harness.behavior.runSchedule("project-avatars");

    await host.harness.behavior.callRpc("setProjectAvatar", {
      projectId: "prj_1",
      custom: { kind: "image", image: "data:image/png;base64,AAAA" },
    });
    await host.harness.behavior.callRpc("setProjectAvatar", {
      projectId: "prj_1",
      custom: { kind: "clear" },
    });

    const [row] = await listAvatars(host);
    expect(row?.customKind).toBeNull();
    expect(row?.remoteImage).toMatch(/^data:image\/png;base64,/);
  });
});

describe("remote avatar sweep", () => {
  it("caches the image the git host serves", async () => {
    const host = loadWithProject();
    const fake = stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    expect(fake.mock.calls[0]?.[0]).toBe(
      "https://github.com/get-bb.png?size=128",
    );
    const [row] = await listAvatars(host);
    expect(row).toMatchObject({
      projectId: "prj_1",
      remoteUrl: "https://github.com/get-bb.png?size=128",
      remoteImage: `data:image/png;base64,${PNG_BYTES.toString("base64")}`,
      failedAt: null,
      failureCount: 0,
    });
    expect(row?.fetchedAt).toBeGreaterThan(0);
  });

  // The switch is a promise about outbound requests, so it has to be checked
  // before anything is read, not before anything is stored.
  it("makes no request at all while the setting is off", async () => {
    const host = loadWithProject({ settings: { remoteAvatarsEnabled: false } });
    const fake = stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    expect(fake).not.toHaveBeenCalled();
    expect(await listAvatars(host)).toEqual([]);
  });

  // With both halves off there is nothing left for the sweep to decide, so it
  // does not even ask bb what the projects are.
  it("reads nothing at all when both avatar sources are off", async () => {
    const host = loadWithProject({
      settings: { remoteAvatarsEnabled: false, localFaviconsEnabled: false },
    });

    await host.harness.behavior.runSchedule("project-avatars");

    expect(host.harness.inspection.sdk.callsTo("projects.list")).toEqual([]);
  });

  it("asks nothing for a project with no usable remote", async () => {
    const host = loadWithProject({ gitRemoteUrl: null });
    const fake = stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    expect(fake).not.toHaveBeenCalled();
    expect(await listAvatars(host)).toEqual([]);
  });

  it("does not ask twice for an image it already has", async () => {
    const host = loadWithProject();
    const fake = stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");
    await host.harness.behavior.runSchedule("project-avatars");

    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("records a failure and backs off", async () => {
    const host = loadWithProject();
    stubFetch(() => new Response("nope", { status: 404 }));

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.failureCount).toBe(1);
    expect(row?.failedAt).toBeGreaterThan(0);
    expect(row?.remoteImage).toBeNull();
  });

  // A host that is briefly down must not cost the user an avatar they had.
  it("keeps the previous image when a later fetch fails", async () => {
    const host = loadWithProject();
    stubFetch(() => imageResponse());
    await host.harness.behavior.runSchedule("project-avatars");

    // The sweep never re-asks for an image it already has, so the second
    // attempt is the one the user asks for from the Settings panel.
    stubFetch(() => {
      throw new Error("connection refused");
    });
    await host.harness.behavior.callRpc("refreshProjectAvatar", {
      projectId: "prj_1",
    });

    const [row] = await listAvatars(host);
    expect(row?.remoteImage).toMatch(/^data:image\/png;base64,/);
    expect(row?.failureCount).toBe(1);
  });

  // A private forge answers a signed-out request with its sign-in page and a
  // 200, so the status alone does not mean we were given an image.
  it("refuses a response that is not an image", async () => {
    const host = loadWithProject();
    stubFetch(() => imageResponse(PNG_BYTES, "text/html"));

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.remoteImage).toBeNull();
    expect(row?.failureCount).toBe(1);
  });

  it("refuses a body past the size cap", async () => {
    const host = loadWithProject();
    stubFetch(() => imageResponse(Buffer.alloc(MAX_AVATAR_BYTES + 1)));

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.remoteImage).toBeNull();
    expect(row?.failureCount).toBe(1);
  });

  it("refetches when the project's remote changed", async () => {
    const host = loadWithProject();
    const fake = stubFetch(() => imageResponse());
    await host.harness.behavior.runSchedule("project-avatars");

    // The cached image belongs to a different owner now.
    host.bb.storage
      .database()
      .prepare(`UPDATE project_avatar SET remote_url = ? WHERE project_id = ?`)
      .run("https://github.com/someone-else.png?size=128", "prj_1");
    await host.harness.behavior.runSchedule("project-avatars");

    expect(fake).toHaveBeenCalledTimes(2);
  });

  it("runs a first sweep shortly after load", async () => {
    vi.useFakeTimers();
    try {
      const host = loadWithProject();
      const fake = stubFetch(() => imageResponse());

      await vi.advanceTimersByTimeAsync(20_000);

      expect(fake).toHaveBeenCalledTimes(1);
      expect(await listAvatars(host)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("refreshProjectAvatar", () => {
  it("fetches now, even inside the backoff", async () => {
    const host = loadWithProject();
    stubFetch(() => new Response("nope", { status: 500 }));
    await host.harness.behavior.runSchedule("project-avatars");

    const fake = stubFetch(() => imageResponse());
    const result = await host.harness.behavior.callRpc(
      "refreshProjectAvatar",
      { projectId: "prj_1" },
    );

    expect(result).toEqual({ ok: true });
    expect(fake).toHaveBeenCalledTimes(1);
    const [row] = await listAvatars(host);
    expect(row?.remoteImage).toMatch(/^data:image\/png;base64,/);
    // A success ends the backoff, so the next failure starts again from one.
    expect(row?.failureCount).toBe(0);
  });

  it("reports failure rather than changing nothing silently", async () => {
    const host = loadWithProject();
    stubFetch(() => new Response("nope", { status: 403 }));

    expect(
      await host.harness.behavior.callRpc("refreshProjectAvatar", {
        projectId: "prj_1",
      }),
    ).toEqual({ ok: false });
  });

  it("makes no request while the setting is off", async () => {
    const host = loadWithProject({ settings: { remoteAvatarsEnabled: false } });
    const fake = stubFetch(() => imageResponse());

    expect(
      await host.harness.behavior.callRpc("refreshProjectAvatar", {
        projectId: "prj_1",
      }),
    ).toEqual({ ok: false });
    expect(fake).not.toHaveBeenCalled();
  });
});

describe("setProjectAvatarFromUrl", () => {
  it("fetches the picture here and stores it as the custom avatar", async () => {
    const host = loadWithProject();
    const fake = stubFetch(() => imageResponse());

    const result = await host.harness.behavior.callRpc(
      "setProjectAvatarFromUrl",
      { projectId: "prj_1", url: "https://cdn.example.com/logo.png" },
    );

    expect(fake).toHaveBeenCalledTimes(1);
    expect((result as { image: string }).image).toMatch(
      /^data:image\/png;base64,/,
    );
    const [row] = await listAvatars(host);
    // It lands in the custom column, not the remote cache: this is the user's
    // choice, and the sweep must never overwrite or expire it.
    expect(row?.customKind).toBe("image");
    expect(row?.customImage).toMatch(/^data:image\/png;base64,/);
    expect(row?.remoteImage).toBeNull();
  });

  it("still works while automatic git-host fetching is switched off", async () => {
    // The switch is a promise about requests this plugin makes on its own
    // initiative, not about a button the user just pressed.
    const host = loadWithProject({ settings: { remoteAvatarsEnabled: false } });
    const fake = stubFetch(() => imageResponse());

    await host.harness.behavior.callRpc("setProjectAvatarFromUrl", {
      projectId: "prj_1",
      url: "https://cdn.example.com/logo.png",
    });

    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("refuses an address on this machine or its network, without asking", async () => {
    const host = loadWithProject();
    const fake = stubFetch(() => imageResponse());

    for (const url of [
      "http://localhost:8080/logo.png",
      "http://127.0.0.1/logo.png",
      "https://192.168.1.10/logo.png",
      "file:///etc/passwd",
    ]) {
      await expect(
        host.harness.behavior.callRpc("setProjectAvatarFromUrl", {
          projectId: "prj_1",
          url,
        }),
      ).rejects.toThrow();
    }
    expect(fake).not.toHaveBeenCalled();
  });

  it("refuses what the host sent when it is not an image the sidebar renders", async () => {
    const host = loadWithProject();
    stubFetch(() => new Response("<html>sign in</html>", {
      headers: { "content-type": "text/html" },
    }));

    await expect(
      host.harness.behavior.callRpc("setProjectAvatarFromUrl", {
        projectId: "prj_1",
        url: "https://forge.example.com/logo.png",
      }),
    ).rejects.toThrow(/text\/html/);
    expect(await listAvatars(host)).toEqual([]);
  });

  it("refuses an image bigger than the sidebar will carry", async () => {
    const host = loadWithProject();
    stubFetch(() =>
      imageResponse(Buffer.alloc(MAX_AVATAR_BYTES + 1, 0x41)),
    );

    await expect(
      host.harness.behavior.callRpc("setProjectAvatarFromUrl", {
        projectId: "prj_1",
        url: "https://cdn.example.com/huge.png",
      }),
    ).rejects.toThrow();
  });
});

/**
 * A real directory tree rather than a mocked `fs`.
 *
 * The scan is about what a filesystem actually answers — a missing directory,
 * a file that is really a directory, an mtime that moved — and a mock of `fs`
 * would only ever return what this test already believed. A temp directory
 * costs a few milliseconds and tests the thing that ships.
 */
const checkouts: string[] = [];

async function makeCheckout(
  files: Record<string, string | Buffer>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "triage-favicon-"));
  checkouts.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(root, relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(
    checkouts.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>';

const dataUrlOf = (mimeType: string, contents: string | Buffer): string =>
  `data:${mimeType};base64,${Buffer.from(contents).toString("base64")}`;

describe("localSourcePath", () => {
  const source = (overrides: Record<string, unknown> = {}) => ({
    type: "local_path",
    hostId: OWN_HOST,
    path: "/checkouts/app",
    isDefault: true,
    ...overrides,
  });

  it("takes the default source on this machine", () => {
    expect(
      localSourcePath(
        {
          id: "prj_1",
          gitRemoteUrl: null,
          sources: [
            source({ path: "/checkouts/extra", isDefault: false }),
            source({ path: "/checkouts/main" }),
          ],
        },
        OWN_HOST,
      ),
    ).toBe("/checkouts/main");
  });

  // The path describes a directory on the OTHER machine. That the same path
  // may exist here is a coincidence, not permission to open it.
  it("refuses a source enrolled on another machine", () => {
    expect(
      localSourcePath(
        {
          id: "prj_1",
          gitRemoteUrl: null,
          sources: [source({ hostId: "hst_someone_elses_laptop" })],
        },
        OWN_HOST,
      ),
    ).toBe(null);
  });

  it("refuses everything when the server cannot name its own machine", () => {
    expect(
      localSourcePath(
        { id: "prj_1", gitRemoteUrl: null, sources: [source()] },
        null,
      ),
    ).toBe(null);
  });

  it("has nothing to read for a project with no sources", () => {
    expect(
      localSourcePath({ id: "prj_1", gitRemoteUrl: null }, OWN_HOST),
    ).toBe(null);
    expect(
      localSourcePath(
        { id: "prj_1", gitRemoteUrl: null, sources: [source({ path: "  " })] },
        OWN_HOST,
      ),
    ).toBe(null);
  });
});

describe("local favicon scan", () => {
  it("reads the project's own icon and records where it came from", async () => {
    const root = await makeCheckout({ "public/favicon.svg": SVG });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row).toMatchObject({
      faviconImage: dataUrlOf("image/svg+xml", SVG),
      faviconPath: "public/favicon.svg",
      faviconMissingAt: null,
    });
    expect(row?.faviconScannedAt).toBeGreaterThan(0);
  });

  // The favicon is what the sidebar draws, so asking the git host for an
  // image nobody will see is noise on somebody else's server.
  it("stops fetching from the git host once a favicon is found", async () => {
    const root = await makeCheckout({ "public/favicon.svg": SVG });
    const host = loadWithProject({ sourcePath: root });
    const fake = stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    expect(fake).not.toHaveBeenCalled();
  });

  it("still fetches from the git host when the checkout has no icon", async () => {
    const root = await makeCheckout({ "README.md": "# hi" });
    const host = loadWithProject({ sourcePath: root });
    const fake = stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    expect(fake).toHaveBeenCalledTimes(1);
    const [row] = await listAvatars(host);
    expect(row?.faviconImage).toBeNull();
    // The memo that stops the next load walking these directories again.
    expect(row?.faviconMissingAt).toBeGreaterThan(0);
  });

  it("takes the best candidate the checkout offers", async () => {
    const root = await makeCheckout({
      "public/favicon.ico": "not really an icon",
      "public/favicon-32x32.png": PNG_BYTES,
      "public/apple-touch-icon.png": PNG_BYTES,
      "src/logo.svg": SVG,
    });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.faviconPath).toBe("public/apple-touch-icon.png");
  });

  // A repository whose only icon is favicon.ico is extremely common, so the
  // store accepts icon files even though they are usually 16 or 32 pixels.
  it("uses favicon.ico when it is the only icon", async () => {
    const root = await makeCheckout({ "public/favicon.ico": "icon bytes" });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.faviconPath).toBe("public/favicon.ico");
    expect(row?.faviconImage).toContain("data:image/x-icon;base64,");
  });

  // The best-ranked name can turn out to be unreadable — a directory here —
  // so the scan must fall through instead of giving up on the project.
  it("falls through a candidate it cannot read", async () => {
    const root = await makeCheckout({
      "public/apple-touch-icon.png/keep": "a directory, not a file",
      "public/logo.svg": SVG,
    });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.faviconPath).toBe("public/logo.svg");
  });

  it("refuses an icon past the size cap", async () => {
    const root = await makeCheckout({
      "public/favicon.png": Buffer.alloc(MAX_AVATAR_BYTES + 1),
    });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.faviconImage).toBeNull();
  });

  it("finds an icon one level down in a monorepo", async () => {
    const root = await makeCheckout({ "apps/web/public/favicon.svg": SVG });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.faviconPath).toBe("apps/web/public/favicon.svg");
  });

  it("does not walk a directory it was never told to search", async () => {
    const root = await makeCheckout({
      "node_modules/thing/favicon.svg": SVG,
      "docs/favicon.svg": SVG,
    });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.faviconImage).toBeNull();
  });

  // The sweep runs against every project every day; re-reading an unchanged
  // image would be the most expensive thing this plugin does.
  it("does not re-read an unchanged icon, and re-reads a changed one", async () => {
    const root = await makeCheckout({ "public/favicon.svg": SVG });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");
    const first = (await listAvatars(host))[0];

    await host.harness.behavior.runSchedule("project-avatars");
    expect((await listAvatars(host))[0]?.faviconScannedAt).toBe(
      first?.faviconScannedAt,
    );

    const changed = SVG.replace("rect", "circle");
    await writeFile(join(root, "public/favicon.svg"), changed);
    // Explicit mtime rather than trusting the clock: two writes inside the
    // same millisecond are entirely possible on a fast machine.
    const later = new Date(Date.now() + 60_000);
    await utimes(join(root, "public/favicon.svg"), later, later);

    await host.harness.behavior.runSchedule("project-avatars");
    expect((await listAvatars(host))[0]?.faviconImage).toBe(
      dataUrlOf("image/svg+xml", changed),
    );
  });

  it("forgets an icon that was deleted", async () => {
    const root = await makeCheckout({ "public/favicon.svg": SVG });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());
    await host.harness.behavior.runSchedule("project-avatars");

    await rm(join(root, "public/favicon.svg"));
    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.faviconImage).toBeNull();
    expect(row?.faviconPath).toBeNull();
  });

  // Once a project has been found to have no icon, the next scan is skipped
  // for half a day — long enough that a plugin reload is free, short enough
  // that the daily sweep always looks again.
  it("waits before walking an iconless project's directories again", async () => {
    const root = await makeCheckout({ "README.md": "# hi" });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());
    await host.harness.behavior.runSchedule("project-avatars");

    await writeFile(join(root, "favicon.svg"), SVG);
    await host.harness.behavior.runSchedule("project-avatars");
    expect((await listAvatars(host))[0]?.faviconImage).toBeNull();

    // A day later — which is when the daily schedule next runs anyway.
    host.bb.storage
      .database()
      .prepare(
        `UPDATE project_avatar SET favicon_missing_at = ? WHERE project_id = ?`,
      )
      .run(Date.now() - DAY_MS, "prj_1");
    await host.harness.behavior.runSchedule("project-avatars");
    expect((await listAvatars(host))[0]?.faviconPath).toBe("favicon.svg");
  });

  it("reads nothing while the setting is off", async () => {
    const root = await makeCheckout({ "public/favicon.svg": SVG });
    const host = loadWithProject({
      sourcePath: root,
      settings: { localFaviconsEnabled: false },
    });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    const [row] = await listAvatars(host);
    expect(row?.faviconImage).toBeNull();
    expect(row?.faviconScannedAt).toBeNull();
    // With no favicon in the way, the git host is asked as it always was.
    expect(row?.remoteImage).toMatch(/^data:image\/png;base64,/);
  });

  // The path names a directory on the other machine; the fact that it also
  // exists here is a coincidence.
  it("reads nothing for a checkout on another machine", async () => {
    const root = await makeCheckout({ "public/favicon.svg": SVG });
    const host = loadWithProject({
      sourcePath: root,
      sourceHostId: "hst_someone_elses_laptop",
    });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    expect((await listAvatars(host))[0]?.faviconImage).toBeNull();
  });

  it("reads nothing when the server cannot name its own machine", async () => {
    const root = await makeCheckout({ "public/favicon.svg": SVG });
    const host = loadWithProject({ sourcePath: root, primaryHostId: null });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    expect((await listAvatars(host))[0]?.faviconImage).toBeNull();
  });

  // A folder on an unmounted disk costs that project an icon, never the sweep.
  it("survives a source folder that is not there", async () => {
    const host = loadWithProject({ sourcePath: "/definitely/not/here" });
    const fake = stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");

    expect(fake).toHaveBeenCalledTimes(1);
    expect((await listAvatars(host))[0]?.remoteImage).toMatch(/^data:image/);
  });

  // The user is looking at the sidebar when they flip the switch; an avatar
  // that stayed until the next sweep would read as the setting doing nothing.
  it("forgets the icons it read when the setting is turned off", async () => {
    const root = await makeCheckout({ "public/favicon.svg": SVG });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());
    await host.harness.behavior.runSchedule("project-avatars");
    expect((await listAvatars(host))[0]?.faviconImage).not.toBeNull();

    await host.harness.behavior.setSettings({ localFaviconsEnabled: false });

    // Nothing custom, nothing fetched and nothing local: the row has nothing
    // left to say, exactly as it would have had the scan never run.
    expect(await listAvatars(host)).toEqual([]);
    expect(
      host.harness.inspection.realtimeSignals.some(
        (signal) => signal.channel === "project-avatars",
      ),
    ).toBe(true);
  });

  // Every sweep touches every project; a signal per project per sweep would
  // re-render every sidebar in every window for nothing.
  it("tells the frontend only when the icon actually changed", async () => {
    const root = await makeCheckout({ "public/favicon.svg": SVG });
    const host = loadWithProject({ sourcePath: root });
    stubFetch(() => imageResponse());

    await host.harness.behavior.runSchedule("project-avatars");
    const after = host.harness.inspection.realtimeSignals.length;
    await host.harness.behavior.runSchedule("project-avatars");

    expect(host.harness.inspection.realtimeSignals.length).toBe(after);
  });
});
