/**
 * Killing what a finished thread left running, as pure functions over a
 * process table plus one thin effectful shell.
 *
 * This module knows nothing about shelves, settling or bb threads: it is handed
 * a worktree path and reports what it killed. That is what lets every rule here
 * be tested from a plain list of rows, with nothing spawned.
 *
 * bb can only close terminals it still owns. A dev server launched from an
 * agent's shell detaches, is reparented to init, and afterwards belongs to no
 * terminal and no thread — the worktree it was started in is the last handle it
 * carries, so that is what these rules match on.
 */

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
  /**
   * Null when the system would not say. Reading a working directory needs
   * privileges the process table does not, so this is missing far more often
   * than it is wrong, and {@link selectWorktreeProcesses} has to cope.
   */
  cwd: string | null;
}

export interface ReapedProcess {
  pid: number;
  command: string;
}

export interface ReapReport {
  killed: ReapedProcess[];
  /** Selected but still alive after the kill, or unknowable — never claimed. */
  failed: number;
}

const COMMAND_SUMMARY_LENGTH = 120;

/** Long enough to recognize a process by, short enough for a log line. */
export function summarizeCommand(command: string): string {
  const collapsed = command.trim().replace(/\s+/g, " ");
  return collapsed.length <= COMMAND_SUMMARY_LENGTH
    ? collapsed
    : `${collapsed.slice(0, COMMAND_SUMMARY_LENGTH - 1)}…`;
}

/**
 * Whether a path is the worktree — under any of the names this machine knows
 * it by — or something inside it.
 *
 * More than one root, because a worktree reached through a symlink has two
 * true paths and the system does not agree with itself about which to use. bb
 * records `/tmp/x`; the kernel reports a process's working directory as
 * `/private/tmp/x`. Matching one name only would spare every process in a
 * symlinked worktree, which on macOS is every worktree under /tmp.
 *
 * The boundary check is the other half. Plain prefix matching makes
 * `/w/app-old` a child of `/w/app`, and the two are different worktrees whose
 * processes must never be reaped together.
 */
export function isInsideWorktree(
  path: string,
  worktreePaths: readonly string[],
): boolean {
  if (path === "") return false;
  return worktreePaths.some((worktreePath) => {
    if (worktreePath === "") return false;
    const root = worktreePath.endsWith("/")
      ? worktreePath.slice(0, -1)
      : worktreePath;
    return path === root || path.startsWith(`${root}/`);
  });
}

/**
 * Parse `ps -Ao pid=,ppid=,args=`.
 *
 * Only the first two fields are split on whitespace: everything after them is
 * the command line, and most command lines contain spaces.
 */
export function parseProcessTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({ pid, ppid, command: match[3], cwd: null });
  }
  return rows;
}

/**
 * Parse `lsof -a -d cwd -F pn` into pid → working directory.
 *
 * lsof's field format emits one record per line, tagged by its first
 * character: `p` opens a process, `n` names the file. A `n` before any `p`
 * belongs to nothing and is dropped rather than guessed at.
 */
export function parseWorkingDirectories(stdout: string): Map<number, string> {
  const byPid = new Map<number, string>();
  let pid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number(line.slice(1));
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } else if (line.startsWith("n") && pid !== null) {
      byPid.set(pid, line.slice(1));
    }
  }
  return byPid;
}

/**
 * A row keeps its null when the directory pass had nothing for it, so
 * "unreadable" stays distinguishable from "read, and outside the worktree".
 */
export function withWorkingDirectories(
  rows: ProcessRow[],
  byPid: Map<number, string>,
): ProcessRow[] {
  return rows.map((row) => ({ ...row, cwd: byPid.get(row.pid) ?? null }));
}

export interface SelectArgs {
  rows: ProcessRow[];
  /** Every name this machine knows the one worktree by; see isInsideWorktree. */
  worktreePaths: readonly string[];
  /** This process and its parent, so a reap can never kill the reaper. */
  selfPids: ReadonlySet<number>;
}

