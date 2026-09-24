// bb-plugin-triage-sidebar backend — the settled / snoozed store.
//
// This state lives in the plugin's own SQLite database, never on bb's thread.
// Putting it on the thread would mean a schema change, a wire change, and a
// HOST_DAEMON_PROTOCOL_VERSION bump for something only this sidebar
// understands. Here, uninstalling the plugin removes its state with it.
import { randomUUID } from "node:crypto";
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
import { hostContract } from "./host-contract";
import {
  LIFECYCLE_CHANNEL,
  type LifecycleReapedMessage,
  type LifecycleRowMessage,
} from "./lifecycle-sync";
import {
  forEachLimited,
  isRunningStatus,
  readStartedTiming,
  readStoppedTiming,
  readTurnTiming,
  type TurnEventLog,
  type TurnTiming,
} from "./turn-timing";

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
  // A one-row-per-key scratchpad for the plugin's own bookkeeping — currently
  // just when the auto-archive sweep last ran. Deliberately not a column on
  // thread_lifecycle: this is about the sweep, not about any one thread, and
  // there may be no threads at all.
  `CREATE TABLE IF NOT EXISTS plugin_state (
     key   TEXT PRIMARY KEY,
     value TEXT
   )`,
  // When the thread's own last run ENDED. The age on a card is measured from
  // here rather than from bb's updatedAt, because the question it answers is
  // "how much of the agent's prompt-cache window is left", and updatedAt moves
  // for things that have nothing to do with a run.
  `ALTER TABLE thread_lifecycle ADD COLUMN last_run_ended_at INTEGER`,
];

export interface StoredLifecycleRow {
  threadId: string;
  settledAt: number | null;
  snoozedUntil: number | null;
  snoozedAt: number | null;
  /**
   * When the turn in flight started — the newest `turn/started` row in bb's
   * event log — or null whenever no turn is running.
   *
   * The frontend cannot derive this. A sidebar thread carries what is
   * happening, not since when, and a component that started its own timer
   * would reset it on every remount and lose it across a reload.
   */
  startedWorkingAt: number | null;
  /**
   * When the thread's newest turn ended — the newest `turn/completed` row in
   * bb's event log — or null when no turn ever has.
   *
   * A cache of the log, not a record of its own: the idle age is how much of
   * the agent's prompt-cache window is left, so it must be the instant the
   * last API response landed, and bb's `updatedAt` moves on renames, pins and
   * reads. There is deliberately no fallback to it.
   */
  lastRunEndedAt: number | null;
}

