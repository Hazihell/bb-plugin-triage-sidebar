import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
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

  // End to end on this machine: a server listening from a throwaway directory
  // is found by one real lsof scan and credited to that directory.
  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "lists the port a process in the directory is listening on",
    async () => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), "triage-ports-")));
      // Below the ephemeral range, which the scan leaves out as internal.
      const wanted = 20_000 + Math.floor(Math.random() * 20_000);
      const child = spawn(
        process.execPath,
        [
          "-e",
          `require('http').createServer(()=>{}).listen(${wanted},'127.0.0.1',()=>console.log('up'))`,
        ],
        { cwd: directory, stdio: ["ignore", "pipe", "ignore"] },
      );
      cleanups.push(async () => {
        child.kill("SIGKILL");
        await rm(directory, { recursive: true, force: true });
      });
      await new Promise((resolve) => child.stdout!.once("data", resolve));

      const harness = experimental_createHostEntryHarness(hostEntry);
      cleanups.push(() => harness.experimental_dispose());
      const result = await harness.experimental_call("listPorts", {
        directories: [directory],
      });
      expect(result.ports).toEqual({ [directory]: [wanted] });
    },
    15_000,
  );
});