/**
 * Which processes belong to a worktree.
 *
 * The working directory is the honest answer and is used whenever the system
 * gave one: it is what "running in this worktree" actually means, and it does
 * not care what the command line happens to mention.
 *
 * Argv is the fallback for a process whose directory could not be read, and it
 * is deliberately kept: a detached dev server runs out of `node_modules` inside
 * the worktree and so carries the absolute path in argv, which is the one case
 * this whole feature exists for. Both tests go through
 * {@link isInsideWorktree}, so neither can be fooled by a sibling worktree
 * whose path merely starts the same way.
 *
 * Descendants of the reaper are spared along with it — walking up rather than
 * checking each pid alone, because it is a process's ancestry that makes it
 * unsafe to kill, not its own pid.
 */
export function selectWorktreeProcesses({
  rows,
  worktreePaths,
  selfPids,
}: SelectArgs): ProcessRow[] {
  const roots = worktreePaths.filter((path) => path.trim() !== "");
  if (roots.length === 0) return [];

  const byPid = new Map(rows.map((row) => [row.pid, row]));

  const descendsFromSelf = (row: ProcessRow): boolean => {
    let current: ProcessRow | undefined = row;
    // Bounded: a corrupt table with a parent cycle must cost a fixed number of
    // steps rather than hang the settle that called this.
    for (let depth = 0; current !== undefined && depth < 64; depth += 1) {
      if (selfPids.has(current.pid)) return true;
      current = byPid.get(current.ppid);
    }
    return false;
  };

  return rows.filter((row) => {
    if (descendsFromSelf(row)) return false;
    if (row.cwd !== null) return isInsideWorktree(row.cwd, roots);
    return row.command
      .split(/\s+/)
      .some((argument) => isInsideWorktree(argument, roots));
  });
}

export interface ReapDeps {
  readProcessTable: () => Promise<string>;
  /**
   * Working directories, or null when they cannot be had at all. Separate from
   * the table because it is the pass most likely to be unavailable, and the
   * selection still has an answer without it.
   */
  readWorkingDirectories: () => Promise<string | null>;
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => Promise<void>;
  isAlive: (pid: number) => Promise<boolean>;
  wait: (ms: number) => Promise<void>;
  log: { warn: (message: string) => void };
}

/** Long enough for a dev server to close its sockets, short enough to settle. */
export const TERM_GRACE_MS = 2000;

/**
 * Kill a worktree's leftovers, politely first.
 *
 * SIGTERM lets a dev server release its port and clean up; SIGKILL is only for
 * one that ignores it. Every failure is reported and skipped rather than
 * thrown: this runs inside a user's settle, and a process that will not die
 * must never make the settle itself fail.
 */
export async function reapWorktree(
  args: Omit<SelectArgs, "rows">,
  deps: ReapDeps,
): Promise<ReapReport> {
  let rows: ProcessRow[];
  try {
    rows = parseProcessTable(await deps.readProcessTable());
  } catch (error) {
    deps.log.warn(`reap: could not read the process table (${String(error)})`);
    return { killed: [], failed: 0 };
  }

  try {
    const stdout = await deps.readWorkingDirectories();
    if (stdout !== null) {
      rows = withWorkingDirectories(rows, parseWorkingDirectories(stdout));
    }
  } catch (error) {
    // Not fatal: selection falls back to argv, which is narrower but honest.
    deps.log.warn(
      `reap: could not read working directories, matching on the command line instead (${String(error)})`,
    );
  }

  const targets = selectWorktreeProcesses({ ...args, rows });
  if (targets.length === 0) return { killed: [], failed: 0 };

  for (const target of targets) {
    try {
      await deps.kill(target.pid, "SIGTERM");
    } catch (error) {
      deps.log.warn(`reap: SIGTERM to ${target.pid} failed (${String(error)})`);
    }
  }

  await deps.wait(TERM_GRACE_MS);

  const killed: ReapedProcess[] = [];
  let failed = 0;
  for (const target of targets) {
    let alive: boolean;
    try {
      alive = await deps.isAlive(target.pid);
    } catch {
      // Reporting a kill that may not have happened is worse than doubt.
      failed += 1;
      continue;
    }
    if (alive) {
      try {
        await deps.kill(target.pid, "SIGKILL");
      } catch (error) {
        deps.log.warn(
          `reap: SIGKILL to ${target.pid} failed (${String(error)})`,
        );
        failed += 1;
        continue;
      }
      if (await deps.isAlive(target.pid).catch(() => true)) {
        failed += 1;
        continue;
      }
    }
    killed.push({ pid: target.pid, command: summarizeCommand(target.command) });
  }

  return { killed, failed };
}
