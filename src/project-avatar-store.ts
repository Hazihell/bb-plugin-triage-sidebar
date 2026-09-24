/**
 * Everything the sidebar knows about a project's picture: what the user chose,
 * the icon read out of the project's own checkout, and the image cached from
 * its git host.
 *
 * This lives apart from the thread lifecycle because it changes for its own
 * reasons — a new image type, a new place to look for a favicon, a forge that
 * answers differently — and none of those are reasons the settled/snoozed
 * store should have to be reopened. The two share only the database handle and
 * the plugin api.
 *
 * The three sources are three sets of columns rather than one, and that is the
 * rule the whole module turns on: each has a different owner, they outrank each
 * other in a fixed order (the user, then the checkout, then the host), and
 * clearing one may never destroy another's. Every write here touches exactly
 * one set.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  checkUserAvatarUrl,
  remoteAvatarUrl,
  shouldRefetch,
  type AvatarRefetchState,
  type UserAvatarUrlRefusal,
} from "./avatar-remote";
import {
  faviconMimeType,
  faviconSearchDirectories,
  MONOREPO_PARENTS,
  rankFaviconCandidates,
} from "./favicon-scan";

/** One project's avatar state, as the frontend reads it. */
export interface StoredAvatarRow {
  projectId: string;
  /** What the user picked, or null when they picked nothing. */
  customKind: "monogram" | "emoji" | "image" | null;
  customColor: string | null;
  customInitials: string | null;
  customEmoji: string | null;
  /** A data URL the user supplied; guarded by {@link isAllowedAvatarDataUrl}. */
  customImage: string | null;
  /** Data URL of the icon found in the project's own checkout, if any. */
  faviconImage: string | null;
  /** Where that icon was read from, relative to the project root. */
  faviconPath: string | null;
  /** That file's mtime, so an unchanged icon is not re-read. */
  faviconMtime: number | null;
  faviconScannedAt: number | null;
  /** When the checkout was last found to hold no icon at all. */
  faviconMissingAt: number | null;
  /** Data URL cached from the git host, or null when we have never got one. */
  remoteImage: string | null;
  /** The URL `remoteImage` came from, so a moved project invalidates it. */
  remoteUrl: string | null;
  fetchedAt: number | null;
  failedAt: number | null;
  failureCount: number | null;
}

interface AvatarDbRow {
  project_id: string;
  custom_kind: string | null;
  custom_color: string | null;
  custom_initials: string | null;
  custom_emoji: string | null;
  custom_image: string | null;
  favicon_image: string | null;
  favicon_path: string | null;
  favicon_mtime: number | null;
  favicon_scanned_at: number | null;
  favicon_missing_at: number | null;
  remote_image: string | null;
  remote_url: string | null;
  fetched_at: number | null;
  failed_at: number | null;
  failure_count: number | null;
}

const avatarRowSchema = z.object({
  projectId: z.string(),
  customKind: z.enum(["monogram", "emoji", "image"]).nullable(),
  customColor: z.string().nullable(),
  customInitials: z.string().nullable(),
  customEmoji: z.string().nullable(),
  customImage: z.string().nullable(),
  faviconImage: z.string().nullable(),
  faviconPath: z.string().nullable(),
  faviconMtime: z.number().nullable(),
  faviconScannedAt: z.number().nullable(),
  faviconMissingAt: z.number().nullable(),
  remoteImage: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  fetchedAt: z.number().nullable(),
  failedAt: z.number().nullable(),
  failureCount: z.number().nullable(),
});

/**
 * What the user chose, as a discriminated union rather than a bag of optional
 * fields: "a colour with initials" and "an emoji" are different states, and a
 * shape that could hold both at once would push the choice of which one wins
 * into the renderer.
 */
const customAvatarSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clear") }),
  z.object({
    // "monogram", not "color": the colour is one property of the thing being
    // customized, and a user who picks new initials on the same background has
    // still changed their monogram.
    kind: z.literal("monogram"),
    color: z.string().trim().min(1).max(64),
    // One or two characters: a monogram is a glyph, not a label, and three
    // would not fit the disc the sidebar draws.
    initials: z.string().trim().min(1).max(2),
  }),
  z.object({
    kind: z.literal("emoji"),
    // Emoji are multi-codepoint (flags, skin tones, ZWJ families), so this
    // counts UTF-16 units generously rather than pretending one emoji is one
    // character.
    emoji: z.string().trim().min(1).max(16),
    color: z.string().trim().min(1).max(64),
  }),
  z.object({ kind: z.literal("image"), image: z.string().min(1) }),
]);

