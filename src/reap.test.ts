import { describe, expect, it, vi } from "vitest";
import {
  isInsideWorktree,
  parseProcessTable,
  parseWorkingDirectories,
  reapWorktree,
  selectWorktreeProcesses,
  summarizeCommand,
  withWorkingDirectories,
  type ProcessRow,
  type ReapDeps,
} from "./reap";

const WORKTREE = "/Users/x/.bb/worktrees/env_abc/app";

const row = (overrides: Partial<ProcessRow> = {}): ProcessRow => ({
  pid: 100,
  ppid: 1,
  command: `node ${WORKTREE}/node_modules/.bin/vite --port 4321`,
  cwd: null,
  ...overrides,
});

const noSpares = {
  worktreePaths: [WORKTREE],
  selfPids: new Set<number>(),
};

describe("parseProcessTable", () => {
  it("keeps a command line that contains spaces", () => {
    const [parsed] = parseProcessTable(
      "  501     1 /usr/bin/node /some/path/vite.js --port 4321\n",
    );
    expect(parsed).toEqual({
      pid: 501,
      ppid: 1,
      command: "/usr/bin/node /some/path/vite.js --port 4321",
      cwd: null,
    });
  });

  it("ignores headers and blank lines rather than inventing rows", () => {
    expect(parseProcessTable("  PID  PPID ARGS\n\n   7   1 node a\n")).toEqual([
      { pid: 7, ppid: 1, command: "node a", cwd: null },
    ]);
  });
});

describe("selectWorktreeProcesses", () => {
  it("selects a process whose command names the worktree", () => {
    expect(selectWorktreeProcesses({ ...noSpares, rows: [row()] })).toHaveLength(
      1,
    );
  });

  it("leaves a process in another worktree alone", () => {
    const other = row({ command: "node /elsewhere/vite.js" });
    expect(selectWorktreeProcesses({ ...noSpares, rows: [other] })).toEqual([]);
  });

  it("prefers the working directory over the command line", () => {
    // Argv names this worktree, but the process is actually running elsewhere.
    const elsewhere = row({ cwd: "/somewhere/else" });
    expect(selectWorktreeProcesses({ ...noSpares, rows: [elsewhere] })).toEqual(
      [],
    );
  });

  it("selects a process whose working directory is inside the worktree", () => {
    const inside = row({ command: "node server.js", cwd: `${WORKTREE}/api` });
    expect(
      selectWorktreeProcesses({ ...noSpares, rows: [inside] }),
    ).toHaveLength(1);
  });

  it("does not treat a sibling worktree as inside this one", () => {
    const sibling = row({ cwd: `${WORKTREE}-old` });
    const byArgv = row({ pid: 101, command: `node ${WORKTREE}-old/vite.js` });
    expect(
      selectWorktreeProcesses({ ...noSpares, rows: [sibling, byArgv] }),
    ).toEqual([]);
  });

  it("never selects a descendant of the reaper", () => {
    const child = row({ pid: 11, ppid: 99 });
    expect(
      selectWorktreeProcesses({
        ...noSpares,
        rows: [row({ pid: 99 }), child],
        selfPids: new Set([99]),
      }),
    ).toEqual([]);
  });

  it("never selects the reaper itself", () => {
    expect(
      selectWorktreeProcesses({
        ...noSpares,
        rows: [row({ pid: 99 })],
        selfPids: new Set([99]),
      }),
    ).toEqual([]);
  });

  it("returns nothing for an empty worktree path, rather than matching everything", () => {
    expect(
      selectWorktreeProcesses({ ...noSpares, worktreePaths: [""], rows: [row()] }),
    ).toEqual([]);
  });

  it("survives a parent cycle in a corrupt table", () => {
    const a = row({ pid: 1, ppid: 2 });
    const b = row({ pid: 2, ppid: 1 });
    expect(
      selectWorktreeProcesses({ ...noSpares, rows: [a, b] }),
    ).toHaveLength(2);
  });
});

describe("summarizeCommand", () => {
  it("collapses whitespace and truncates a long argv", () => {
    expect(summarizeCommand("node   a   b")).toBe("node a b");
    expect(summarizeCommand("x".repeat(500))).toHaveLength(120);
  });
});

