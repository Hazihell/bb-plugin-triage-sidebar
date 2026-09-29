/**
 * Which TCP ports each thread directory is serving, as pure functions plus one
 * effectful routine that the host entry runs on the directories' own machine.
 *
 * A listening socket carries no worktree. What it does carry is a pid, and a
 * pid has a working directory: a dev server started in a worktree works in
 * that worktree, so the directory is the handle — the same one the reap uses
 * to find what a thread left running. One `lsof` pass lists every listener on
 * the machine, one more resolves their working directories, and each is
 * credited to the deepest directory it sits under, so a worktree nested
 * inside a project checkout keeps its own ports.
 *
 * One `ps` call then names the process behind each port credited to a
 * directory, so a user can tell the app from the storybook before opening it.
 *
 * Modelled on bb-plugin-worktree-ports' host scan, cut down to what the
 * sidebar's port card shows, in the order a user would open them.
 */
import { basename, sep } from "node:path";
import { refuseDirectory } from "./reap";
import {
  MAX_PORT_COMMAND_LENGTH,
  type ListeningPort,
  type PortListing,
} from "./host-contract";

/** One listening socket, as `lsof` reported it. */
export interface Listener {
  pid: number;
  processName: string;
  address: string;
  port: number;
}

/** The most ports one directory reports; the card counts the rest. */
export const MAX_PORTS_PER_DIRECTORY = 8;

/**
 * Split an lsof NAME — `*:3000`, `127.0.0.1:5173`, `[::1]:8080` — into address
 * and port. The port is after the LAST colon, since IPv6 addresses have many.
 */
