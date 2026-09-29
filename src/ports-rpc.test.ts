import { describe, expect, it, vi } from "vitest";
import { createPortHandlers, type PortRpcDeps } from "./ports-rpc";

function handlers(overrides: Partial<PortRpcDeps> = {}) {
  const scanHost = vi.fn<PortRpcDeps["scanHost"]>(async (_hostId, directories) => ({
    ports: Object.fromEntries(directories.map((d) => [d, [3000]])),
  }));
  const deps: PortRpcDeps = {
    readEnabled: async () => true,
    scanHost,
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
        return { ports: Object.fromEntries(directories.map((d) => [d, [5173]])) };
      },
    });
    const result = await listPorts({
      targets: [
        { hostId: "down", directories: ["/a"] },
        { hostId: "up", directories: ["/b"] },
      ],
    });
    expect(result.ports).toEqual([{ hostId: "up", directory: "/b", ports: [5173] }]);
  });
});
