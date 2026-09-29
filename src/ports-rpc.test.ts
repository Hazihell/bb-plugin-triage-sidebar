import { describe, expect, it, vi } from "vitest";
import { createPortHandlers, type PortRpcDeps } from "./ports-rpc";
import type { PortListing } from "./host-contract";

const listing = (port: number): PortListing => ({
  ports: [{ port, pid: 42, command: "node · vite" }],
  more: 0,
});

function handlers(overrides: Partial<PortRpcDeps> = {}) {
  const scanHost = vi.fn<PortRpcDeps["scanHost"]>(async (_hostId, directories) => ({
    ports: Object.fromEntries(directories.map((d) => [d, listing(3000)])),
  }));
  const deps: PortRpcDeps = {
    readEnabled: async () => true,
    scanHost,
    resolveThread: async () => ({ hostId: "h1", directory: "/w/a" }),
    stopOnHost: async () => ({ result: "killed", message: null }),
    log: { warn: () => {} },
    ...overrides,
  };
  return { ...createPortHandlers(deps), scanHost: deps.scanHost as typeof scanHost };
}

describe("listPorts", () => {
  it("makes one host call per machine, with that machine's directories merged", async () => {
    const { listPorts, scanHost } = handlers();
    const result = await listPorts({
      targets: [
        { hostId: "h1", directories: ["/a", "/b"] },
        { hostId: "h2", directories: ["/c"] },
        { hostId: "h1", directories: ["/b", "/d"] },
      ],
    });
    expect(scanHost).toHaveBeenCalledTimes(2);
    expect(scanHost.mock.calls[0]?.[1]).toEqual(["/a", "/b", "/d"]);
    expect(result.enabled).toBe(true);
    expect(result.ports).toHaveLength(4);
  });

  it("scans nothing when the setting is off", async () => {
    const { listPorts, scanHost } = handlers({ readEnabled: async () => false });
    expect(await listPorts({ targets: [{ hostId: "h1", directories: ["/a"] }] })).toEqual({
      enabled: false,
      ports: [],
    });
    expect(scanHost).not.toHaveBeenCalled();
  });

  it("leaves out a machine that cannot be reached, keeping the others", async () => {
    const { listPorts } = handlers({
      scanHost: async (hostId, directories) => {
        if (hostId === "down") throw new Error("offline");
        return { ports: Object.fromEntries(directories.map((d) => [d, listing(5173)])) };
      },
    });
    const result = await listPorts({
      targets: [
        { hostId: "down", directories: ["/a"] },
        { hostId: "up", directories: ["/b"] },
      ],
    });
    expect(result.ports).toEqual([{ hostId: "up", directory: "/b", listing: listing(5173) }]);
  });
});

describe("stopPort", () => {
  it("sends the thread's own machine and directory, never the sidebar's", async () => {
    const stopOnHost = vi.fn<PortRpcDeps["stopOnHost"]>(async () => ({
      result: "killed",
      message: null,
    }));
    const { stopPort } = handlers({
      resolveThread: async (threadId) =>
        threadId === "thr_1" ? { hostId: "h2", directory: "/w/thr_1" } : null,
      stopOnHost,
    });
    expect(await stopPort({ threadId: "thr_1", port: 3000, pid: 42 })).toEqual({
      result: "killed",
      message: null,
    });
    expect(stopOnHost).toHaveBeenCalledWith(
      "h2",
      { directory: "/w/thr_1", port: 3000, pid: 42 },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("passes the host's changed and refused answers through", async () => {
    for (const report of [
      { result: "changed", message: null },
      { result: "refused", message: "Refused: the home directory or one above it" },
    ] as const) {
      const { stopPort } = handlers({ stopOnHost: async () => report });
      expect(await stopPort({ threadId: "thr_1", port: 3000, pid: 42 })).toEqual(report);
    }
  });

  it("refuses a thread with no directory, and stops nothing while ports are off", async () => {
    const stopOnHost = vi.fn<PortRpcDeps["stopOnHost"]>();
    const noDirectory = handlers({ resolveThread: async () => null, stopOnHost });
    expect((await noDirectory.stopPort({ threadId: "thr_1", port: 3000, pid: 42 })).result).toBe(
      "refused",
    );
    const off = handlers({ readEnabled: async () => false, stopOnHost });
    expect((await off.stopPort({ threadId: "thr_1", port: 3000, pid: 42 })).result).toBe(
      "refused",
    );
    expect(stopOnHost).not.toHaveBeenCalled();
  });

  it("reports an unreachable machine as failed", async () => {
    const { stopPort } = handlers({
      stopOnHost: async () => {
        throw new Error("offline");
      },
    });
    expect((await stopPort({ threadId: "thr_1", port: 3000, pid: 42 })).result).toBe("failed");
  });
});