/**
 * The choice the settings UI sends, named so the frontend can hold one in
 * state without restating the union and letting the two drift apart.
 */
export type CustomProjectAvatar = z.infer<typeof customAvatarSchema>;

/** Channel for avatar changes, kept apart so a sweep does not churn the list. */
export const PROJECT_AVATAR_CHANNEL = "project-avatars";

/**
 * Ceiling on any avatar image, custom or fetched.
 *
 * These rows are read in full by every sidebar render and travel over RPC on
 * each one, so an avatar is a small icon or it is nothing. 256 KB is already
 * generous for a 128px disc; it exists to stop a multi-megabyte PNG from
 * making the whole list slow, and to bound what a hostile git host can push
 * into the plugin's database in one response.
 */
export const MAX_AVATAR_BYTES = 256 * 1024;

/**
 * The image types allowed in a data URL.
 *
 * An allow-list, not a block-list: the string ends up in a CSS `url()` or an
 * `<img src>` in bb's own window, so anything that is not plainly an image
 * must not get there. `svg+xml` is on the list because it is what most forges
 * serve for a generated avatar, and the frontend renders avatars in an `<img>`
 * — which does not execute script in an SVG — rather than inlining them.
 *
 * `x-icon` (and its `vnd.microsoft.icon` spelling) is here for local favicons:
 * a great many repositories ship `favicon.ico` and nothing else, so refusing
 * it would leave those projects with no icon at all. It is a raster container,
 * so it carries none of the risk that made `svg+xml` worth arguing about, and
 * Chromium decodes it in an `<img>`.
 */
