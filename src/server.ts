// bb-plugin-triage-sidebar backend — the settled / snoozed store.
//
// This state lives in the plugin's own SQLite database, never on bb's thread.
// Putting it on the thread would mean a schema change, a wire change, and a
// HOST_DAEMON_PROTOCOL_VERSION bump for something only this sidebar
// understands. Here, uninstalling the plugin removes its state with it.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  remoteAvatarUrl,
  shouldRefetch,
  type AvatarRefetchState,
} from "./avatar-remote";
import {
  faviconMimeType,
  faviconSearchDirectories,
  MONOREPO_PARENTS,
  rankFaviconCandidates,
} from "./favicon-scan";

// Append-only: the array index IS the migration id, so an existing statement
// can never be edited or reordered — a database that already ran statement 0
// would silently skip the edit. New columns arrive as their own ALTER.
const migrations = [
  `CREATE TABLE IF NOT EXISTS thread_lifecycle (
     thread_id      TEXT PRIMARY KEY,
     settled_at     INTEGER,
     snoozed_until  INTEGER,
     snoozed_at     INTEGER
   )`,
  `ALTER TABLE thread_lifecycle ADD COLUMN started_working_at INTEGER`,
  // One row per project that has an avatar of any kind. The custom_* columns
  // are what the user chose and the remote_* ones are a cache of what the git
  // host served, kept apart so clearing one never destroys the other.
  `CREATE TABLE IF NOT EXISTS project_avatar (
     project_id      TEXT PRIMARY KEY,
     custom_kind     TEXT,
     custom_color    TEXT,
     custom_initials TEXT,
     custom_emoji    TEXT,
     custom_image    TEXT,
     remote_image    TEXT,
     remote_url      TEXT,
     fetched_at      INTEGER,
     failed_at       INTEGER,
     failure_count   INTEGER
   )`,
  // The kind was first written as "color". Renamed because what the user is
  // customizing is the monogram, not merely its colour — and because the
  // frontend's resolver only knows the new name, so a database written by the
  // older statement would render an unrecognized kind as no avatar at all.
  `UPDATE project_avatar SET custom_kind = 'monogram' WHERE custom_kind = 'color'`,
  // The project's own icon, read from its checkout on this machine. A third
  // source alongside custom_* and remote_*, and separate from both for the
  // same reason those two are separate: each has its own owner, and one being
  // cleared may never destroy another's.
  `ALTER TABLE project_avatar ADD COLUMN favicon_image TEXT`,
  // The file this image came from, relative to the project root. Two jobs: it
  // is shown to the user (the only thing that explains a wrong icon), and a
  // change in it means the checkout gained a better candidate.
  `ALTER TABLE project_avatar ADD COLUMN favicon_path TEXT`,
  // The file's modification time, so an unchanged icon costs one stat instead
  // of a re-read of the image on every sweep.
  `ALTER TABLE project_avatar ADD COLUMN favicon_mtime INTEGER`,
  `ALTER TABLE project_avatar ADD COLUMN favicon_scanned_at INTEGER`,
  // When a project was last found to have no icon at all. Without it, every
  // project that will never have a favicon re-walks its directories on every
  // plugin load, forever.
  `ALTER TABLE project_avatar ADD COLUMN favicon_missing_at INTEGER`,
];

export interface StoredLifecycleRow {
  threadId: string;
  settledAt: number | null;
  snoozedUntil: number | null;
  snoozedAt: number | null;
  /**
   * When the thread's current run began, from bb's `thread.active` event;
   * null whenever it is not running.
   *
   * The frontend cannot derive this. A sidebar thread carries what is
   * happening, not since when, and a component that started its own timer
   * would reset it on every remount and lose it across a reload.
   */
  startedWorkingAt: number | null;
}

interface LifecycleDbRow {
  thread_id: string;
  settled_at: number | null;
  snoozed_until: number | null;
  snoozed_at: number | null;
  started_working_at: number | null;
}

const threadIdSchema = z.object({ threadId: z.string().trim().min(1) });

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