const deps = (overrides: Partial<ReapDeps> = {}): ReapDeps => ({
  readProcessTable: async () => `  100     1 node ${WORKTREE}/vite.js`,
  readWorkingDirectories: async () => null,
  kill: async () => {},
  isAlive: async () => false,
  wait: async () => {},
  log: { warn: () => {} },
  ...overrides,
});

describe("reapWorktree", () => {
  it("reports what it killed", async () => {
    const report = await reapWorktree(noSpares, deps());
    expect(report.killed.map((k) => k.pid)).toEqual([100]);
    expect(report.failed).toBe(0);
  });

  it("escalates to SIGKILL only for a process that ignored SIGTERM", async () => {
    const kill =
      vi.fn<(pid: number, signal: "SIGTERM" | "SIGKILL") => Promise<void>>();
    const isAlive = vi
      .fn<(pid: number) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const report = await reapWorktree(noSpares, deps({ kill, isAlive }));
    expect(kill.mock.calls.map((call) => call[1])).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    expect(report.killed).toHaveLength(1);
  });

  it("counts a survivor as failed instead of claiming a kill", async () => {
    const report = await reapWorktree(
      noSpares,
      deps({ isAlive: async () => true }),
    );
    expect(report).toEqual({ killed: [], failed: 1 });
  });

  it("reports nothing when the process table cannot be read", async () => {
    const warn = vi.fn();
    const report = await reapWorktree(
      noSpares,
      deps({
        readProcessTable: async () => {
          throw new Error("no ps");
        },
        log: { warn },
      }),
    );
    expect(report).toEqual({ killed: [], failed: 0 });
    expect(warn).toHaveBeenCalled();
  });
});

describe("parseWorkingDirectories", () => {
  it("pairs each name with the process record that opened it", () => {
    expect(parseWorkingDirectories("p100\nn/a/b\np200\nn/c\n")).toEqual(
      new Map([
        [100, "/a/b"],
        [200, "/c"],
      ]),
    );
  });

  it("drops a name that belongs to no process record", () => {
    expect(parseWorkingDirectories("n/orphan\np7\nn/real\n")).toEqual(
      new Map([[7, "/real"]]),
    );
  });
});

describe("withWorkingDirectories", () => {
  it("leaves a row whose directory was never reported at null", () => {
    const merged = withWorkingDirectories(
      [row({ pid: 1 }), row({ pid: 2 })],
      new Map([[1, "/a"]]),
    );
    expect(merged.map((r) => r.cwd)).toEqual(["/a", null]);
  });
});

describe("isInsideWorktree", () => {
  it("accepts the worktree itself and anything under it", () => {
    expect(isInsideWorktree("/w/app", ["/w/app"])).toBe(true);
    expect(isInsideWorktree("/w/app/src", ["/w/app"])).toBe(true);
  });

  it("rejects a sibling whose path merely starts the same way", () => {
    expect(isInsideWorktree("/w/app-old", ["/w/app"])).toBe(false);
  });

  it("ignores a trailing slash on the worktree", () => {
    expect(isInsideWorktree("/w/app/src", ["/w/app/"])).toBe(true);
  });

  // The macOS case this was written for: bb records /tmp/x, the kernel
  // reports /private/tmp/x, and they are the same directory.
  it("accepts a path under any of the worktree's names", () => {
    const roots = ["/tmp/x", "/private/tmp/x"];
    expect(isInsideWorktree("/private/tmp/x/src", roots)).toBe(true);
    expect(isInsideWorktree("/tmp/x", roots)).toBe(true);
    expect(isInsideWorktree("/private/tmp/other", roots)).toBe(false);
  });
});

describe("reapWorktree working directories", () => {
  it("falls back to the command line when they cannot be read", async () => {
    const warn = vi.fn();
    const report = await reapWorktree(
      noSpares,
      deps({
        readWorkingDirectories: async () => {
          throw new Error("no lsof");
        },
        log: { warn },
      }),
    );
    expect(report.killed.map((k) => k.pid)).toEqual([100]);
    expect(warn).toHaveBeenCalled();
  });
});