const AVATAR_DATA_URL_PATTERN =
  /^data:image\/(?:png|jpeg|webp|gif|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Whether a data URL is one this plugin is willing to store and render. */
export function isAllowedAvatarDataUrl(value: string): boolean {
  if (!AVATAR_DATA_URL_PATTERN.test(value)) return false;
  // Measured on the encoded string, because that is what is stored, sent and
  // parsed — the decoded image is smaller, so this is the conservative bound.
  return Buffer.byteLength(value, "utf8") <= MAX_AVATAR_BYTES;
}

/**
 * How long after load the first sweep runs.
 *
 * Long enough that plugin load, the server's own startup, and this plugin's
 * outbound requests are not all competing at once — nothing here is urgent,
 * because the sidebar draws monograms until the images arrive.
 */
const INITIAL_SWEEP_DELAY_MS = 15_000;

/** How long we wait on a git host before giving up on its avatar. */
const AVATAR_FETCH_TIMEOUT_MS = 5000;

/**
 * How long a project that has no icon is left unexamined.
 *
 * Not a cache of the answer, a floor on how often the question is asked. The
 * sweep itself runs daily, so this changes nothing there — it exists for the
 * sweep on load, which would otherwise re-walk every iconless project's
 * directories on every plugin reload and every restart of bb. Half a day keeps
 * the promise that adding a favicon shows up within a day, because the daily
 * sweep always falls outside this window.
 */
const FAVICON_RESCAN_MS = 12 * 60 * 60 * 1000;

/** The fields of bb's project DTO this plugin reads. */
interface SweepProjectView {
  id: string;
  gitRemoteUrl: string | null;
  /**
   * Where the project's files live. `hostId` matters as much as `path`: bb can
   * hold a project whose checkout is on another machine entirely, and its path
   * means nothing here — worse, it may accidentally name a real and unrelated
   * directory on this one.
   */
  sources?: readonly {
    type?: string;
    path?: string;
    hostId?: string;
    isDefault?: boolean;
  }[];
}

/**
 * The directory to read this project's icon from, or null when there is none
 * to read on THIS machine.
 *
 * `ownHostId` is the server's own host — the machine this plugin's process is
 * running on. A source enrolled on any other host is skipped rather than
 * opened: its path describes a directory over there, and the fact that the
 * same path may exist here is a coincidence, not permission. A server that
 * cannot name its own host passes null, and then nothing is read at all.
 */
export function localSourcePath(
  project: SweepProjectView,
  ownHostId: string | null,
): string | null {
  if (ownHostId === null) return null;
  const local = (project.sources ?? []).filter(
    (source) =>
      source.type === "local_path" &&
      source.hostId === ownHostId &&
      typeof source.path === "string" &&
      source.path.trim() !== "",
  );
  if (local.length === 0) return null;
  // The default source is the project's main checkout; the others are extra
  // folders added to it, and an icon in one of those does not identify the
  // project. Falling back to the first is for older rows that flag none.
  const chosen = local.find((source) => source.isDefault === true) ?? local[0]!;
  return chosen.path!;
}

/**
 * The avatar half of this plugin's RPC surface.
 *
 * Exported as a plain object rather than its own contract so `server.ts` can
 * spread it into the one contract the frontend holds: bb registers a single
 * contract per plugin, and two would mean two clients in the sidebar.
 */
export const projectAvatarRpcContract = {
  listProjectAvatars: {
    input: z.object({}),
    output: z.object({ rows: z.array(avatarRowSchema) }),
  },
  setProjectAvatar: {
    input: z.object({
      projectId: z.string().trim().min(1),
      custom: customAvatarSchema,
    }),
    output: z.object({ ok: z.boolean() }),
  },
  refreshProjectAvatar: {
    input: z.object({ projectId: z.string().trim().min(1) }),
    // `ok: false` means the host did not give us an image — the caller asked
    // for this one explicitly, so it deserves to hear that it failed rather
    // than watch nothing change.
    output: z.object({ ok: z.boolean() }),
  },
  /**
   * Download a picture from a URL the user typed and make it this project's
   * custom avatar — the same end state as `setProjectAvatar` with an `image`,
   * reached by giving the server an address instead of the bytes.
   *
   * It exists because the settings page cannot do this itself: a browser
   * `fetch` of an arbitrary host is refused whenever that host sends no
   * permissive CORS header, which is most hosts, and the failure looks to the
   * user like the URL being wrong. The server is under no such rule.
   *
   * Every refusal arrives as a thrown error whose message is meant to be shown
   * verbatim, so there is no failure flag to read: it either returns the image
   * it stored, or it says what was wrong with the URL.
   */
  setProjectAvatarFromUrl: {
    input: z.object({
      projectId: z.string().trim().min(1),
      /** An http or https address of an image. */
      url: z.string().trim().min(1),
    }),
    /** The stored data URL, so the caller can render it without re-reading. */
    output: z.object({ image: z.string() }),
  },
};

/**
 * What this store needs from the plugin around it.
 *
 * The settings are passed as a reader rather than the settings handle itself,
 * because `bb.settings.define` is one call for the whole plugin and the
 * lifecycle half owns the other two switches. Read on every sweep, never
 * cached: the user can flip either between two runs of a daily schedule, and
 * the promise the remote switch makes is that no request goes out once it is
 * off.
 */
export interface ProjectAvatarSettings {
  remoteAvatarsEnabled: boolean;
  localFaviconsEnabled: boolean;
}

export interface ProjectAvatarStoreDeps {
  bb: BbPluginApi;
  /** Already migrated by the caller, which owns the one append-only list. */
  db: ReturnType<BbPluginApi["storage"]["database"]>;
  readSettings(): Promise<ProjectAvatarSettings>;
}

/**
 * The handler map this store owes the contract above, derived from it rather
 * than restated: a handler whose input drifts from its schema is a runtime
 * surprise, and the mapped type turns it into a compile error.
 */
export type ProjectAvatarRpcHandlers = {
  [K in keyof typeof projectAvatarRpcContract]: (
    input: z.infer<(typeof projectAvatarRpcContract)[K]["input"]>,
  ) => Promise<z.infer<(typeof projectAvatarRpcContract)[K]["output"]>>;
};

export interface ProjectAvatarStore {
  /** RPC implementations, to be spread into the plugin's one handler map. */
  handlers: ProjectAvatarRpcHandlers;
  /**
   * Forget every icon read from a project folder. Called by the caller's
   * settings watcher, because the switch it answers to is defined there.
   */
  forgetAllFavicons(): void;
}

/**
 * Wire the store up: its queries, its RPC handlers, its daily sweep, and the
 * one on load.
 *
 * A factory rather than free functions because every operation here needs the
 * same three things — the database, the plugin api to publish and log on, and
 * the settings — and threading those through thirty signatures would say
 * nothing a closure does not already say.
 */
export function createProjectAvatarStore(
  deps: ProjectAvatarStoreDeps,
): ProjectAvatarStore {
  const { bb, db, readSettings } = deps;

  const AVATAR_COLUMNS = `project_id, custom_kind, custom_color, custom_initials,
             custom_emoji, custom_image, favicon_image, favicon_path,
             favicon_mtime, favicon_scanned_at, favicon_missing_at,
             remote_image, remote_url, fetched_at, failed_at, failure_count`;

  const toAvatarRow = (row: AvatarDbRow): StoredAvatarRow => ({
    projectId: row.project_id,
    // The column is plain TEXT; only this file writes it, and it only ever
    // writes one of the three kinds.
    customKind: row.custom_kind as StoredAvatarRow["customKind"],
    customColor: row.custom_color,
    customInitials: row.custom_initials,
    customEmoji: row.custom_emoji,
    customImage: row.custom_image,
    faviconImage: row.favicon_image,
    faviconPath: row.favicon_path,
    faviconMtime: row.favicon_mtime,
    faviconScannedAt: row.favicon_scanned_at,
    faviconMissingAt: row.favicon_missing_at,
    remoteImage: row.remote_image,
    remoteUrl: row.remote_url,
    fetchedAt: row.fetched_at,
    failedAt: row.failed_at,
    failureCount: row.failure_count,
  });

  const readAvatars = (): StoredAvatarRow[] =>
    (
      db
        .prepare(`SELECT ${AVATAR_COLUMNS} FROM project_avatar`)
        .all() as AvatarDbRow[]
    ).map(toAvatarRow);

  const readAvatar = (projectId: string): StoredAvatarRow | undefined => {
    const row = db
      .prepare(`SELECT ${AVATAR_COLUMNS} FROM project_avatar WHERE project_id = ?`)
      .get(projectId) as AvatarDbRow | undefined;
    return row === undefined ? undefined : toAvatarRow(row);
  };

  const announceAvatar = (projectId: string): void => {
    bb.realtime.publish(PROJECT_AVATAR_CHANNEL, { projectId });
  };

  /**
   * Drop a row that has nothing left to say.
   *
   * Same rule as the lifecycle store: a row exists to hold state, and an
   * all-null row would otherwise survive forever for a project the user only
   * ever looked at.
   */
  const dropEmptyAvatar = (projectId: string): void => {
    db.prepare(
      `DELETE FROM project_avatar
         WHERE project_id = ?
           AND custom_kind IS NULL
           AND custom_image IS NULL
           AND favicon_image IS NULL
           AND favicon_scanned_at IS NULL
           AND remote_image IS NULL
           AND remote_url IS NULL
           AND failed_at IS NULL`,
    ).run(projectId);
  };

  /**
   * Write the user's choice, leaving the remote cache untouched.
   *
   * The two halves answer to different owners — the user picks the custom
   * one, the git host supplies the other — so setting one may never erase the
   * other. Clearing a custom avatar is how a user gets the fetched one back.
   */
  const writeCustomAvatar = (
    projectId: string,
    custom: {
      kind: StoredAvatarRow["customKind"];
      color: string | null;
      initials: string | null;
      emoji: string | null;
      image: string | null;
    },
  ): void => {
    db.prepare(
      `INSERT INTO project_avatar
         (project_id, custom_kind, custom_color, custom_initials,
          custom_emoji, custom_image)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         custom_kind = excluded.custom_kind,
         custom_color = excluded.custom_color,
         custom_initials = excluded.custom_initials,
         custom_emoji = excluded.custom_emoji,
         custom_image = excluded.custom_image`,
    ).run(
      projectId,
      custom.kind,
      custom.color,
      custom.initials,
      custom.emoji,
      custom.image,
    );
    dropEmptyAvatar(projectId);
    announceAvatar(projectId);
  };

  const recordAvatarSuccess = (
    projectId: string,
    url: string,
    image: string,
  ): void => {
    db.prepare(
      `INSERT INTO project_avatar
         (project_id, remote_image, remote_url, fetched_at, failed_at, failure_count)
       VALUES (?, ?, ?, ?, NULL, 0)
       ON CONFLICT(project_id) DO UPDATE SET
         remote_image = excluded.remote_image,
         remote_url = excluded.remote_url,
         fetched_at = excluded.fetched_at,
         failed_at = NULL,
         failure_count = 0`,
    ).run(projectId, image, url, Date.now());
    announceAvatar(projectId);
  };

  /**
   * Record a failure without touching `remote_image`.
   *
   * A host that is briefly down must not cost the user an avatar they already
   * had: the stale image keeps rendering while the backoff grows. `remote_url`
   * is stamped so the backoff belongs to the URL that failed — if the project
   * moves, `shouldRefetch` sees a different URL and retries at once.
   */
  const recordAvatarFailure = (projectId: string, url: string): void => {
    db.prepare(
      `INSERT INTO project_avatar
         (project_id, remote_url, failed_at, failure_count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(project_id) DO UPDATE SET
         remote_url = excluded.remote_url,
         failed_at = excluded.failed_at,
         failure_count = COALESCE(project_avatar.failure_count, 0) + 1`,
    ).run(projectId, url, Date.now());
    announceAvatar(projectId);
  };

  /**
   * Record the icon found in a project's checkout.
   *
   * The realtime signal is conditional, and that is the point: this runs for
   * every project on every sweep, and announcing an unchanged icon would make
   * a silent background scan re-render every sidebar in every window.
   */
  const recordFaviconFound = (
    projectId: string,
    found: { path: string; image: string; mtime: number },
    previous: StoredAvatarRow | undefined,
  ): void => {
    db.prepare(
      `INSERT INTO project_avatar
         (project_id, favicon_image, favicon_path, favicon_mtime,
          favicon_scanned_at, favicon_missing_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(project_id) DO UPDATE SET
         favicon_image = excluded.favicon_image,
         favicon_path = excluded.favicon_path,
         favicon_mtime = excluded.favicon_mtime,
         favicon_scanned_at = excluded.favicon_scanned_at,
         favicon_missing_at = NULL`,
    ).run(projectId, found.image, found.path, found.mtime, Date.now());
    if (previous?.faviconImage !== found.image) announceAvatar(projectId);
  };

  /**
   * Record that a project's checkout holds no icon.
   *
   * `favicon_missing_at` is a memo to the next scan, not a failure: it is what
   * stops a project that will never have a favicon from walking its
   * directories again on the next load. Any image we had is cleared, because
   * unlike a git host going down, a file that is gone is gone — keeping it
   * would show an icon the project no longer ships.
   */
  const recordFaviconMissing = (
    projectId: string,
    previous: StoredAvatarRow | undefined,
  ): void => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO project_avatar
         (project_id, favicon_image, favicon_path, favicon_mtime,
          favicon_scanned_at, favicon_missing_at)
       VALUES (?, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         favicon_image = NULL,
         favicon_path = NULL,
         favicon_mtime = NULL,
         favicon_scanned_at = excluded.favicon_scanned_at,
         favicon_missing_at = excluded.favicon_missing_at`,
    ).run(projectId, now, now);
    if (previous?.faviconImage != null) announceAvatar(projectId);
  };

  /**
   * Forget every icon read from a project folder.
   *
   * Run when the setting is turned off, so the switch means what it says: the
   * sidebar reverts within the second instead of a day later, and the git
   * host's image becomes eligible again on the next sweep. Cached remote
   * images are untouched — they belong to the other setting.
   */
  const forgetAllFavicons = (): void => {
    const affected = (
      db
        .prepare(
          `SELECT project_id FROM project_avatar
             WHERE favicon_image IS NOT NULL OR favicon_scanned_at IS NOT NULL`,
        )
        .all() as { project_id: string }[]
    ).map((row) => row.project_id);
    if (affected.length === 0) return;

    db.prepare(
      `UPDATE project_avatar
          SET favicon_image = NULL,
              favicon_path = NULL,
              favicon_mtime = NULL,
              favicon_scanned_at = NULL,
              favicon_missing_at = NULL`,
    ).run();
    for (const projectId of affected) {
      dropEmptyAvatar(projectId);
      announceAvatar(projectId);
    }
  };

  /** Names inside one directory, or nothing at all when it cannot be read. */
  const listDirectory = async (
    absolute: string,
    want: "files" | "directories",
  ): Promise<string[]> => {
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      // A directory that is absent, unreadable, or on a disk that went away is
      // the ordinary case here, not an error: most projects have most of these
      // directories missing.
      return [];
    }
    return entries
      .filter((entry) =>
        want === "files"
          ? // A symlink is followed rather than skipped — `public` is a symlink
            // in plenty of layouts — and the stat before the read is what
            // decides whether it really points at a file.
            entry.isFile() || entry.isSymbolicLink()
          : entry.isDirectory() || entry.isSymbolicLink(),
      )
      .map((entry) => entry.name);
  };

  /** Every icon-shaped file in the places this plugin is willing to look. */
  const listIconCandidates = async (root: string): Promise<string[]> => {
    const monorepoChildren: Record<string, string[]> = {};
    for (const parent of MONOREPO_PARENTS) {
      monorepoChildren[parent] = await listDirectory(
        join(root, parent),
        "directories",
      );
    }

    const paths: string[] = [];
    for (const directory of faviconSearchDirectories(monorepoChildren)) {
      const absolute = directory === "" ? root : join(root, directory);
      for (const name of await listDirectory(absolute, "files")) {
        paths.push(directory === "" ? name : `${directory}/${name}`);
      }
    }
    return paths;
  };

  /**
   * Read one candidate, or answer null so the caller tries the next one.
   *
   * Every refusal here is the same refusal the git-host fetch makes — a size
   * this sidebar can carry, and a type this plugin is willing to render —
   * because the two images end up in the same column, are sent over the same
   * RPC, and are put in the same `<img src>`. A local file is not more trusted
   * than a remote one; it is merely closer.
   */
  const readIcon = async (
    root: string,
    relativePath: string,
  ): Promise<{ path: string; image: string; mtime: number } | null> => {
    const mimeType = faviconMimeType(relativePath);
    if (mimeType === null) return null;

    const absolute = join(root, relativePath);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      return null;
    }
    // Checked before the read so a huge file is refused rather than buffered,
    // exactly as the fetch believes `content-length` before reading a body.
    if (!info.isFile() || info.size > MAX_AVATAR_BYTES) return null;

    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch {
      return null;
    }
    if (bytes.byteLength > MAX_AVATAR_BYTES) return null;

    const dataUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
    if (!isAllowedAvatarDataUrl(dataUrl)) return null;
    // Whole milliseconds: mtimeMs carries sub-millisecond precision on some
    // filesystems and not others, and this number is only ever compared with
    // the one stored last time.
    return { path: relativePath, image: dataUrl, mtime: Math.floor(info.mtimeMs) };
  };

  /**
   * Bring one project's favicon up to date, and answer what it now has.
   *
   * Three ways out, cheapest first. The file we already read is unchanged —
   * one stat, no listing, no write. The project was found to have no icon
   * recently — nothing at all. Otherwise the directories are listed and the
   * ranked candidates are tried in order, because the best NAME is not always
   * a file this plugin can store.
   */
  const scanProjectFavicon = async (
    projectId: string,
    root: string,
    row: StoredAvatarRow | undefined,
    now: number,
  ): Promise<string | null> => {
    if (row?.faviconImage != null && row.faviconPath != null) {
      try {
        const info = await stat(join(root, row.faviconPath));
        if (info.isFile() && Math.floor(info.mtimeMs) === row.faviconMtime) {
          return row.faviconImage;
        }
      } catch {
        // Gone or unreadable: fall through and look again, because a deleted
        // icon may well have been replaced by a differently named one.
      }
    } else if (
      row?.faviconMissingAt != null &&
      now - row.faviconMissingAt < FAVICON_RESCAN_MS
    ) {
      return null;
    }

    const candidates = rankFaviconCandidates(await listIconCandidates(root));
    for (const candidate of candidates) {
      const found = await readIcon(root, candidate);
      if (found === null) continue;
      recordFaviconFound(projectId, found, row);
      return found.image;
    }
    recordFaviconMissing(projectId, row);
    return null;
  };

  /**
   * Ask a git host for an owner avatar and turn it into a data URL.
   *
   * Every check here is about not letting a third-party server decide what
   * this plugin stores: a bounded wait, a status we understand, a type that
   * really is an image, and a size the sidebar can carry. Redirects are
   * followed because the forges use them — GitHub answers `/<owner>.png` with
   * a redirect to its CDN.
   */
  const fetchRemoteAvatar = async (url: string): Promise<string> => {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
      headers: { accept: "image/*" },
    });
    if (!response.ok) {
      throw new Error(`host answered ${response.status}`);
    }

    // A private forge usually answers a signed-out request with its HTML sign-in
    // page and a 200, so the status alone does not mean we got an image.
    const contentType = (response.headers.get("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    if (!contentType.startsWith("image/")) {
      throw new Error(`host answered ${contentType || "no content type"}`);
    }

    // Believe a declared length early, so an oversized body is refused before
    // it is buffered; the real length is still checked below, because the
    // header is the sender's claim rather than a fact.
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_AVATAR_BYTES) {
      throw new Error(`image is ${declared} bytes`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_AVATAR_BYTES) {
      throw new Error(`image is ${bytes.byteLength} bytes`);
    }

    const dataUrl = `data:${contentType};base64,${bytes.toString("base64")}`;
    // The same gate a user-supplied image passes: whatever the host called
    // it, this is only stored if it is a type we are willing to render.
    if (!isAllowedAvatarDataUrl(dataUrl)) {
      throw new Error(`refusing ${contentType}`);
    }
    return dataUrl;
  };

  /** Fetch one project's avatar, recording either outcome. Never throws. */
  const refreshOneAvatar = async (
    projectId: string,
    url: string,
  ): Promise<boolean> => {
    try {
      recordAvatarSuccess(projectId, url, await fetchRemoteAvatar(url));
      return true;
    } catch (error) {
      bb.log.warn(
        `project-avatars: ${url} failed (${String(error)}) — keeping any cached image`,
      );
      recordAvatarFailure(projectId, url);
      return false;
    }
  };

  const handlers: ProjectAvatarRpcHandlers = {
    async listProjectAvatars() {
      return { rows: readAvatars() };
    },
    async setProjectAvatar({ projectId, custom }) {
      switch (custom.kind) {
        case "clear":
          writeCustomAvatar(projectId, {
            kind: null,
            color: null,
            initials: null,
            emoji: null,
            image: null,
          });
          return { ok: true };
        case "monogram":
          writeCustomAvatar(projectId, {
            kind: "monogram",
            color: custom.color,
            initials: custom.initials,
            emoji: null,
            image: null,
          });
          return { ok: true };
        case "emoji":
          writeCustomAvatar(projectId, {
            kind: "emoji",
            color: custom.color,
            initials: null,
            emoji: custom.emoji,
            image: null,
          });
          return { ok: true };
        case "image": {
          // Rejected here rather than in the schema so the reason reaches the
          // user as a message they can act on, instead of a validation issue
          // pointing at a 300 KB string.
          if (!isAllowedAvatarDataUrl(custom.image)) {
            throw new Error(
              `An avatar must be a PNG, JPEG, WebP, GIF or SVG data URL under ${Math.floor(MAX_AVATAR_BYTES / 1024)} KB.`,
            );
          }
          writeCustomAvatar(projectId, {
            kind: "image",
            color: null,
            initials: null,
            emoji: null,
            image: custom.image,
          });
          return { ok: true };
        }
      }
    },
    async refreshProjectAvatar({ projectId }) {
      // A forced refresh ignores the backoff — the user asked for this one —
      // but not the setting: the switch is a promise about outbound requests.
      const values = await readSettings();
      if (!values.remoteAvatarsEnabled) return { ok: false };

      let project: SweepProjectView;
      try {
        project = await bb.sdk.projects.get({ projectId });
      } catch (error) {
        bb.log.warn(
          `project-avatars: could not read project ${projectId} (${String(error)})`,
        );
        return { ok: false };
      }

      const url = remoteAvatarUrl(project?.gitRemoteUrl ?? null);
      if (url === null) return { ok: false };
      return { ok: await refreshOneAvatar(projectId, url) };
    },
    async setProjectAvatarFromUrl({ projectId, url }) {
      // Deliberately not gated by `remoteAvatarsEnabled`. That switch is a
      // promise about requests this plugin decides to make on its own — once a
      // day, to a git host the user never named — and keeping it means making
      // none of them. This is one request to one address the user just typed
      // and pressed a button for; refusing it would be the plugin declining to
      // do the thing being asked of it, which is not what the switch says.
      const checked = checkUserAvatarUrl(url);
      if (!checked.ok) {
        // Worded here rather than in the checker so the reason reaches the
        // user as a sentence naming the fix, next to the other message this
        // settings page can raise.
        const messages: Record<UserAvatarUrlRefusal, string> = {
          unparseable: "That does not look like a web address.",
          scheme: "An image address must start with http:// or https://.",
          // A typed address can name a machine only this computer can reach,
          // and fetching it here would let a picture field ask questions of
          // the user's own network from inside bb. Named plainly, because the
          // usual cause is somebody trying a local dev server by accident.
          "private-host":
            "That address points at this machine or a private network, which this plugin will not fetch. Use a public https address.",
        };
        throw new Error(messages[checked.reason]);
      }

      // The same routine the git-host sweep uses, for the same reasons: a
      // bounded wait, a status we understand, a type that really is an image,
      // and a size the sidebar can carry. A URL the user chose is not more
      // trusted than one this plugin guessed; it is merely wanted.
      let image: string;
      try {
        image = await fetchRemoteAvatar(checked.url);
      } catch (error) {
        // The routine's own message names the status, content type or size
        // that stopped it, and that is exactly what tells the user whether to
        // fix the address or find another image.
        throw new Error(
          `Could not use that image: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      writeCustomAvatar(projectId, {
        kind: "image",
        color: null,
        initials: null,
        emoji: null,
        image,
      });
      return { image };
    },
  };

  /**
   * Which machine this server is running on, or null when it cannot tell.
   *
   * The only signal bb offers for "these files are within reach". A project
   * source names a `hostId`, and reading one whose host is a different machine
   * would mean opening whatever happens to sit at that path over here. Null —
   * a server no host has enrolled with yet — means no local file is read at
   * all, which is the safe direction to fail in.
   */
  const readOwnHostId = async (): Promise<string | null> => {
    try {
      const config = await bb.sdk.system.config();
      return config.primaryHostId ?? null;
    } catch (error) {
      bb.log.warn(
        `project-avatars: could not identify this machine, so no project folder is read (${String(error)})`,
      );
      return null;
    }
  };

  /**
   * Bring every project's avatar up to date: its own icon first, then the git
   * host's image for the projects that still need one.
   *
   * Sequential on purpose: this is background work with no deadline, and a
   * burst of parallel requests to one forge is exactly the behaviour that
   * gets a user rate-limited. `shouldRefetch` decides each project on its own,
   * so a steady state does no requests at all.
   */
  const sweepAvatars = async (): Promise<void> => {
    // Read fresh, like the archive sweep: the user can turn either of these
    // off between two runs of a daily schedule, and the promise the remote
    // setting makes is that no request goes out once it is off.
    const values = await readSettings();
    const scanLocal = values.localFaviconsEnabled;
    const fetchRemote = values.remoteAvatarsEnabled;
    if (!scanLocal && !fetchRemote) return;

    let projects: SweepProjectView[];
    try {
      projects = await bb.sdk.projects.list();
    } catch (error) {
      bb.log.warn(`project-avatars: could not list projects (${String(error)})`);
      return;
    }

    // Asked once per sweep rather than per project: it is the same answer for
    // all of them, and it is a round trip.
    const ownHostId = scanLocal ? await readOwnHostId() : null;

    const now = Date.now();
    let fetched = 0;
    let failed = 0;
    let skipped = 0;
    let local = 0;

    for (const project of projects) {
      const row = readAvatar(project.id);

      let faviconImage = row?.faviconImage ?? null;
      const root = scanLocal ? localSourcePath(project, ownHostId) : null;
      if (root !== null) {
        try {
          faviconImage = await scanProjectFavicon(project.id, root, row, now);
        } catch (error) {
          // A folder can be on an unmounted disk or refuse to be read. That
          // costs this project an icon, never the rest of the sweep.
          bb.log.warn(
            `project-avatars: could not scan ${root} (${String(error)})`,
          );
        }
        if (faviconImage !== null) local += 1;
      }

      if (!fetchRemote) continue;

      const desiredUrl = remoteAvatarUrl(project.gitRemoteUrl ?? null);
      const state: AvatarRefetchState = {
        customKind: row?.customKind ?? null,
        customImage: row?.customImage ?? null,
        faviconImage,
        remoteImage: row?.remoteImage ?? null,
        remoteUrl: row?.remoteUrl ?? null,
        fetchedAt: row?.fetchedAt ?? null,
        failedAt: row?.failedAt ?? null,
        failureCount: row?.failureCount ?? null,
        desiredUrl,
      };
      if (desiredUrl === null || !shouldRefetch(state, now)) {
        skipped += 1;
        continue;
      }
      if (await refreshOneAvatar(project.id, desiredUrl)) fetched += 1;
      else failed += 1;
    }

    bb.log.info(
      `project-avatars: ${projects.length} projects — ${local} from their own folder, fetched ${fetched}, failed ${failed}, left ${skipped} alone`,
    );
  };

  // A discovery sweep, not a refresh. An image that arrived is never asked for
  // again (see `shouldRefetch`), so this daily run only picks up a project
  // added since the last one — for a machine left running, the alternative is
  // waiting for a reload. A project that already has its avatar costs one
  // local stat here and no request at all.
  bb.background.schedule("project-avatars", "0 4 * * *", sweepAvatars);

  // A first sweep on load, so a freshly installed plugin — or a project added
  // while bb was closed — gets its avatar without waiting for 4am. Deferred off
  // the factory: a plugin that blocks its own load on a network round-trip
  // delays every other plugin behind it, and the sidebar renders monograms
  // until the images land anyway.
  const initialSweep = setTimeout(() => {
    void sweepAvatars().catch((error: unknown) => {
      bb.log.warn(`project-avatars: initial sweep failed (${String(error)})`);
    });
  }, INITIAL_SWEEP_DELAY_MS);
  // Nothing here is worth holding the process open for, and a reload must not
  // leave a timer pointing at a stale plugin handle.
  initialSweep.unref?.();
  bb.onDispose(() => clearTimeout(initialSweep));

  return { handlers, forgetAllFavicons };
}