export const triageSidebarRpcContract = defineRpcContract({
  listLifecycle: {
    input: z.object({}),
    output: z.object({
      rows: z.array(
        z.object({
          threadId: z.string(),
          settledAt: z.number().nullable(),
          snoozedUntil: z.number().nullable(),
          snoozedAt: z.number().nullable(),
          startedWorkingAt: z.number().nullable(),
        }),
      ),
    }),
  },
  settle: { input: threadIdSchema, output: z.object({ ok: z.boolean() }) },
  unsettle: { input: threadIdSchema, output: z.object({ ok: z.boolean() }) },
  snooze: {
    input: z.object({
      threadId: z.string().trim().min(1),
      // Absolute wake time, so a snooze means the same thing on every device.
      snoozedUntil: z.number().int().positive(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  unsnooze: { input: threadIdSchema, output: z.object({ ok: z.boolean() }) },
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
});

/** Channel the frontend re-reads on. */
export const LIFECYCLE_CHANNEL = "lifecycle";

/** Channel for avatar changes, kept apart so a sweep does not churn the list. */
export const PROJECT_AVATAR_CHANNEL = "project-avatars";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days to keep a settled thread before archiving it, when the setting is unusable. */
export const DEFAULT_AUTO_ARCHIVE_DAYS = 7;

/**
 * The settings API has no number type, so the retention period travels as a
 * string a user can type anything into. Anything that is not a whole number of
 * days above zero falls back to the default: a broken setting must not turn
 * into an immediate sweep of every settled thread.
 */
export function parseAutoArchiveDays(raw: string | undefined): number {
  const parsed = Number(String(raw ?? "").trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_AUTO_ARCHIVE_DAYS;
  }
  return parsed;
}

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

/** The subset of bb's thread DTO the sweep needs to recognize live work. */
interface SweepThreadView {
  status?: string;
  activeBackgroundAgentCount?: number;
  runtime?: { displayStatus?: string };
}

/**
 * Whether bb's own thread record shows work in flight.
 *
 * The mirror of `canPark`'s isWorking arm in src/lifecycle.ts, read from the
 * server's DTO instead of the sidebar's. Deliberately generous: every status
 * that is not plainly finished counts as working, because archiving a thread
 * that is still running is the one failure this sweep cannot afford.
 */
export function isThreadWorking(thread: SweepThreadView): boolean {
  if ((thread.activeBackgroundAgentCount ?? 0) > 0) return true;
  const statuses = [thread.status, thread.runtime?.displayStatus];
  return statuses.some(
    (status) =>
      status === "active" ||
      status === "starting" ||
      status === "stopping" ||
      status === "provisioning",
  );
}

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);

  const settings = bb.settings.define({
    autoArchiveEnabled: {
      type: "boolean",
      label: "Auto-archive settled threads",
      description:
        "Archive a thread that has sat on the Settled shelf untouched, once it is older than the retention period.",
      default: true,
    },
    autoArchiveDays: {
      type: "string",
      label: "Days before a settled thread is archived",
      description: "A whole number of days. Anything else is read as 7.",
      default: String(DEFAULT_AUTO_ARCHIVE_DAYS),
    },
    remoteAvatarsEnabled: {
      type: "boolean",
      label: "Fetch project avatars from the git host",
      description:
        "Asks the project's git host — github.com, gitlab.com, or your own server — for the owner's avatar image, once a day. This is an outbound request to that host from this machine. A private or self-hosted host will usually refuse it, and those projects fall back to a generated monogram. Turn this off to make no such request at all; avatars you set yourself keep working either way.",
      default: true,
    },
    localFaviconsEnabled: {
      type: "boolean",
      label: "Use a project's own icon from its folder",
      description:
        "Reads an icon file — favicon.svg, apple-touch-icon.png and the like — out of the project's own folder on this machine, and uses it as that project's avatar. This makes no network request of any kind: it only opens a file inside a folder you already opened in bb, and only on this machine. Turn it off to fall back to the git host's image, or to a generated monogram. Avatars you set yourself outrank this either way.",
      default: true,
    },
  });

  const readAll = (): StoredLifecycleRow[] =>
    (
      db
        .prepare(
          `SELECT thread_id, settled_at, snoozed_until, snoozed_at,
                  started_working_at
             FROM thread_lifecycle`,
        )
        .all() as LifecycleDbRow[]
    ).map((row) => ({
      threadId: row.thread_id,
      settledAt: row.settled_at,
      snoozedUntil: row.snoozed_until,
      snoozedAt: row.snoozed_at,
      startedWorkingAt: row.started_working_at,
    }));

  const readOne = (threadId: string): StoredLifecycleRow | undefined => {
    const row = db
      .prepare(
        `SELECT thread_id, settled_at, snoozed_until, snoozed_at,
                started_working_at
           FROM thread_lifecycle WHERE thread_id = ?`,
      )
      .get(threadId) as LifecycleDbRow | undefined;
    if (row === undefined) return undefined;
    return {
      threadId: row.thread_id,
      settledAt: row.settled_at,
      snoozedUntil: row.snoozed_until,
      snoozedAt: row.snoozed_at,
      startedWorkingAt: row.started_working_at,
    };
  };

  const write = (row: StoredLifecycleRow): void => {
    db.prepare(
      `INSERT INTO thread_lifecycle
         (thread_id, settled_at, snoozed_until, snoozed_at, started_working_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         settled_at = excluded.settled_at,
         snoozed_until = excluded.snoozed_until,
         snoozed_at = excluded.snoozed_at,
         started_working_at = excluded.started_working_at`,
    ).run(
      row.threadId,
      row.settledAt,
      row.snoozedUntil,
      row.snoozedAt,
      row.startedWorkingAt,
    );
    bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId: row.threadId });
  };

  const clear = (threadId: string): void => {
    db.prepare(`DELETE FROM thread_lifecycle WHERE thread_id = ?`).run(
      threadId,
    );
    bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId });
  };

  /**
   * Record — or clear — when the current run began.
   *
   * Kept apart from `write` because the two answer to different owners: the
   * user parks a thread, bb decides when it runs, and neither may overwrite
   * the other's column. A start upserts, so a thread with no parking state
   * still gets a row; a stop only updates, then deletes a row that has nothing
   * left in it, so an idle thread never leaves an empty row to be swept.
   */
  const markWorking = (threadId: string, startedAt: number | null): void => {
    if (startedAt === null) {
      const updated = db
        .prepare(
          `UPDATE thread_lifecycle SET started_working_at = NULL
             WHERE thread_id = ? AND started_working_at IS NOT NULL`,
        )
        .run(threadId);
      if (updated.changes === 0) return;
      db.prepare(
        `DELETE FROM thread_lifecycle
           WHERE thread_id = ?
             AND settled_at IS NULL
             AND snoozed_until IS NULL
             AND snoozed_at IS NULL
             AND started_working_at IS NULL`,
      ).run(threadId);
    } else {
      db.prepare(
        `INSERT INTO thread_lifecycle (thread_id, started_working_at)
           VALUES (?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           started_working_at = excluded.started_working_at`,
      ).run(threadId, startedAt);
    }
    // The sidebar reads this store on the same channel as a parking change:
    // without the signal the elapsed label would only appear on the next
    // unrelated refresh.
    bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId });
  };

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

  bb.rpc.register(triageSidebarRpcContract, {
    async listLifecycle() {
      return { rows: readAll() };
    },
    async settle({ threadId }) {
      // Settling clears any snooze: they are two answers to the same
      // question, and holding both would make the shelf order ambiguous.
      // The run start survives — it belongs to bb, not to this decision.
      write({
        threadId,
        settledAt: Date.now(),
        snoozedUntil: null,
        snoozedAt: null,
        startedWorkingAt: readOne(threadId)?.startedWorkingAt ?? null,
      });
      return { ok: true };
    },
    async unsettle({ threadId }) {
      clear(threadId);
      return { ok: true };
    },
    async snooze({ threadId, snoozedUntil }) {
      const now = Date.now();
      write({
        threadId,
        settledAt: null,
        snoozedUntil,
        snoozedAt: now,
        startedWorkingAt: readOne(threadId)?.startedWorkingAt ?? null,
      });
      return { ok: true };
    },
    async unsnooze({ threadId }) {
      clear(threadId);
      return { ok: true };
    },
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
      const values = await settings.get();
      if (!values.remoteAvatarsEnabled) return { ok: false };

      let project: SweepProjectView;
      try {
        project = (await bb.sdk.projects.get({
          projectId,
        })) as SweepProjectView;
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
  });

  // Turning the switch off has to take effect now, not at the next sweep: the
  // user is looking at the sidebar when they flip it, and an avatar that
  // stayed until tomorrow would read as the setting doing nothing.
  settings.onChange((next, previous) => {
    if (previous.localFaviconsEnabled === true && next.localFaviconsEnabled !== true) {
      forgetAllFavicons();
    }
  });

  // A deleted thread must not leave a row behind that would park a future
  // thread reusing the id, and stale rows accumulate otherwise.
  bb.events.on("thread.deleted", ({ thread }) => {
    clear(thread.id);
  });

  // bb reports the transitions; the clock is read here, once, so every client
  // measures the same run from the same instant.
  bb.events.on("thread.active", ({ thread }) => {
    markWorking(thread.id, Date.now());
  });
  bb.events.on("thread.idle", ({ thread }) => {
    markWorking(thread.id, null);
  });
  // A failed run has also stopped: leaving the start behind would show a
  // timer that counts up forever against work that is no longer happening.
  bb.events.on("thread.failed", ({ thread }) => {
    markWorking(thread.id, null);
  });

  /**
   * Whether the agent is waiting on an answer from the user.
   *
   * bb's thread DTO does not carry this — only the sidebar's projection does —
   * so the sweep asks for the interactions directly. An unanswerable check
   * counts as blocked: when in doubt this sweep leaves the thread alone.
   */
  const isBlockedOnUser = async (threadId: string): Promise<boolean> => {
    try {
      const interactions = await bb.sdk.threads.interactions.list({ threadId });
      return interactions.some(
        (interaction) => interaction.status === "pending",
      );
    } catch (error) {
      bb.log.warn(
        `auto-archive: could not read pending interactions for ${threadId}, leaving it alone (${String(error)})`,
      );
      return true;
    }
  };

  /**
   * The hourly sweep: settled threads the user has not come back to eventually
   * leave the sidebar for the archive.
   *
   * Settling is a judgement the user already made, and the shelf keeps it
   * reversible until this point. The sweep only finishes that decision — it
   * never makes one, which is why anything still alive is skipped rather than
   * archived, and why the row is only cleared once the archive succeeded.
   */
  bb.background.schedule("auto-archive", "0 * * * *", async () => {
    // Read fresh rather than closing over a load-time snapshot: the user can
    // turn this off between two runs of an hourly schedule.
    const values = await settings.get();
    if (!values.autoArchiveEnabled) return;

    const days = parseAutoArchiveDays(values.autoArchiveDays);
    const cutoff = Date.now() - days * DAY_MS;
    const candidates = (
      db
        .prepare(
          `SELECT thread_id FROM thread_lifecycle
             WHERE settled_at IS NOT NULL AND settled_at < ?`,
        )
        .all(cutoff) as Array<{ thread_id: string }>
    ).map((row) => row.thread_id);

    let archived = 0;
    let skipped = 0;
    let forgotten = 0;
    let failed = 0;

    for (const threadId of candidates) {
      let thread: SweepThreadView | null;
      try {
        thread = (await bb.sdk.threads.get({ threadId })) as SweepThreadView;
      } catch {
        // Gone from bb, so the row describes nothing. Dropping it also stops
        // this sweep from retrying the same dead id every hour.
        clear(threadId);
        forgotten += 1;
        continue;
      }
      if (thread === null || thread === undefined) {
        clear(threadId);
        forgotten += 1;
        continue;
      }

      if (isThreadWorking(thread) || (await isBlockedOnUser(threadId))) {
        skipped += 1;
        continue;
      }

      try {
        await bb.sdk.threads.archive({ threadId });
      } catch (error) {
        // Keep the row: the thread is still on the shelf, and the next sweep
        // gets another chance.
        bb.log.warn(
          `auto-archive: archiving ${threadId} failed (${String(error)})`,
        );
        failed += 1;
        continue;
      }
      // The lifecycle row exists to place a thread on a shelf. Archived, it
      // has no shelf, and a leftover row would park it again if unarchived.
      clear(threadId);
      archived += 1;
    }

    bb.log.info(
      `auto-archive: ${candidates.length} settled over ${days}d — archived ${archived}, skipped ${skipped} still live, cleared ${forgotten} missing, failed ${failed}`,
    );
  });

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
      const config = (await bb.sdk.system.config()) as {
        primaryHostId?: string | null;
      };
      return config?.primaryHostId ?? null;
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
    const values = await settings.get();
    const scanLocal = values.localFaviconsEnabled === true;
    const fetchRemote = values.remoteAvatarsEnabled === true;
    if (!scanLocal && !fetchRemote) return;

    let projects: SweepProjectView[];
    try {
      projects = (await bb.sdk.projects.list()) as SweepProjectView[];
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
}
