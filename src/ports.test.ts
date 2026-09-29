import { describe, expect, it } from "vitest";
import {
  attributeToDirectory,
  comparePorts,
  MAX_PORTS_PER_DIRECTORY,
  parseAddressPort,
  parseCwds,
  parseCommands,
  parseListeners,
  scanPorts,
  summarizeCommand,
  type PortScanDeps,
} from "./ports";

const LSOF_LISTEN = `COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node      4101 roger   23u  IPv6 0x1a2b3c4d5e6f7a8b      0t0  TCP *:3000 (LISTEN)
node      4101 roger   24u  IPv4 0x1a2b3c4d5e6f7a8c      0t0  TCP 127.0.0.1:3000 (LISTEN)
node      4102 roger   20u  IPv6 0x1a2b3c4d5e6f7a8d      0t0  TCP [::1]:5173 (LISTEN)
postgres  4200 roger    7u  IPv4 0x1a2b3c4d5e6f7a8e      0t0  TCP 127.0.0.1:5432 (LISTEN)
node      4103 roger   30u  IPv4 0x1a2b3c4d5e6f7a8f      0t0  TCP 127.0.0.1:61234 (LISTEN)
python3   4300 roger    3u  IPv4 0x1a2b3c4d5e6f7a90      0t0  TCP *:8000 (LISTEN)
`;

const LSOF_CWD = `p4101
fcwd
n/w/app
p4102
fcwd
n/w/app/.bb/worktrees/feat
p4103
fcwd
n/w/app
p4300
fcwd
n/w/app-old
`;

describe("parseListeners", () => {
  it("reads pid, command and port from every listening row", () => {
    const listeners = parseListeners(LSOF_LISTEN);
    expect(listeners).toContainEqual({
      pid: 4101,
      processName: "node",
      address: "*",
      port: 3000,
    });
    expect(listeners).toContainEqual({
      pid: 4102,
      processName: "node",
      address: "::1",
      port: 5173,
    });
    expect(listeners).toHaveLength(6);
  });

  it("skips the header and anything unparseable", () => {
    expect(parseListeners("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\ngarbage\n")).toEqual([]);
  });
});

describe("parseAddressPort", () => {
  it("takes the port after the last colon", () => {
    expect(parseAddressPort("[fe80::1]:8080")).toEqual({ address: "fe80::1", port: 8080 });
    expect(parseAddressPort("*:http")).toBeNull();
    expect(parseAddressPort("nocolon")).toBeNull();
  });
});

describe("parseCwds", () => {
  it("maps each pid to the first path after it", () => {
    const cwds = parseCwds(LSOF_CWD);
    expect(cwds.get(4101)).toBe("/w/app");
    expect(cwds.get(4102)).toBe("/w/app/.bb/worktrees/feat");
    expect(cwds.size).toBe(4);
  });
});

describe("attributeToDirectory", () => {
  const directories = ["/w/app", "/w/app/.bb/worktrees/feat"];

  it("credits the deepest directory a path is under", () => {
    expect(attributeToDirectory("/w/app/.bb/worktrees/feat/web", directories)).toBe(
      "/w/app/.bb/worktrees/feat",
    );
    expect(attributeToDirectory("/w/app/packages/api", directories)).toBe("/w/app");
    expect(attributeToDirectory("/w/app", directories)).toBe("/w/app");
  });

  it("does not match a sibling that only shares a prefix", () => {
    expect(attributeToDirectory("/w/app-old", directories)).toBeNull();
  });

  it("ignores trailing separators on either side", () => {
    expect(attributeToDirectory("/w/app/", ["/w/app/"])).toBe("/w/app/");
  });
});

describe("comparePorts", () => {
  it("puts the usual web ports first, each group ascending", () => {
    expect([9229, 8080, 3000, 1234, 5173].sort(comparePorts)).toEqual([
      3000, 5173, 8080, 1234, 9229,
    ]);
  });
});

const PS_COMMANDS = ` 4101 node /Users/roger/w/app/node_modules/.bin/next dev
 4102 NODE_ENV=development API_TOKEN=s3cret /opt/homebrew/bin/node /w/app/node_modules/.bin/vite --port 5173
`;

describe("parseCommands", () => {
  it("reads each pid's whole command line", () => {
    expect(parseCommands(PS_COMMANDS)).toEqual(
      new Map([
        [4101, "node /Users/roger/w/app/node_modules/.bin/next dev"],
        [
          4102,
          "NODE_ENV=development API_TOKEN=s3cret /opt/homebrew/bin/node /w/app/node_modules/.bin/vite --port 5173",
        ],
      ]),
    );
  });
});

