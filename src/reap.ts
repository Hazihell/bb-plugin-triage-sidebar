/**
 * The rules for killing what a finished thread left running, as pure functions
 * plus one effectful routine that the host entry runs on the worktree's own
 * machine.
 *
 * This module knows nothing about shelves, settling or bb threads: it is handed
 * a directory and reports what it killed. That is what lets every rule here be
 * tested from plain values, with nothing spawned.
 *
 * bb can only close terminals it still owns. A dev server launched from an
 * agent's shell detaches, is reparented to init, and afterwards belongs to no
 * terminal and no thread — the worktree it was started in is the last handle
 * it carries, so that is what the kill matches on. Matching itself is bb's
 * `experimental_killProcessesWithCwdUnder`: working directory only, resolved
 * through a symlinked parent, and boundary-safe, so `/w/app-old` is never
 * inside `/w/app`.
 */
import { isAbsolute, normalize, sep } from "node:path";

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

export interface ReapedProcess {
  pid: number;
  command: string;
}

export interface DirectoryReapReport {
  killed: ReapedProcess[];
  /** Signalled but still alive afterwards — never claimed as killed. */
  failed: number;
  /** Why the directory was refused, or null when it was swept. */
  refused: string | null;
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
    rows.push({ pid, ppid, command: match[3] ?? "" });
  }
  return rows;
}

/**
 * Why a directory must not be swept, or null when it may be.
 *
 * The kill takes every process working anywhere under the directory, so the
 * one mistake it cannot survive is being handed too wide a one. The server
 * only ever sends a worktree's path; this is the host refusing to trust that
 * blindly. The filesystem root and the user's home — or anything above it —
 * would take the user's whole session with them.
 */
export function refuseDirectory(directory: string, home: string): string | null {
  if (!isAbsolute(directory)) return "not an absolute path";
  const normalized = normalize(directory).replace(/[\\/]+$/, "") || sep;
  if (normalized === sep) return "the filesystem root";
  const homeRoot = normalize(home).replace(/[\\/]+$/, "");
  if (homeRoot !== "" && (normalized === homeRoot || homeRoot.startsWith(`${normalized}${sep}`))) {
    return "the home directory or one above it";
  }
  return null;
}

export interface DirectoryReapDeps {
  home: string;
  exists: (directory: string) => boolean;
  /** `ps` output, read before the kill so each process can be named. */
  readProcessTable: () => Promise<string>;
  killUnder: (directory: string) => Promise<Array<{ pid: number }>>;
  isAlive: (pid: number) => boolean;
  log: { warn: (message: string) => void };
}

/**
 * Sweep one directory on this machine.
 *
 * The process table is read first and only to name what the kill stopped:
 * bb's helper reports pids, and a user told "pid 4812 stopped" cannot tell
 * which dev server went away. A table that cannot be read costs the names,
 * never the kill.
 */
export async function reapDirectory(
  directory: string,
  deps: DirectoryReapDeps,
): Promise<DirectoryReapReport> {
  const refused = refuseDirectory(directory, deps.home);
  if (refused !== null) return { killed: [], failed: 0, refused };
  // A worktree already removed has nothing left working in it.
  if (!deps.exists(directory)) return { killed: [], failed: 0, refused: null };

  let commands = new Map<number, string>();
  try {
    commands = new Map(
      parseProcessTable(await deps.readProcessTable()).map((row) => [
        row.pid,
        row.command,
      ]),
    );
  } catch (error) {
    deps.log.warn(`reap: could not read the process table (${String(error)})`);
  }

  const signalled = await deps.killUnder(directory);
  const killed: ReapedProcess[] = [];
  let failed = 0;
  for (const { pid } of signalled) {
    if (deps.isAlive(pid)) {
      failed += 1;
      continue;
    }
    killed.push({
      pid,
      command: summarizeCommand(commands.get(pid) ?? `pid ${pid}`),
    });
  }
  return { killed, failed, refused: null };
}