export function parseAddressPort(
  name: string,
): { address: string; port: number } | null {
  const colon = name.lastIndexOf(":");
  if (colon <= 0) return null;
  const port = Number(name.slice(colon + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const address = name.slice(0, colon).replace(/^\[|\]$/g, "");
  return { address, port };
}

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN`.
 *
 * Columns are whitespace-split: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE
 * NAME (LISTEN). COMMAND has no spaces in lsof's default output — it escapes
 * them — so the pid is always the second column and the address the one
 * before the trailing state.
 */
export function parseListeners(output: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of output.split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 9 || columns[0] === "COMMAND") continue;
    const pid = Number(columns[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const last = columns[columns.length - 1] ?? "";
    const name = last.startsWith("(") ? columns[columns.length - 2] : last;
    const parsed = parseAddressPort(name ?? "");
    if (parsed === null) continue;
    listeners.push({ pid, processName: columns[0] ?? "", ...parsed });
  }
  return listeners;
}

/** Field-mode `lsof -a -p <pids> -d cwd -Fn`: `p<pid>`, `fcwd`, `n<path>`. */
export function parseCwds(output: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number(line.slice(1));
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } else if (line.startsWith("n") && pid !== null && !cwds.has(pid)) {
      cwds.set(pid, line.slice(1));
    }
  }
  return cwds;
}

/** `ps -o pid=,args= -p <pids>`: the pid, then the whole command line. */
export function parseCommands(output: string): Map<number, string> {
  const commands = new Map<number, string>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (match === null) continue;
    commands.set(Number(match[1]), match[2]!);
  }
  return commands;
}

/** `NODE_ENV=dev`, as `env` or a wrapper script leaves it in argv. */
const ENV_ASSIGNMENT = /^[A-Z_][A-Z0-9_]*=/;

/**
 * A command line as one short line: `node · vite --port 3000`.
 *
 * The program and every absolute path are cut to their last segment — the
 * checkout's location is already the row's, and says nothing about which
 * server this is. Environment assignments are dropped, since they are where
 * a secret would be. Bounded, with an ellipsis where it was cut.
 */
export function summarizeCommand(args: string): string {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "" && !ENV_ASSIGNMENT.test(token))
    .map((token) => (token.startsWith("/") ? basename(token) || token : token));
  if (tokens.length === 0) return "";
  const [program, ...rest] = tokens;
  const line = rest.length === 0 ? program! : `${program} · ${rest.join(" ")}`;
  return line.length <= MAX_PORT_COMMAND_LENGTH
    ? line
    : `${line.slice(0, MAX_PORT_COMMAND_LENGTH - 1)}…`;
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "") || sep;
}

/**
 * The deepest of `directories` that `path` is, or is under; null when none.
 *
 * Boundary-safe: `/w/app-old` is not under `/w/app`.
 */
export function attributeToDirectory(
  path: string,
  directories: readonly string[],
): string | null {
  const target = trimTrailingSeparators(path);
  let best: string | null = null;
  let bestLength = -1;
  for (const directory of directories) {
    const root = trimTrailingSeparators(directory);
    const inside =
      target === root || target.startsWith(root === sep ? root : `${root}${sep}`);
    if (inside && root.length > bestLength) {
      best = directory;
      bestLength = root.length;
    }
  }
  return best;
}

/**
 * Backing services, matched on the lsof COMMAND — in both its full form and
 * the nine characters lsof truncates it to by default. Their ports are real, but a
 * row that opens Postgres in a browser is a dead end, so they are dropped.
 */
const SERVICE_PROCESSES = new Set([
  "postgres",
  "postmaster",
  "redis-server",
  "redis-ser",
  "mongod",
  "mysqld",
  "mariadbd",
  "memcached",
  "com.docker.backend",
  "com.docke",
  "docker-proxy",
  "docker-pr",
  "vpnkit",
]);

/** The IANA dynamic range, where nothing chooses its own port. */
const EPHEMERAL_FROM = 49152;

/** The ports dev servers pick for themselves, which lead the row. */
const WEB_PORTS = new Set([
  3000, 3001, 3002, 4000, 4200, 4321, 5000, 5173, 5174, 5175, 6006, 8000,
  8080, 8081, 8888, 9000,
]);

function isLoopback(address: string): boolean {
  return address.startsWith("127.") || address === "::1" || address === "localhost";
}

/**
 * Whether a listener is worth a row at all: not a database or docker's
 * proxy, and not a loopback socket on an ephemeral port — an inspector or a
 * language server, which no one opens in a browser.
 */
export function isShownListener(listener: Listener): boolean {
  if (SERVICE_PROCESSES.has(listener.processName.toLowerCase())) return false;
  return !(isLoopback(listener.address) && listener.port >= EPHEMERAL_FROM);
}

/** The usual web ports first, then the rest, each group ascending. */
export function comparePorts(left: number, right: number): number {
  const rank = (port: number) => (WEB_PORTS.has(port) ? 0 : 1);
  return rank(left) - rank(right) || left - right;
}

export interface PortScanDeps {
  home: string;
  /** `lsof -nP -iTCP -sTCP:LISTEN` output. */
  readListeners: () => Promise<string>;
  /** The working directory of each pid still readable. */
  readCwds: (pids: number[]) => Promise<Map<number, string>>;
  /** Each pid's full command line, from one `ps` call. */
  readCommands: (pids: number[]) => Promise<Map<number, string>>;
  /** The directory with symlinks resolved, as a process would report it. */
  realpath: (directory: string) => string;
  log: { warn: (message: string) => void };
}

/**
 * One scan of this machine, credited to `directories`.
 *
 * The result has an entry for every directory asked about, empty when
 * nothing listens there, so a caller can tell "nothing" from "not asked".
 * A directory too wide to credit — the root, the home directory — gets
 * nothing: every process the user runs works somewhere under it. A port
 * whose process `ps` cannot name is still reported, with no command.
 */
export async function scanPorts(
  directories: readonly string[],
  deps: PortScanDeps,
): Promise<Record<string, PortListing>> {
  const result: Record<string, PortListing> = {};
  for (const directory of directories) result[directory] = { ports: [], more: 0 };

  // Processes report resolved paths; `/tmp/w` is `/private/tmp/w` on macOS.
  const resolvedToAsked = new Map<string, string>();
  for (const directory of directories) {
    if (refuseDirectory(directory, deps.home) !== null) continue;
    let resolved = directory;
    try {
      resolved = deps.realpath(directory);
    } catch {
      // Gone, or unreadable: nothing will be working in it either way.
      continue;
    }
    resolvedToAsked.set(resolved, directory);
  }
  if (resolvedToAsked.size === 0) return result;

  let listeners: Listener[];
  try {
    listeners = parseListeners(await deps.readListeners()).filter(isShownListener);
  } catch (error) {
    deps.log.warn(`ports: could not list listening sockets (${String(error)})`);
    return result;
  }
  if (listeners.length === 0) return result;

  let cwds: Map<number, string>;
  try {
    cwds = await deps.readCwds([...new Set(listeners.map((l) => l.pid))]);
  } catch (error) {
    deps.log.warn(`ports: could not read working directories (${String(error)})`);
    return result;
  }

  const roots = [...resolvedToAsked.keys()];
  // Port to pid, per directory; the first listener on a port owns it, which
  // folds a server's IPv4 and IPv6 sockets into one row.
  const found = new Map<string, Map<number, number>>();
  for (const listener of listeners) {
    const cwd = cwds.get(listener.pid);
    if (cwd === undefined) continue;
    const root = attributeToDirectory(cwd, roots);
    if (root === null) continue;
    const asked = resolvedToAsked.get(root)!;
    const ports = found.get(asked) ?? new Map<number, number>();
    if (!ports.has(listener.port)) ports.set(listener.port, listener.pid);
    found.set(asked, ports);
  }
  if (found.size === 0) return result;

  // Only the pids that made it onto a row, in one call.
  const pids = new Set<number>();
  for (const ports of found.values()) for (const pid of ports.values()) pids.add(pid);
  let commands = new Map<number, string>();
  try {
    commands = await deps.readCommands([...pids]);
  } catch (error) {
    deps.log.warn(`ports: could not read process commands (${String(error)})`);
  }

  for (const [directory, ports] of found) {
    const sorted = [...ports.keys()].sort(comparePorts);
    const shown: ListeningPort[] = sorted
      .slice(0, MAX_PORTS_PER_DIRECTORY)
      .map((port) => {
        const pid = ports.get(port)!;
        return { port, pid, command: summarizeCommand(commands.get(pid) ?? "") };
      });
    result[directory] = {
      ports: shown,
      more: Math.max(0, sorted.length - MAX_PORTS_PER_DIRECTORY),
    };
  }
  return result;
}
