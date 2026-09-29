import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { portTargets } from "./usePorts";

const thread = (
  id: string,
  hostId: string | null,
  path: string | null,
): PluginSidebarThread =>
  ({
    id,
    host: hostId === null ? null : { id: hostId, name: hostId },
    environment: path === null ? null : { path },
  }) as unknown as PluginSidebarThread;

describe("portTargets", () => {
  it("groups directories by machine, once each, and skips threads without one", () => {
    expect(
      portTargets([
        thread("1", "h2", "/w/b"),
        thread("2", "h1", "/w/a"),
        thread("3", "h1", "/w/a"),
        thread("4", "h1", null),
        thread("5", null, "/w/c"),
      ]),
    ).toEqual([
      { hostId: "h1", directories: ["/w/a"] },
      { hostId: "h2", directories: ["/w/b"] },
    ]);
  });

  it("is empty when no thread has a directory, so nothing is scanned", () => {
    expect(portTargets([thread("1", "h1", null)])).toEqual([]);
  });
});
