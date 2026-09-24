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
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import {
  experimental_defineHostEntry,
  experimental_killProcessesWithCwdUnder,
} from "@get-bb/plugin-sdk/host";
import { hostContract } from "./host-contract";
import { reapDirectory, type DirectoryReapDeps } from "./reap";

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

export function createHostEntry(deps: DirectoryReapDeps = hostDeps) {
  return experimental_defineHostEntry({
    contract: hostContract,
    handlers: {
      reapDirectory: ({ directory }) => reapDirectory(directory, deps),
    },
  });
}

export default createHostEntry();
