// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clickTarget, openInBb, openInSystemBrowser, type OpenInBbArgs } from "./port-open";

const URL_3000 = "http://localhost:3000";
const win = (instanceId: string) => ({ hostId: "host_mac", instanceId, generation: "gen" });

function args(instances: ReturnType<typeof win>[], overrides: Partial<OpenInBbArgs> = {}) {
  const navigate = { openUrl: vi.fn((_url: string) => true), toThread: vi.fn() };
  const browsers = {
    listInstances: vi.fn(async () => ({ instances })),
    createTab: vi.fn(async () => ({ tab: { tabId: "tab_1" } })),
    revealTab: vi.fn(async () => ({ ok: true })),
  };
  const sdk = {
    hosts: {
      list: vi.fn(async () => [
        { id: "host_mac", status: "connected" },
        { id: "host_gone", status: "disconnected" },
      ]),
    },
    experimental_desktopBrowsers: browsers,
  };
  const input = {
    sdk,
    navigate,
    threadId: "thr_1",
    url: URL_3000,
    warn: vi.fn(),
    ...overrides,
  } as unknown as OpenInBbArgs;
  return { input, navigate, browsers, sdk };
}

const windowOpen = vi.fn();
beforeEach(() => {
  windowOpen.mockClear();
  vi.stubGlobal("open", windowOpen);
});
afterEach(() => vi.unstubAllGlobals());

describe("clickTarget", () => {
  it("is bb for a plain click and the system browser with ⌘ or Ctrl", () => {
    expect(clickTarget({ metaKey: false, ctrlKey: false })).toBe("bb");
    expect(clickTarget({ metaKey: true, ctrlKey: false })).toBe("system");
    expect(clickTarget({ metaKey: false, ctrlKey: true })).toBe("system");
  });
});

describe("openInBb", () => {
  it("creates a revealed tab in the one bb window, owned by the thread, after showing the thread", async () => {
    const { input, navigate, browsers } = args([win("w1")]);
    expect(await openInBb(input)).toBe("bb");
    // Only connected machines are asked for windows.
    expect(browsers.listInstances).toHaveBeenCalledTimes(1);
    expect(navigate.toThread).toHaveBeenCalledWith("thr_1");
    expect(browsers.createTab).toHaveBeenCalledWith({
      hostId: "host_mac",
      instanceId: "w1",
      generation: "gen",
      threadId: "thr_1",
      url: URL_3000,
      presentation: "reveal",
    });
    expect(browsers.revealTab).toHaveBeenCalledWith(expect.objectContaining({ tabId: "tab_1" }));
    expect(navigate.openUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["no bb window", []],
    ["several bb windows", [win("w1"), win("w2")]],
  ])("falls back to the default browser with %s", async (_label, instances) => {
    const { input, navigate, browsers } = args(instances);
    expect(await openInBb(input)).toBe("system");
    expect(browsers.createTab).not.toHaveBeenCalled();
    expect(navigate.toThread).not.toHaveBeenCalled();
    expect(navigate.openUrl).toHaveBeenCalledWith(URL_3000);
  });

  it("falls back to the default browser when the desktop refuses the tab", async () => {
    const { input, navigate, browsers } = args([win("w1")]);
    browsers.createTab.mockRejectedValueOnce(new Error("stale generation"));
    expect(await openInBb(input)).toBe("system");
    expect(navigate.openUrl).toHaveBeenCalledWith(URL_3000);
  });
});

describe("openInSystemBrowser", () => {
  it("hands the URL to bb, which sends it to the OS from the sidebar", () => {
    const navigate = { openUrl: vi.fn(() => true) };
    openInSystemBrowser(navigate, URL_3000);
    expect(navigate.openUrl).toHaveBeenCalledWith(URL_3000);
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("opens a plain new window when bb declines the URL", () => {
    openInSystemBrowser({ openUrl: () => false }, URL_3000);
    expect(windowOpen).toHaveBeenCalledWith(URL_3000, "_blank", "noopener,noreferrer");
  });
});
