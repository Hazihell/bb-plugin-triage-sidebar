// bb-plugin-triage-sidebar backend — the settled / snoozed store.
//
// This state lives in the plugin's own SQLite database, never on bb's thread.
// Putting it on the thread would mean a schema change, a wire change, and a
// HOST_DAEMON_PROTOCOL_VERSION bump for something only this sidebar
// understands. Here, uninstalling the plugin removes its state with it.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  resolveSettledSweepAction,
  type ThreadActivitySignals,
} from "./lifecycle";
import {
  createProjectAvatarStore,
  projectAvatarRpcContract,
} from "./project-avatar-store";

// Append-only: the array index IS the migration id, so an existing statement
// can never be edited or reordered — a database that already ran statement 0
// would silently skip the edit. New columns arrive as their own ALTER.
//
// Most of these statements belong to the project-avatar store next door, and
// the list still stays whole here rather than moving with them. Two lists
// concatenated would give each half an index that moves whenever the OTHER
// half grows, and a renumbered migration is the one mistake in this file that
// a user's database cannot be talked out of afterwards. One list, one place to
// append, whichever module the column is for.
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

// Re-exported, not re-declared. The avatar store owns these; the frontend
// imports the plugin's whole surface from this one module, and a second import
// path for half of it would be a detail of the backend's layout leaking into
// components that have no reason to know it.
export {
  isAllowedAvatarDataUrl,
  localSourcePath,
  MAX_AVATAR_BYTES,
  PROJECT_AVATAR_CHANNEL,
  type CustomProjectAvatar,
  type StoredAvatarRow,
} from "./project-avatar-store";


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
  ...projectAvatarRpcContract,
});

/** Channel the frontend re-reads on. */
export const LIFECYCLE_CHANNEL = "lifecycle";

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


/** The subset of bb's thread DTO the sweep reads. */
interface SweepThreadView {
  status?: string;
  activeBackgroundAgentCount?: number;
  runtime?: { displayStatus?: string };
  /**
   * bb's own "when did this last want you" stamp — the same number the
   * sidebar's projection carries, so the sweep and the sidebar can be handed
   * to one shared rule instead of each having its own idea of un-settling.
   */
  latestAttentionAt?: number;
  lastReadAt?: number | null;
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
        "Asks the project's git host — github.com, gitlab.com, or your own server — for the owner's avatar image, once. This is an outbound request to that host from this machine. It is asked once per project and never again on a timer — the Settings panel refreshes one project on demand. A private or self-hosted host will usually refuse it, and those projects fall back to a generated monogram. Turn this off to make no such request at all; avatars you set yourself keep working either way.",
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

  // Everything about a project's picture, including its own daily sweep and
  // the one on load. It is handed the migrated database rather than migrating
  // its own, so the append-only list above stays the single place a schema
  // statement can be added.
  const avatars = createProjectAvatarStore({
    bb,
    db,
    readSettings: async () => {
      const values = await settings.get();
      return {
        remoteAvatarsEnabled: values.remoteAvatarsEnabled === true,
        localFaviconsEnabled: values.localFaviconsEnabled === true,
      };
    },
  });


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
    ...avatars.handlers,
  });

  // Turning the switch off has to take effect now, not at the next sweep: the
  // user is looking at the sidebar when they flip it, and an avatar that
  // stayed until tomorrow would read as the setting doing nothing.
  settings.onChange((next, previous) => {
    if (previous.localFaviconsEnabled === true && next.localFaviconsEnabled !== true) {
      avatars.forgetAllFavicons();
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

    const now = Date.now();
    const days = parseAutoArchiveDays(values.autoArchiveDays);
    const cutoff = now - days * DAY_MS;
    // An old `settled_at` only makes a thread worth LOOKING at. Whether it may
    // actually be archived is `resolveSettledSweepAction`'s answer below, from
    // the same rule the sidebar draws with.
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
    let unsettled = 0;
    let forgotten = 0;
    let failed = 0;

    for (const threadId of candidates) {
      // Re-read rather than carry the id's row from the query above: the user
      // can settle, snooze or unsettle while this loop is awaiting bb.
      const row = readOne(threadId);
      if (row === undefined) {
        forgotten += 1;
        continue;
      }

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

      const isWorking = isThreadWorking(thread);
      const latestAttentionAt = thread.latestAttentionAt ?? 0;
      const signals: ThreadActivitySignals = {
        isWorking,
        // Not asked while the thread is plainly working: working already
        // blocks parking on its own, and this is a round trip per candidate.
        hasPendingInteraction: isWorking
          ? false
          : await isBlockedOnUser(threadId),
        isUnread:
          thread.lastReadAt == null || thread.lastReadAt < latestAttentionAt,
        latestAttentionAt,
      };

      const action = resolveSettledSweepAction(row, signals, now);
      if (action === "skip") {
        skipped += 1;
        continue;
      }
      if (action === "unsettle") {
        // The thread has spoken since the settle, so the sidebar is already
        // showing it in the inbox. Clearing the stale row makes the two agree
        // for good, instead of leaving a candidate this sweep has to talk
        // itself out of again every hour.
        clear(threadId);
        unsettled += 1;
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
      `auto-archive: ${candidates.length} settled over ${days}d — archived ${archived}, skipped ${skipped} still live, un-settled ${unsettled} back in the inbox, cleared ${forgotten} missing, failed ${failed}`,
    );
  });

}