interface LifecycleDbRow {
  thread_id: string;
  settled_at: number | null;
  snoozed_until: number | null;
  snoozed_at: number | null;
  started_working_at: number | null;
  last_run_ended_at: number | null;
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


/**
 * What a reap did, for whichever caller asked for it.
 *
 * Terminals and processes are counted separately because they fail for
 * different reasons and a user reading the report can act on only one of them:
 * a terminal that will not close is bb's business, a process that will not die
 * is theirs.
 */
const reapSummarySchema = z.object({
  /** False when the setting is off: nothing was looked at, let alone killed. */
  enabled: z.boolean(),
  terminalsClosed: z.array(
    z.object({ terminalId: z.string(), title: z.string() }),
  ),
  terminalsFailed: z.number(),
  processesKilled: z.array(
    z.object({ pid: z.number(), command: z.string() }),
  ),
  processesFailed: z.number(),
  worktreesSkipped: z.array(
    z.object({ path: z.string(), reason: z.enum(["in-use", "unreachable"]) }),
  ),
});

export const triageSidebarRpcContract = defineRpcContract({
  // The whole table, with the change counter it is current as of. The
  // sidebar reads this once and on recovery; every change after it arrives
  // as a numbered row message on the lifecycle channel.
  listLifecycle: {
    input: z.object({}),
    output: z.object({
      epoch: z.string(),
      seq: z.number(),
      rows: z.array(
        z.object({
          threadId: z.string(),
          settledAt: z.number().nullable(),
          snoozedUntil: z.number().nullable(),
          snoozedAt: z.number().nullable(),
          startedWorkingAt: z.number().nullable(),
          lastRunEndedAt: z.number().nullable(),
        }),
      ),
    }),
  },
  // Settling returns as soon as the shelf is written. The reap that follows
  // can take seconds — a dev server gets its grace period to exit — and the
  // user's decision must not wait on it. What it stopped arrives afterwards
  // on the lifecycle channel as a `reaped` message.
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
  // The same sweep the schedule runs, on demand. It reports what it
  // did rather than just "ok": a sweep that archives nothing is the normal
  // case, and a bare success would be indistinguishable from a broken one.
  // What the schedule is going to do next, for the Settings panel. Read
  // rather than derived on the client: the cron runs in the server's local
  // time, and a browser in another timezone would compute a different hour.
  autoArchiveStatus: {
    input: z.object({}),
    output: z.object({
      enabled: z.boolean(),
      intervalHours: z.number(),
      days: z.number(),
      lastRunAt: z.number().nullable(),
      nextRunAt: z.number(),
      /** The server's clock, so the panel measures "in 3h" from the same one. */
      now: z.number(),
    }),
  },
  runAutoArchive: {
    input: z.object({}),
    output: z.object({
      enabled: z.boolean(),
      days: z.number(),
      candidates: z.number(),
      archived: z.array(z.object({ threadId: z.string(), title: z.string() })),
      skipped: z.number(),
      unsettled: z.number(),
      forgotten: z.number(),
      failed: z.number(),
      reaped: reapSummarySchema,
    }),
  },
  // The settings the SIDEBAR draws with, as opposed to the ones the backend
  // acts on alone. bb renders the settings form and keeps the values on the
  // server, and a component has no other way to read one.
  getSettings: {
    input: z.object({}),
    output: z.object({
      cacheWarnAfterMinutes: z.number(),
      cacheColdAfterMinutes: z.number(),
    }),
  },
  ...projectAvatarRpcContract,
});

export { LIFECYCLE_CHANNEL } from "./lifecycle-sync";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long one worktree sweep may take on its host. */
const REAP_HOST_TIMEOUT_MS = 60_000;

/** How long after load the turn-timing backfill starts. */
export const BACKFILL_DELAY_MS = 2_000;
const BACKFILL_PAGE_SIZE = 200;
const BACKFILL_CONCURRENCY = 6;

/**
 * How often the schedule TICKS — not how often the sweep runs.
 *
 * `bb.background.schedule` fixes its cron when the plugin loads and offers no
 * way to change it afterwards, so a cron built from the user's setting would
 * not take effect until the next reload. Instead this ticks at the finest
 * interval the setting allows, and each tick asks whether enough time has
 * passed. Changing the setting then applies to the very next tick.
 */
export const AUTO_ARCHIVE_CRON = "0 * * * *";

/** How often the sweep runs, when the setting is unusable. */
export const DEFAULT_AUTO_ARCHIVE_INTERVAL_HOURS = 4;

/** Key under which the last sweep's timestamp lives in `plugin_state`. */
const LAST_SWEEP_KEY = "autoArchiveLastRunAt";

/**
 * When the sweep will next actually run.
 *
 * Two things decide it, and reporting only one of them would be a lie. The
 * interval says when the sweep becomes DUE; the hourly ticker says when
 * anything can happen at all. A sweep due at 14:20 does not run at 14:20 — it
 * runs at 15:00, the first tick at or after it — so this rounds up to the
 * hour rather than reporting the due time.
 */
export function nextAutoArchiveRunAt(
  now: number,
  lastRunAt: number | null,
  intervalHours: number,
): number {
  // Never swept: due immediately, so the answer is simply the next tick.
  const dueAt = lastRunAt === null ? now : lastRunAt + intervalHours * HOUR_MS;
  const firstTickAfterNow = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS;
  const firstTickAtOrAfterDue = Math.ceil(dueAt / HOUR_MS) * HOUR_MS;
  return Math.max(firstTickAfterNow, firstTickAtOrAfterDue);
}

/**
 * The interval between sweeps, in whole hours.
 *
 * Read like the retention period next door: the settings API has no number
 * type, so anything that is not a whole number of hours above zero falls back
 * to the default. Below one hour is rejected rather than rounded, because the
 * schedule only ticks hourly and a setting of 0 would promise a sweep the
 * ticker cannot deliver.
 */
export function parseAutoArchiveIntervalHours(raw: string | undefined): number {
  const parsed = Number(String(raw ?? "").trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_AUTO_ARCHIVE_INTERVAL_HOURS;
  }
  return parsed;
}

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
 * The prompt-cache window, in minutes: when an idle thread is worth warning
 * about, and when the window is simply gone.
 *
 * These are the two edges of one band, so they are parsed together: a warn
 * threshold at or above the cold one would leave a band no thread can ever be
 * in, and a card that never turns amber is indistinguishable from a broken
 * one. A crossed pair falls back to the defaults rather than being silently
 * reordered — the user typed something they meant, and guessing which half is
 * the mistake is worse than saying nothing.
 */
export const DEFAULT_CACHE_WARN_AFTER_MINUTES = 50;
export const DEFAULT_CACHE_COLD_AFTER_MINUTES = 60;

export interface CacheWindowMinutes {
  warnAfterMinutes: number;
  coldAfterMinutes: number;
}

function parseMinutes(raw: string | undefined): number | null {
  const parsed = Number(String(raw ?? "").trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

export function parseCacheWindow(
  warnRaw: string | undefined,
  coldRaw: string | undefined,
): CacheWindowMinutes {
  const warn = parseMinutes(warnRaw);
  const cold = parseMinutes(coldRaw);
  if (warn === null || cold === null || warn >= cold) {
    return {
      warnAfterMinutes: DEFAULT_CACHE_WARN_AFTER_MINUTES,
      coldAfterMinutes: DEFAULT_CACHE_COLD_AFTER_MINUTES,
    };
  }
  return { warnAfterMinutes: warn, coldAfterMinutes: cold };
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
  /** Named only so a manual run can report what it archived, by name. */
  title?: string | null;
  titleFallback?: string | null;
}

/** One thread a sweep archived, named so the caller can list it. */
export interface ArchivedThread {
  threadId: string;
  title: string;
}

/** What one sweep did, whether it ran on the schedule or from the button. */
export interface AutoArchiveSweepResult {
  /** False when the setting is off: the sweep returned without looking. */
  enabled: boolean;
  days: number;
  candidates: number;
  archived: ArchivedThread[];
  skipped: number;
  unsettled: number;
  forgotten: number;
  failed: number;
  /** Everything the sweep's own reaps stopped, folded into one tally. */
  reaped: ReapSummary;
}

/**
 * Closed terminals and killed processes are listed by name, not counted.
 * Stopping a user's dev server is a visible act, and a bare number would leave
 * them hunting for whichever server is no longer listening. Failures stay
 * counts: what failed is in the log, and there is nothing the user can do with
 * the identity of a terminal bb could not close.
 */
export interface ReapSummary {
  enabled: boolean;
  terminalsClosed: Array<{ terminalId: string; title: string }>;
  terminalsFailed: number;
  processesKilled: Array<{ pid: number; command: string }>;
  processesFailed: number;
  /**
   * Worktrees whose processes were deliberately left running, named because
   * the user may expect them stopped: another thread is mid-turn there, or
   * the machine holding it could not be reached.
   */
  worktreesSkipped: Array<{ path: string; reason: "in-use" | "unreachable" }>;
}

export function emptyReapSummary(enabled: boolean): ReapSummary {
  return {
    enabled,
    terminalsClosed: [],
    terminalsFailed: 0,
    processesKilled: [],
    processesFailed: 0,
    worktreesSkipped: [],
  };
}

/**
 * A sweep reaps once per settled thread but reports once, so the lists
 * concatenate and the counts add. `enabled` is an OR: one reap that ran is
 * enough to make the report a real one.
 */
export function mergeReapSummaries(
  into: ReapSummary,
  next: ReapSummary,
): ReapSummary {
  return {
    enabled: into.enabled || next.enabled,
    terminalsClosed: [...into.terminalsClosed, ...next.terminalsClosed],
    terminalsFailed: into.terminalsFailed + next.terminalsFailed,
    processesKilled: [...into.processesKilled, ...next.processesKilled],
    processesFailed: into.processesFailed + next.processesFailed,
    worktreesSkipped: [...into.worktreesSkipped, ...next.worktreesSkipped],
  };
}

/**
 * The archived thread's name for the report, by the same rule the cards use.
 * Read before the archive call, because the DTO is what the sweep already has
 * and re-reading an archived thread to name it would be a second round trip.
 */
export function sweepThreadTitle(thread: SweepThreadView): string {
  const title = thread.title?.trim();
  if (title) return title;
  const fallback = thread.titleFallback?.trim();
  return fallback ? fallback : "Untitled thread";
}

/**
 * A thread and its descendants, deepest first.
 *
 * bb's archive takes a thread's direct children with it, but only one level
 * down: archiving a child *releases* that child's own children instead —
 * their parent link is cleared and they reappear in the sidebar as roots,
 * carrying a "released from parent" note. Walking the subtree and archiving
 * from the leaves up means every thread's children are already archived by
 * the time its own turn comes, so nothing is ever released.
 *
 * `listChildIds` is passed in rather than read from bb here so the order can
 * be tested without a server. `maxDepth` and the visited set are guards, not
 * policy: a cycle or a runaway tree should cost a bounded number of round
 * trips rather than hang the sweep.
 */
export async function collectSubtreeDeepestFirst(
  rootThreadId: string,
  listChildIds: (parentThreadId: string) => Promise<string[]>,
  maxDepth = 20,
): Promise<string[]> {
  const seen = new Set<string>([rootThreadId]);

  const walk = async (threadId: string, depth: number): Promise<string[]> => {
    if (depth >= maxDepth) return [threadId];
    const order: string[] = [];
    for (const childId of await listChildIds(threadId)) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      order.push(...(await walk(childId, depth + 1)));
    }
    order.push(threadId);
    return order;
  };

  return walk(rootThreadId, 0);
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
    autoArchiveIntervalHours: {
      type: "string",
      label: "Hours between auto-archive sweeps",
      description:
        "A whole number of hours, at least 1. Anything else is read as 4. This is only how often the shelf is checked — how long a thread waits there is the retention period below.",
      default: String(DEFAULT_AUTO_ARCHIVE_INTERVAL_HOURS),
    },
    autoArchiveDays: {
      type: "string",
      label: "Days before a settled thread is archived",
      description: "A whole number of days. Anything else is read as 7.",
      default: String(DEFAULT_AUTO_ARCHIVE_DAYS),
    },
    cacheWarnAfterMinutes: {
      type: "string",
      label: "Minutes before an idle thread's age turns amber",
      description:
        "A whole number of minutes, below the cold threshold. The age on a card is how long the agent has been quiet, which is how much of its prompt-cache window is left; past this it is worth knowing that a reply is about to cost a full re-read. Anything unusable is read as 50.",
      default: String(DEFAULT_CACHE_WARN_AFTER_MINUTES),
    },
    cacheColdAfterMinutes: {
      type: "string",
      label: "Minutes after which the cache window is gone",
      description:
        "A whole number of minutes, above the warn threshold. Past this the warning stops: the window has already lapsed, and an amber age would go on nagging about a decision there is no longer anything to do about. Anything unusable is read as 60.",
      default: String(DEFAULT_CACHE_COLD_AFTER_MINUTES),
    },
    reapOnSettle: {
      type: "boolean",
      label: "Stop leftover terminals and processes when a thread settles",
      description:
        "Settling a thread means its work is done, so its terminals are closed and anything still running in its worktree — dev servers, watchers, bundlers an agent started and never stopped — is stopped too, on whichever machine holds the worktree. This includes the thread's child threads. A thread in the project's own checkout only has its terminals closed: nothing else there is swept. A worktree where another thread is mid-turn is left alone; one shared with an idle thread you have NOT settled loses its processes, because a process that outlived its terminal carries nothing to tell the two apart. Turn this off to leave every process running.",
      default: true,
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
                  started_working_at, last_run_ended_at
             FROM thread_lifecycle`,
        )
        .all() as LifecycleDbRow[]
    ).map((row) => ({
      threadId: row.thread_id,
      settledAt: row.settled_at,
      snoozedUntil: row.snoozed_until,
      snoozedAt: row.snoozed_at,
      startedWorkingAt: row.started_working_at,
      lastRunEndedAt: row.last_run_ended_at,
    }));

  const readOne = (threadId: string): StoredLifecycleRow | undefined => {
    const row = db
      .prepare(
        `SELECT thread_id, settled_at, snoozed_until, snoozed_at,
                started_working_at, last_run_ended_at
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
      lastRunEndedAt: row.last_run_ended_at,
    };
  };

  /**
   * Which run of this server numbered the changes, and how many it has
   * published. A client holding a copy from another run — the plugin was
   * reloaded — cannot trust its counter and reads the table again.
   */
  const epoch = randomUUID();
  let seq = 0;

  /**
   * Tell every sidebar what one thread's row now is — the row itself, not a
   * hint to re-read. Every write goes through here, after it lands, so the
   * message always carries the committed state.
   */
  const publishRow = (threadId: string): void => {
    seq += 1;
    const message: LifecycleRowMessage = {
      kind: "row",
      epoch,
      seq,
      threadId,
      row: readOne(threadId) ?? null,
    };
    bb.realtime.publish(LIFECYCLE_CHANNEL, message);
  };

  /** A row with nothing left in it goes, so the table never fills with them. */
  const deleteIfEmpty = (threadId: string): void => {
    db.prepare(
      `DELETE FROM thread_lifecycle
         WHERE thread_id = ?
           AND settled_at IS NULL
           AND snoozed_until IS NULL
           AND snoozed_at IS NULL
           AND started_working_at IS NULL
           AND last_run_ended_at IS NULL`,
    ).run(threadId);
  };

  /**
   * Write the user's parking decision, and only that.
   *
   * The parking columns and bb's timing columns answer to different owners:
   * the user parks a thread, bb decides when it runs. This touches the first
   * three and never the other two, so un-parking a thread keeps its idle age.
   */
  const writeParking = (
    threadId: string,
    parking: {
      settledAt: number | null;
      snoozedUntil: number | null;
      snoozedAt: number | null;
    },
  ): void => {
    db.prepare(
      `INSERT INTO thread_lifecycle (thread_id, settled_at, snoozed_until, snoozed_at)
         VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         settled_at = excluded.settled_at,
         snoozed_until = excluded.snoozed_until,
         snoozed_at = excluded.snoozed_at`,
    ).run(threadId, parking.settledAt, parking.snoozedUntil, parking.snoozedAt);
    deleteIfEmpty(threadId);
    publishRow(threadId);
  };

  /** Forget a thread entirely — it was deleted or archived. */
  const clear = (threadId: string): void => {
    const deleted = db
      .prepare(`DELETE FROM thread_lifecycle WHERE thread_id = ?`)
      .run(threadId);
    if (deleted.changes > 0) publishRow(threadId);
  };

  /**
   * Store a thread's turn timing as bb's event log reports it.
   *
   * Kept apart from `write` because the two answer to different owners: the
   * user parks a thread, bb decides when it runs, and neither may overwrite
   * the other's columns. Timing upserts, so a thread with no parking state
   * still gets a row — the idle age is read from it. A row left with nothing
   * in it at all is deleted, so the table never fills with empty rows.
   *
   * Publishes only a real change: the startup backfill rewrites every thread,
   * and a sidebar refetching for values it already holds is pure noise.
   */
  const recordTiming = (threadId: string, timing: TurnTiming): void => {
    const before = readOne(threadId);
    if (
      before !== undefined &&
      before.startedWorkingAt === timing.startedWorkingAt &&
      before.lastRunEndedAt === timing.lastRunEndedAt
    ) {
      return;
    }
    if (
      before === undefined &&
      timing.startedWorkingAt === null &&
      timing.lastRunEndedAt === null
    ) {
      return;
    }
    db.prepare(
      `INSERT INTO thread_lifecycle
         (thread_id, started_working_at, last_run_ended_at)
         VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         started_working_at = excluded.started_working_at,
         last_run_ended_at = excluded.last_run_ended_at`,
    ).run(threadId, timing.startedWorkingAt, timing.lastRunEndedAt);
    deleteIfEmpty(threadId);
    publishRow(threadId);
  };

  /**
   * The newest read per thread. A read writes only while it is still the
   * newest for its thread, so a slow read — a start waiting for its log row
   * while the turn already ended — can never overwrite the answer to a later
   * event. Tokens come from one counter that never repeats, so an entry
   * dropped when its read finished cannot be mistaken for a later one.
   */
  const timingGeneration = new Map<string, number>();
  let timingTokens = 0;

  const refreshTiming = async (
    threadId: string,
    read: (log: TurnEventLog) => Promise<TurnTiming>,
    context: string,
  ): Promise<void> => {
    timingTokens += 1;
    const generation = timingTokens;
    timingGeneration.set(threadId, generation);
    try {
      const timing = await read(bb.sdk.threads.events);
      if (timingGeneration.get(threadId) !== generation) return;
      recordTiming(threadId, timing);
    } catch (error) {
      // The cached value stays. It is the last one the log confirmed, and the
      // next event or startup backfill reads again.
      bb.log.warn(
        `turn timing: could not read the event log of ${threadId} on ${context} (${String(error)})`,
      );
    } finally {
      if (timingGeneration.get(threadId) === generation) {
        timingGeneration.delete(threadId);
      }
    }
  };

  /**
   * Re-read every live thread's timing from the log.
   *
   * Every thread, not only the ones missing a value: a thread that ran while
   * the plugin was not listening has a cached end that is simply old, and only
   * the log can say so. Archived threads are skipped — they have no card.
   */
  const backfillTiming = async (): Promise<void> => {
    const threads: Array<{ id: string; status: string }> = [];
    for (let offset = 0; ; offset += BACKFILL_PAGE_SIZE) {
      const page = await bb.sdk.threads.list({
        archived: false,
        includeHidden: true,
        limit: BACKFILL_PAGE_SIZE,
        offset,
      });
      threads.push(...page);
      if (page.length < BACKFILL_PAGE_SIZE) break;
    }
    await forEachLimited(threads, BACKFILL_CONCURRENCY, (thread) =>
      refreshTiming(
        thread.id,
        (log) => readTurnTiming(log, thread.id, isRunningStatus(thread.status)),
        "startup",
      ),
    );
    bb.log.info(`turn timing: read ${threads.length} threads from the event log`);
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
      // Read together, synchronously: no change can land between the rows and
      // the counter they are current as of.
      return { epoch, seq, rows: readAll() };
    },
    async settle({ threadId }) {
      // Settling clears any snooze: they are two answers to the same
      // question, and holding both would make the shelf order ambiguous.
      writeParking(threadId, {
        settledAt: Date.now(),
        snoozedUntil: null,
        snoozedAt: null,
      });
      // After the write, never before: the shelf is the user's decision and
      // it stands even if every part of the cleanup fails. Not awaited — the
      // outcome is published when it is known.
      void reapQuietly(threadId, "settle").then((reaped) => {
        if (!reaped.enabled) return;
        const message: LifecycleReapedMessage = { kind: "reaped", threadId, reaped };
        bb.realtime.publish(LIFECYCLE_CHANNEL, message);
      });
      return { ok: true };
    },
    async unsettle({ threadId }) {
      writeParking(threadId, { settledAt: null, snoozedUntil: null, snoozedAt: null });
      return { ok: true };
    },
    async snooze({ threadId, snoozedUntil }) {
      writeParking(threadId, {
        settledAt: null,
        snoozedUntil,
        snoozedAt: Date.now(),
      });
      return { ok: true };
    },
    async unsnooze({ threadId }) {
      writeParking(threadId, { settledAt: null, snoozedUntil: null, snoozedAt: null });
      return { ok: true };
    },
    async autoArchiveStatus() {
      const values = await settings.get();
      const intervalHours = parseAutoArchiveIntervalHours(
        values.autoArchiveIntervalHours,
      );
      const lastRunAt = readLastSweepAt();
      const now = Date.now();
      return {
        enabled: values.autoArchiveEnabled === true,
        intervalHours,
        days: parseAutoArchiveDays(values.autoArchiveDays),
        lastRunAt,
        nextRunAt: nextAutoArchiveRunAt(now, lastRunAt, intervalHours),
        now,
      };
    },
    async runAutoArchive() {
      // Every row the sweep changes publishes itself as it goes.
      return runAutoArchiveSweep();
    },
    async getSettings() {
      const values = await settings.get();
      const window = parseCacheWindow(
        values.cacheWarnAfterMinutes,
        values.cacheColdAfterMinutes,
      );
      return {
        cacheWarnAfterMinutes: window.warnAfterMinutes,
        cacheColdAfterMinutes: window.coldAfterMinutes,
      };
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

  // An archived thread has no card and no shelf, and a parking row left
  // behind would park it again the moment it came back. This covers the
  // user's own archives and cascades, not only the sweep's.
  bb.events.on("thread.archived", ({ thread }) => {
    clear(thread.id);
  });
  // Back from the archive, it needs its idle age again — read from the log,
  // which kept every turn while the store forgot it.
  bb.events.on("thread.unarchived", ({ thread }) =>
    refreshTiming(
      thread.id,
      (log) => readTurnTiming(log, thread.id, isRunningStatus(thread.status)),
      "thread.unarchived",
    ),
  );

  // bb reports the transitions; the times come from its event log, so every
  // client and every reload measures the same turn from the same instant.
  bb.events.on("thread.active", ({ thread }) =>
    refreshTiming(
      thread.id,
      (log) => readStartedTiming(log, thread.id),
      "thread.active",
    ),
  );
  bb.events.on("thread.idle", ({ thread }) =>
    refreshTiming(
      thread.id,
      (log) => readStoppedTiming(log, thread.id),
      "thread.idle",
    ),
  );
  // A failed turn has ended too, and bb records its end the same way.
  bb.events.on("thread.failed", ({ thread }) =>
    refreshTiming(
      thread.id,
      (log) => readStoppedTiming(log, thread.id),
      "thread.failed",
    ),
  );

  // Deferred off the factory, like the avatar sweep: `bb.sdk` is only bound
  // once the server is listening, and a plugin that blocks its own load on a
  // read per thread delays every plugin behind it.
  const initialBackfill = setTimeout(() => {
    void backfillTiming().catch((error: unknown) => {
      bb.log.warn(`turn timing: startup backfill failed (${String(error)})`);
    });
  }, BACKFILL_DELAY_MS);
  initialBackfill.unref?.();
  bb.onDispose(() => clearTimeout(initialBackfill));

  const writeState = (key: string, value: string): void => {
    db.prepare(
      `INSERT INTO plugin_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  };

  /**
   * When the sweep last ran, or null if it never has.
   *
   * An unparseable stamp is read as "never" rather than thrown on: the only
   * cost of sweeping once too often is a few reads, and a database this code
   * cannot understand must not stop the sweep forever.
   */
  const readLastSweepAt = (): number | null => {
    const row = db
      .prepare(`SELECT value FROM plugin_state WHERE key = ?`)
      .get(LAST_SWEEP_KEY) as { value: string } | undefined;
    if (row === undefined) return null;
    const parsed = Number(row.value);
    return Number.isFinite(parsed) ? parsed : null;
  };

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
   * The unarchived children bb still knows about for one thread.
   *
   * Hidden threads are included on purpose: a hidden child is still a live
   * row that archiving its parent would release, and a released hidden thread
   * is the one the user has no way to find again.
   */
  const listChildIds = async (parentThreadId: string): Promise<string[]> => {
    const children = await bb.sdk.threads.list({
      parentThreadId,
      archived: false,
      includeHidden: true,
    });
    return children.map((child) => child.id);
  };

  /**
   * Whether any of this thread's own children is working.
   *
   * The sidebar folds child work into the parent's card, and the sweep has to
   * agree with it or it would archive a thread the sidebar is showing as busy.
   * Direct children only, like the sidebar: a grandchild's work already keeps
   * its own parent alive, and that parent is a child of this one.
   *
   * An unreadable list counts as working — when in doubt this sweep leaves the
   * thread alone.
   */
  const isAnyChildWorking = async (parentThreadId: string): Promise<boolean> => {
    try {
      const children = await bb.sdk.threads.list({
        parentThreadId,
        archived: false,
        includeHidden: true,
      });
      return children.some(isThreadWorking);
    } catch (error) {
      bb.log.warn(
        `auto-archive: could not read the children of ${parentThreadId}, leaving it alone (${String(error)})`,
      );
      return true;
    }
  };

  const hostClient = bb.hosts.experimental_client({ contract: hostContract });

  /** One worktree a subtree touches, and the machine that holds it. */
  interface ReapTarget {
    environmentId: string;
    hostId: string;
    path: string;
  }

  /**
   * Whether a thread outside the settled subtree is mid-turn in this
   * environment. Its processes are indistinguishable from the settled
   * thread's, and killing them under a running agent breaks work the user has
   * not finished with. An unreadable list counts as in use.
   */
  const isEnvironmentInUse = async (
    environmentId: string,
    subtree: ReadonlySet<string>,
  ): Promise<boolean> => {
    try {
      const threads = await bb.sdk.threads.list({
        environmentId,
        archived: false,
        includeHidden: true,
      });
      return threads.some(
        (thread) => !subtree.has(thread.id) && isThreadWorking(thread),
      );
    } catch (error) {
      bb.log.warn(
        `reap: could not list the threads of ${environmentId}, leaving it alone (${String(error)})`,
      );
      return true;
    }
  };

  /**
   * Stop everything a finished thread left running, itself and its children.
   *
   * Two handles, because they reach different processes. bb still owns the
   * terminals, so those are closed through it — that is the orderly path and
   * it takes the foreground process group with it. What it cannot reach is a
   * process that already escaped its shell: an agent's dev server detaches, is
   * reparented to init, and afterwards belongs to no terminal and no thread.
   * The worktree path is the only handle such a process still carries, so the
   * second pass sweeps that — through the host entry on the machine holding
   * the worktree, which is the only place its processes can be seen.
   *
   * Order matters. Terminals close first so their own children die with them,
   * and the worktree pass then only sees what genuinely outlived its session.
   *
   * Only worktrees are swept. A project checkout is where the user works too —
   * their shells, their editor, their own dev server — and nothing running
   * there can be told apart from what an agent left behind.
   *
   * Best-effort throughout. A terminal that will not close, a machine that
   * cannot be reached or a process that will not die is reported and skipped.
   */
  const reapThreadSubtree = async (
    rootThreadId: string,
  ): Promise<ReapSummary> => {
    const values = await settings.get();
    if (values.reapOnSettle !== true) return emptyReapSummary(false);

    let subtree: string[];
    try {
      subtree = await collectSubtreeDeepestFirst(rootThreadId, listChildIds);
    } catch (error) {
      // Unlike the archive, which leaves an unreadable subtree entirely alone,
      // a reap falls back to the one thread it was asked about. Archiving half
      // a subtree releases the rest as orphan roots; reaping half of one just
      // leaves the other half running, which is the state it was already in.
      bb.log.warn(
        `reap: could not read the children of ${rootThreadId}, reaping it alone (${String(error)})`,
      );
      subtree = [rootThreadId];
    }

    const summary = emptyReapSummary(true);
    // Settle returns before the reap runs, so the user can take it back while
    // this is still working. Every destructive step asks first: an undone
    // settle stops the reap where it stands.
    const stillSettled = () => (readOne(rootThreadId)?.settledAt ?? null) !== null;
    // One entry per environment, so a subtree sharing one worktree — the
    // usual case — sweeps it once.
    const targets = new Map<string, ReapTarget>();

    for (const threadId of subtree) {
      if (!stillSettled()) return summary;
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        const environmentId = thread.environmentId ?? null;
        if (environmentId !== null && !targets.has(environmentId)) {
          const environment = await bb.sdk.environments.get({ environmentId });
          const path = environment.path?.trim() ?? "";
          if (environment.isWorktree && path !== "") {
            targets.set(environmentId, {
              environmentId,
              hostId: environment.hostId,
              path,
            });
          }
        }
      } catch (error) {
        bb.log.warn(
          `reap: could not read the environment of ${threadId} (${String(error)})`,
        );
      }

      try {
        const { sessions } = await bb.sdk.terminals.list({
          scope: { kind: "thread", threadId },
        });
        for (const session of sessions) {
          // An already-exited session has nothing to close, and reporting it
          // as closed would credit this reap with a death it did not cause.
          if (session.status === "exited") continue;
          try {
            await bb.sdk.terminals.close({
              terminalId: session.id,
              // The thread is finished, so there is no unsaved work to protect
              // and "if-clean" would leave exactly the busy dev server this
              // whole feature exists to stop.
              mode: "force",
            });
            summary.terminalsClosed.push({
              terminalId: session.id,
              title: session.title,
            });
          } catch (error) {
            bb.log.warn(
              `reap: closing terminal ${session.id} failed (${String(error)})`,
            );
            summary.terminalsFailed += 1;
          }
        }
      } catch (error) {
        bb.log.warn(
          `reap: could not list the terminals of ${threadId} (${String(error)})`,
        );
        summary.terminalsFailed += 1;
      }
    }

    const subtreeIds = new Set(subtree);
    for (const target of targets.values()) {
      if (!stillSettled()) return summary;
      if (await isEnvironmentInUse(target.environmentId, subtreeIds)) {
        summary.worktreesSkipped.push({ path: target.path, reason: "in-use" });
        continue;
      }
      try {
        const report = await hostClient.call(
          "reapDirectory",
          { directory: target.path },
          // The kill gives each process a grace period and re-checks for
          // stragglers; the default 30s is too tight for a busy worktree.
          { hostId: target.hostId, timeoutMs: REAP_HOST_TIMEOUT_MS },
        );
        if (report.refused !== null) {
          bb.log.warn(`reap: host refused ${target.path} (${report.refused})`);
        }
        summary.processesKilled.push(...report.killed);
        summary.processesFailed += report.failed;
      } catch (error) {
        // No deferred retry: by the time the machine is back, the worktree
        // may hold new work, and a kill queued now would land on it.
        bb.log.warn(
          `reap: could not reach host ${target.hostId} for ${target.path}, nothing stopped (${String(error)})`,
        );
        summary.worktreesSkipped.push({
          path: target.path,
          reason: "unreachable",
        });
      }
    }

    if (
      summary.processesKilled.length > 0 ||
      summary.terminalsClosed.length > 0 ||
      summary.worktreesSkipped.length > 0
    ) {
      bb.log.info(
        `reap: ${rootThreadId} — closed ${summary.terminalsClosed.length} terminals, killed ${summary.processesKilled.length} processes across ${targets.size} worktrees, skipped ${summary.worktreesSkipped.length}`,
      );
    }
    return summary;
  };

  /**
   * A reap that can never be the reason its caller failed.
   *
   * Both callers — the settle and the sweep — have already made their decision
   * by the time they reach here, and neither may be undone by housekeeping.
   */
  const reapQuietly = async (
    threadId: string,
    context: string,
  ): Promise<ReapSummary> => {
    try {
      return await reapThreadSubtree(threadId);
    } catch (error) {
      bb.log.warn(`${context}: reaping ${threadId} failed (${String(error)})`);
      return emptyReapSummary(true);
    }
  };

  /**
   * The periodic sweep: settled threads the user has not come back to
   * eventually leave the sidebar for the archive.
   *
   * Settling is a judgement the user already made, and the shelf keeps it
   * reversible until this point. The sweep only finishes that decision — it
   * never makes one, which is why anything still alive is skipped rather than
   * archived, and why the row is only cleared once the archive succeeded.
   */
  /**
   * One sweep, shared by the schedule and the Settings button.
   *
   * It returns its tally instead of only logging it, because the manual run
   * has a user waiting on an answer: "archived nothing" is the ordinary
   * outcome here, and without the counts it is indistinguishable from a sweep
   * that is quietly broken.
   *
   * The manual path deliberately gets no override of its own. The switch and
   * the retention period are the user's standing decision, and a button that
   * ignored them would archive threads the settings promise are safe.
   */
  const runAutoArchiveSweep = async (): Promise<AutoArchiveSweepResult> => {
    // Read fresh rather than closing over a load-time snapshot: the user can
    // turn this off between two runs of the schedule.
    const values = await settings.get();
    const days = parseAutoArchiveDays(values.autoArchiveDays);
    if (!values.autoArchiveEnabled) {
      return {
        enabled: false,
        days,
        candidates: 0,
        archived: [],
        skipped: 0,
        unsettled: 0,
        forgotten: 0,
        failed: 0,
        reaped: emptyReapSummary(false),
      };
    }

    const now = Date.now();
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

    const archived: ArchivedThread[] = [];
    let reaped = emptyReapSummary(false);
    let skipped = 0;
    let unsettled = 0;
    let forgotten = 0;
    let failed = 0;
    // Only for the log line: the report names the settled threads the user
    // parked, and a subagent that came along for the ride was never one of
    // them.
    let descendants = 0;

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
        thread = await bb.sdk.threads.get({ threadId });
      } catch {
        // Gone from bb, so the row describes nothing. Dropping it also stops
        // this sweep from retrying the same dead id on every pass.
        clear(threadId);
        forgotten += 1;
        continue;
      }
      if (thread === null || thread === undefined) {
        clear(threadId);
        forgotten += 1;
        continue;
      }

      // Work on a child counts as work on the parent, exactly as the sidebar
      // reads it: a thread whose subagents are running looks idle in its own
      // DTO, and archiving it would take the running children with it.
      const isWorking =
        isThreadWorking(thread) || (await isAnyChildWorking(threadId));
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
        // itself out of again on every pass. The idle age stays.
        writeParking(threadId, { settledAt: null, snoozedUntil: null, snoozedAt: null });
        unsettled += 1;
        continue;
      }

      // Leaves first, so no descendant is ever left behind as a released
      // root. A subtree that cannot be read is left entirely alone: archiving
      // the top of it is exactly the half-measure this loop is fixing.
      let subtree: string[];
      try {
        subtree = await collectSubtreeDeepestFirst(threadId, listChildIds);
      } catch (error) {
        bb.log.warn(
          `auto-archive: could not read the children of ${threadId}, leaving it alone (${String(error)})`,
        );
        failed += 1;
        continue;
      }

      // Before the archive, not after: once a thread is archived bb no longer
      // lists it as a child, and the walk this reap needs would come back
      // short.
      reaped = mergeReapSummaries(
        reaped,
        await reapQuietly(threadId, "auto-archive"),
      );

      let archiveFailed = false;
      for (const subtreeId of subtree) {
        try {
          await bb.sdk.threads.archive({ threadId: subtreeId });
        } catch (error) {
          // Keep the row: the thread is still on the shelf, and the next
          // sweep gets another chance at whatever is left.
          bb.log.warn(
            `auto-archive: archiving ${subtreeId} failed (${String(error)})`,
          );
          archiveFailed = true;
          break;
        }
        // The lifecycle row exists to place a thread on a shelf. Archived, it
        // has no shelf, and a leftover row would park it again if unarchived.
        // Descendants can carry rows of their own, so they are cleared too.
        clear(subtreeId);
      }
      if (archiveFailed) {
        failed += 1;
        continue;
      }
      descendants += subtree.length - 1;
      archived.push({ threadId, title: sweepThreadTitle(thread) });
    }

    // Stamped after the work, not before: a sweep that threw partway is not a
    // sweep that happened, and the next tick should retry rather than wait
    // out the whole interval.
    writeState(LAST_SWEEP_KEY, String(now));

    bb.log.info(
      `auto-archive: ${candidates.length} settled over ${days}d — archived ${archived.length} (plus ${descendants} descendants), skipped ${skipped} still live, un-settled ${unsettled} back in the inbox, cleared ${forgotten} missing, failed ${failed}, reaped ${reaped.terminalsClosed.length} terminals and ${reaped.processesKilled.length} processes`,
    );
    return {
      enabled: true,
      days,
      candidates: candidates.length,
      archived,
      skipped,
      unsettled,
      forgotten,
      failed,
      reaped,
    };
  };

  bb.background.schedule("auto-archive", AUTO_ARCHIVE_CRON, async () => {
    // The ticker runs hourly; the setting decides which ticks do work. See
    // AUTO_ARCHIVE_CRON for why the interval cannot live in the cron itself.
    const values = await settings.get();
    const hours = parseAutoArchiveIntervalHours(values.autoArchiveIntervalHours);
    const lastRunAt = readLastSweepAt();
    // No stamp means this plugin has never swept — a fresh install, or a
    // database from before this setting existed. Sweep now and start the
    // clock, rather than waiting an interval for the first one.
    if (lastRunAt !== null && Date.now() - lastRunAt < hours * HOUR_MS) return;
    await runAutoArchiveSweep();
  });

}