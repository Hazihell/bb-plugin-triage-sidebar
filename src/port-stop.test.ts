import { describe, expect, it, vi } from "vitest";
import { stopPort, type PortStopDeps } from "./port-stop";

const LSOF = [
  "COMMAND  PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
  "node    4101 me   23u IPv4 0x1    0t0      TCP  *:3000 (LISTEN)",
].join("\n");

function deps(overrides: Partial<PortStopDeps> = {}): PortStopDeps {
  return {
    home: "/Users/me",
    readListeners: async () => LSOF,
    readCwds: async () => new Map([[4101, "/w/app/web"]]),
    realpath: (directory) => directory,
    signal: vi.fn(),
    isAlive: () => false,
    sleep: async () => {},
    protectedPids: [1, 99],
    log: { warn: () => {} },
    ...overrides,
  };
}

const input = { directory: "/w/app", port: 3000, pid: 4101 };

describe("stopPort", () => {
  it("is already gone when the pid no longer exists", async () => {
    const signal = vi.fn();
    expect(
      await stopPort(input, deps({ readListeners: async () => "", signal })),
    ).toEqual({ result: "already-gone", message: null });
    expect(signal).not.toHaveBeenCalled();
  });

  it("is already gone when the process exits between the check and the signal", async () => {
    const signal = vi.fn(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    expect((await stopPort(input, deps({ signal }))).result).toBe("already-gone");
  });

  it("fails without SIGKILL when the process is not ours to signal", async () => {
    const signal = vi.fn(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    expect((await stopPort(input, deps({ signal }))).result).toBe("failed");
    expect(signal).toHaveBeenCalledTimes(1);
  });

  it("fails when even SIGKILL leaves it running", async () => {
    const signal = vi.fn();
    const report = await stopPort(input, deps({ signal, isAlive: () => true }));
    expect(report.result).toBe("failed");
    expect(signal.mock.calls.map((call) => call[1])).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("refuses a protected pid before scanning anything", async () => {
    const readListeners = vi.fn(async () => LSOF);
    expect((await stopPort({ ...input, pid: 99 }, deps({ readListeners }))).result).toBe(
      "refused",
    );
    expect(readListeners).not.toHaveBeenCalled();
  });
});
