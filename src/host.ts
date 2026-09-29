/**
 * The plugin's host entry: the part that runs on the machine holding a
 * worktree, where its processes actually are.
 *
 * The server used to run `ps` and `lsof` itself, which only ever saw the
 * server's own machine — a worktree on a remote machine was never reaped. bb
 * starts this entry on whichever machine the server names, so the kill runs
 * where the processes live.
 */
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readlink } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { promisify } from "node:util";
import {
  experimental_defineHostEntry,
  experimental_killProcessesWithCwdUnder,
} from "@get-bb/plugin-sdk/host";
import { hostContract } from "./host-contract";
import { reapDirectory, type DirectoryReapDeps } from "./reap";
import { parseCwds, scanPorts, type PortScanDeps } from "./ports";

const execFileAsync = promisify(execFile);

function isAlive(pid: number): boolean {
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and is someone else's — alive, and not ours.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const hostDeps: DirectoryReapDeps = {
  home: homedir(),
  exists: existsSync,
  readProcessTable: async () => {
    const { stdout } = await execFileAsync("ps", ["-Ao", "pid=,ppid=,args="], {
      // A machine with thousands of processes still has to fit; the default
      // buffer is 1MB.
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  },
  killUnder: (directory) => experimental_killProcessesWithCwdUnder({ directory }),
  isAlive,
  log: { warn: (message) => console.warn(message) },
};

/**
 * lsof exits non-zero when any file is inaccessible — routine on a shared
 * machine — and when it finds nothing at all. Output is still the answer.
 */
async function runLsof(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("lsof", args, {
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === "string" && (error as { code?: unknown }).code === 1) {
      return stdout;
    }
    throw error;
  }
}

export const portScanDeps: PortScanDeps = {
  home: homedir(),
  readListeners: () => runLsof(["-nP", "-iTCP", "-sTCP:LISTEN"]),
  readCwds: async (pids) => {
    // /proc is authoritative on Linux; macOS needs a second lsof.
    if (platform() === "linux") {
      const cwds = new Map<number, string>();
      await Promise.all(
        pids.map(async (pid) => {
          try {
            cwds.set(pid, await readlink(`/proc/${pid}/cwd`));
          } catch {
            // Exited since the first pass, or another user's.
          }
        }),
      );
      return cwds;
    }
    return parseCwds(await runLsof(["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"]));
  },
  realpath: (directory) => realpathSync(directory),
  log: { warn: (message) => console.warn(message) },
};

export function createHostEntry(
  deps: DirectoryReapDeps = hostDeps,
  portDeps: PortScanDeps = portScanDeps,
) {
  return experimental_defineHostEntry({
    contract: hostContract,
    handlers: {
      reapDirectory: ({ directory }) => reapDirectory(directory, deps),
      listPorts: async ({ directories }) => ({
        ports: await scanPorts(directories, portDeps),
      }),
    },
  });
}

export default createHostEntry();
