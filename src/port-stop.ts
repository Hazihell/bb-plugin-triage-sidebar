/**
 * Stop the process behind one of a directory's listening ports, on the
 * machine holding the directory.
 *
 * The sidebar names a pid, but a pid is only what the port card showed some
 * seconds ago: the server may have exited and the number been reused. So
 * nothing is killed on the pid alone. The host scans again, by the same rules
 * as the port card, and signals only when that pid is still listening on that
 * port with its working directory under that directory. Anything else is
 * "changed", and the card refreshes instead.
 */
import { refuseDirectory } from "./reap";
import {
  attributeToDirectory,
  isShownListener,
  parseListeners,
  type PortScanDeps,
} from "./ports";
import type { PortStopReport } from "./host-contract";

/** How long a process gets to exit on SIGTERM before SIGKILL. */
export const STOP_GRACE_MS = 3_000;
/** How long SIGKILL gets before the stop is reported as failed. */
export const STOP_KILL_WAIT_MS = 1_000;
const STOP_POLL_MS = 100;

export interface PortStopDeps
  extends Pick<PortScanDeps, "home" | "readListeners" | "readCwds" | "realpath" | "log"> {
  /** Deliver a signal; throws an errno error (ESRCH, EPERM) as `process.kill` does. */
  signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  isAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  /** The plugin's own process and whatever started it: never signalled. */
  protectedPids: readonly number[];
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

async function waitForExit(pid: number, ms: number, deps: PortStopDeps): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += STOP_POLL_MS) {
    if (!deps.isAlive(pid)) return true;
    await deps.sleep(STOP_POLL_MS);
  }
  return !deps.isAlive(pid);
}

export async function stopPort(
  input: { directory: string; port: number; pid: number },
  deps: PortStopDeps,
): Promise<PortStopReport> {
  const { directory, port, pid } = input;
  const refused = refuseDirectory(directory, deps.home);
  if (refused !== null) return { result: "refused", message: `Refused: ${refused}` };
  if (!Number.isInteger(pid) || pid <= 1 || deps.protectedPids.includes(pid)) {
    return { result: "refused", message: "Refused: that process is bb's own" };
  }

  let root: string;
  try {
    root = deps.realpath(directory);
  } catch {
    // The directory is gone, so nothing can be working in it any more.
    return { result: "changed", message: null };
  }

  let cwd: string | undefined;
  try {
    const listening = parseListeners(await deps.readListeners()).some(
      (listener) =>
        listener.pid === pid && listener.port === port && isShownListener(listener),
    );
    if (!listening) {
      return deps.isAlive(pid)
        ? { result: "changed", message: null }
        : { result: "already-gone", message: null };
    }
    cwd = (await deps.readCwds([pid])).get(pid);
  } catch (error) {
    deps.log.warn(`ports: could not re-scan before stopping ${pid} (${String(error)})`);
    return { result: "failed", message: "Could not check the port" };
  }
  if (cwd === undefined) {
    return deps.isAlive(pid)
      ? { result: "changed", message: null }
      : { result: "already-gone", message: null };
  }
  if (attributeToDirectory(cwd, [root]) === null) return { result: "changed", message: null };

  try {
    deps.signal(pid, "SIGTERM");
  } catch (error) {
    if (errnoCode(error) === "ESRCH") return { result: "already-gone", message: null };
    return { result: "failed", message: "Not permitted to stop that process" };
  }
  if (await waitForExit(pid, STOP_GRACE_MS, deps)) return { result: "killed", message: null };

  try {
    deps.signal(pid, "SIGKILL");
  } catch (error) {
    if (errnoCode(error) === "ESRCH") return { result: "killed", message: null };
    return { result: "failed", message: "Not permitted to stop that process" };
  }
  if (await waitForExit(pid, STOP_KILL_WAIT_MS, deps)) return { result: "killed", message: null };
  return { result: "failed", message: "The process did not exit" };
}
