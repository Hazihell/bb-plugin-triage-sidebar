import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type CreateFakePluginHostOptions,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin, {
  isAllowedAvatarDataUrl,
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

/** A host with one project, its git remote pointing at GitHub. */
function loadWithProject(
  options: {
    gitRemoteUrl?: string | null;
    settings?: CreateFakePluginHostOptions["settings"];
  } = {},
): FakePluginHost {
  const project = {
    id: "prj_1",
    gitRemoteUrl:
      options.gitRemoteUrl === undefined
        ? "git@github.com:get-bb/bb.git"
        : options.gitRemoteUrl,
  };
  return load({
    settings: options.settings,
    sdk: {
      projects: {
        list: () => [project],
        get: () => project,
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

    // Age the cache past its refresh window so the next sweep tries again.
    host.bb.storage
      .database()
      .prepare(`UPDATE project_avatar SET fetched_at = ? WHERE project_id = ?`)
      .run(Date.now() - 30 * DAY_MS, "prj_1");
    stubFetch(() => {
      throw new Error("connection refused");
    });
    await host.harness.behavior.runSchedule("project-avatars");

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
