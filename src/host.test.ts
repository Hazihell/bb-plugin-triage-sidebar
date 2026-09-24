import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";

// The SDK's host module bundles a CommonJS dependency that reaches for
// `require`, which an ES module under vitest does not have. bb's own host
// build supplies it; this test has to, before the entry is loaded.
(globalThis as { require?: NodeJS.Require }).require ??= createRequire(
  import.meta.url,
);
const { default: hostEntry, createHostEntry, hostDeps } = await import("./host");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("host entry", () => {
  it("refuses a directory too wide to sweep, through the real contract", async () => {
    const harness = experimental_createHostEntryHarness(
      createHostEntry({
        ...hostDeps,
        killUnder: async () => {
          throw new Error("must not be asked");
        },
      }),
    );
    cleanups.push(() => harness.experimental_dispose());

    const report = await harness.experimental_call("reapDirectory", {
      directory: "/",
    });
    expect(report.refused).not.toBeNull();
    expect(report.killed).toEqual([]);
  });

  // End to end on this machine: a detached process working in a throwaway
  // directory is found by bb's own helper, killed, and named.
  it.skipIf(process.platform === "win32")(
    "kills a detached process working in the directory",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "triage-reap-"));
      const child = spawn("sleep", ["300"], {
        cwd: directory,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      cleanups.push(async () => {
        try {
          process.kill(child.pid!, "SIGKILL");
        } catch {
          // Already gone, which is the point.
        }
        await rm(directory, { recursive: true, force: true });
      });
      // Give the process a moment to exist in the table.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const harness = experimental_createHostEntryHarness(hostEntry);
      cleanups.push(() => harness.experimental_dispose());
      const report = await harness.experimental_call("reapDirectory", {
        directory,
      });

      expect(report.refused).toBeNull();
      expect(report.killed).toContainEqual({
        pid: child.pid,
        command: "sleep 300",
      });
      expect(report.failed).toBe(0);
    },
    15_000,
  );
});