describe("summarizeCommand", () => {
  it("names the program, then the arguments with paths cut to their last segment", () => {
    expect(summarizeCommand("node /w/app/node_modules/.bin/vite --port 3000")).toBe(
      "node · vite --port 3000",
    );
    expect(summarizeCommand("/usr/local/bin/python3 -m http.server")).toBe(
      "python3 · -m http.server",
    );
    expect(summarizeCommand("/opt/bin/caddy")).toBe("caddy");
  });

  it("never carries an environment assignment", () => {
    const summary = summarizeCommand("NODE_ENV=dev API_TOKEN=s3cret node server.js");
    expect(summary).toBe("node · server.js");
    expect(summary).not.toContain("s3cret");
  });

  it("is bounded, with an ellipsis where it was cut", () => {
    const summary = summarizeCommand(`node ${"--flag ".repeat(60)}`);
    expect(summary).toHaveLength(120);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("is empty for nothing", () => {
    expect(summarizeCommand("   ")).toBe("");
  });
});

describe("scanPorts", () => {
  const deps = (overrides: Partial<PortScanDeps> = {}): PortScanDeps => ({
    home: "/Users/roger",
    readListeners: async () => LSOF_LISTEN,
    readCwds: async () => parseCwds(LSOF_CWD),
    readCommands: async () => parseCommands(PS_COMMANDS),
    realpath: (directory) => directory,
    log: { warn: () => {} },
    ...overrides,
  });

  it("maps one scan to every directory, leaving databases and ephemeral loopback out", async () => {
    const result = await scanPorts(
      ["/w/app", "/w/app/.bb/worktrees/feat", "/w/elsewhere"],
      deps(),
    );
    expect(result).toEqual({
      "/w/app": {
        ports: [{ port: 3000, pid: 4101, command: "node · next dev" }],
        more: 0,
      },
      "/w/app/.bb/worktrees/feat": {
        ports: [{ port: 5173, pid: 4102, command: "node · vite --port 5173" }],
        more: 0,
      },
      "/w/elsewhere": { ports: [], more: 0 },
    });
  });

  it("asks ps once, only for the pids that were credited", async () => {
    const asked: number[][] = [];
    await scanPorts(
      ["/w/app"],
      deps({
        readCommands: async (pids) => {
          asked.push(pids);
          return new Map();
        },
      }),
    );
    // 4103 is ephemeral loopback, 4300 works in /w/app-old, 4200 is postgres.
    expect(asked).toEqual([[4101, 4102]]);
  });

  it("still reports the ports when ps fails, without commands", async () => {
    const warnings: string[] = [];
    const result = await scanPorts(
      ["/w/app/.bb/worktrees/feat"],
      deps({
        readCommands: async () => {
          throw new Error("no ps");
        },
        log: { warn: (message) => warnings.push(message) },
      }),
    );
    expect(result["/w/app/.bb/worktrees/feat"]).toEqual({
      ports: [{ port: 5173, pid: 4102, command: "" }],
      more: 0,
    });
    expect(warnings).toHaveLength(1);
  });

  it("scans once, however many directories are asked about", async () => {
    let scans = 0;
    await scanPorts(
      ["/w/a", "/w/b", "/w/c"],
      deps({
        readListeners: async () => {
          scans += 1;
          return LSOF_LISTEN;
        },
      }),
    );
    expect(scans).toBe(1);
  });

  it("answers under the name asked, when the process reports the resolved path", async () => {
    const result = await scanPorts(
      ["/tmp/w/app"],
      deps({ realpath: (directory) => directory.replace("/tmp/w", "/w") }),
    );
    // Only the checkout was asked about, so the worktree nested in it rolls up.
    expect(result["/tmp/w/app"]?.ports.map((entry) => entry.port)).toEqual([3000, 5173]);
  });

  it("credits nothing to the home directory or the root, and does not scan for them", async () => {
    const result = await scanPorts(
      ["/Users/roger", "/"],
      deps({
        readListeners: async () => {
          throw new Error("must not scan");
        },
      }),
    );
    expect(result).toEqual({
      "/Users/roger": { ports: [], more: 0 },
      "/": { ports: [], more: 0 },
    });
  });

  it("caps what one directory reports, well-known dev ports first, and counts the rest", async () => {
    const rows = Array.from(
      { length: 12 },
      (_, index) => `node 5000 roger 1u IPv4 0x0 0t0 TCP *:${7000 + index} (LISTEN)`,
    );
    rows.push("node 5000 roger 1u IPv4 0x0 0t0 TCP *:8080 (LISTEN)");
    const result = await scanPorts(
      ["/w/app"],
      deps({
        readListeners: async () => `COMMAND PID\n${rows.join("\n")}\n`,
        readCwds: async () => new Map([[5000, "/w/app"]]),
      }),
    );
    const listing = result["/w/app"]!;
    expect(listing.ports).toHaveLength(MAX_PORTS_PER_DIRECTORY);
    expect(listing.ports[0]?.port).toBe(8080);
    expect(listing.more).toBe(13 - MAX_PORTS_PER_DIRECTORY);
  });

  it("reports empty entries when lsof fails", async () => {
    const warnings: string[] = [];
    const result = await scanPorts(
      ["/w/app"],
      deps({
        readListeners: async () => {
          throw new Error("no lsof");
        },
        log: { warn: (message) => warnings.push(message) },
      }),
    );
    expect(result).toEqual({ "/w/app": { ports: [], more: 0 } });
    expect(warnings).toHaveLength(1);
  });
});
