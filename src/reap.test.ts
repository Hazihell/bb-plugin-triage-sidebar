import { describe, expect, it } from "vitest";
import {
  parseProcessTable,
  reapDirectory,
  refuseDirectory,
  summarizeCommand,
  type DirectoryReapDeps,
} from "./reap";

const WORKTREE = "/Users/x/.bb/worktrees/env_abc/app";

describe("parseProcessTable", () => {
  it("keeps a command line that contains spaces", () => {
    const [parsed] = parseProcessTable(
      "  501     1 /usr/bin/node /some/path/vite.js --port 4321\n",
    );
    expect(parsed).toEqual({
      pid: 501,
      ppid: 1,
      command: "/usr/bin/node /some/path/vite.js --port 4321",
    });
  });

  it("ignores headers and blank lines rather than inventing rows", () => {
    expect(parseProcessTable("  PID  PPID ARGS\n\n   7   1 node a\n")).toEqual([
      { pid: 7, ppid: 1, command: "node a" },
    ]);
  });
});

describe("summarizeCommand", () => {
  it("collapses whitespace and truncates a long argv", () => {
    expect(summarizeCommand("node   a   b")).toBe("node a b");
    expect(summarizeCommand("x".repeat(500))).toHaveLength(120);
  });
});

describe("refuseDirectory", () => {
  const home = "/Users/x";

  it("accepts a worktree", () => {
    expect(refuseDirectory(WORKTREE, home)).toBeNull();
  });

  // Each of these would take the user's whole session with it.
  it("refuses the root, the home directory and anything above it", () => {
    expect(refuseDirectory("/", home)).not.toBeNull();
    expect(refuseDirectory("/Users/x", home)).not.toBeNull();
    expect(refuseDirectory("/Users/x/", home)).not.toBeNull();
    expect(refuseDirectory("/Users", home)).not.toBeNull();
  });

  it("refuses a relative path", () => {
    expect(refuseDirectory("worktrees/app", home)).not.toBeNull();
  });

  // Starting with the home directory's name is not being above it.
  it("accepts a sibling of home whose name merely starts the same way", () => {
    expect(refuseDirectory("/Users/xy/app", home)).toBeNull();
  });
});

const deps = (overrides: Partial<DirectoryReapDeps> = {}): DirectoryReapDeps => ({
  home: "/Users/x",
  exists: () => true,
  readProcessTable: async () =>
    `  100     1 node ${WORKTREE}/node_modules/.bin/vite --port 4321\n  200     1 esbuild --service\n`,
  killUnder: async () => [{ pid: 100 }, { pid: 200 }],
  isAlive: () => false,
  log: { warn: () => {} },
  ...overrides,
});

describe("reapDirectory", () => {
  it("names what it killed from the process table", async () => {
    expect(await reapDirectory(WORKTREE, deps())).toEqual({
      killed: [
        { pid: 100, command: `node ${WORKTREE}/node_modules/.bin/vite --port 4321` },
        { pid: 200, command: "esbuild --service" },
      ],
      failed: 0,
      refused: null,
    });
  });

  it("counts a survivor as failed instead of claiming a kill", async () => {
    const report = await reapDirectory(
      WORKTREE,
      deps({ isAlive: (pid) => pid === 200 }),
    );
    expect(report.killed.map((p) => p.pid)).toEqual([100]);
    expect(report.failed).toBe(1);
  });

  // The names are a courtesy; the kill is the point.
  it("still kills when the process table cannot be read", async () => {
    const report = await reapDirectory(
      WORKTREE,
      deps({
        readProcessTable: async () => {
          throw new Error("no ps");
        },
      }),
    );
    expect(report.killed).toEqual([
      { pid: 100, command: "pid 100" },
      { pid: 200, command: "pid 200" },
    ]);
  });

  it("signals nothing for a refused directory", async () => {
    let asked = false;
    const report = await reapDirectory(
      "/Users/x",
      deps({
        killUnder: async () => {
          asked = true;
          return [];
        },
      }),
    );
    expect(asked).toBe(false);
    expect(report.refused).not.toBeNull();
  });

  it("does nothing for a worktree that is already gone", async () => {
    let asked = false;
    await reapDirectory(
      WORKTREE,
      deps({
        exists: () => false,
        killUnder: async () => {
          asked = true;
          return [];
        },
      }),
    );
    expect(asked).toBe(false);
  });
});
