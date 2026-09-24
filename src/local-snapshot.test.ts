// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSnapshotStore, parseRows, snapshotKey } from "./local-snapshot";

const schema = { id: "string", at: "number?" } as const;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("snapshot store", () => {
  it("writes the latest rows once, a second after the last change", () => {
    const store = createSnapshotStore<{ id: string; at: number | null }>(
      "t1",
      schema,
    );
    store.schedule(() => [{ id: "a", at: 1 }]);
    store.schedule(() => [{ id: "a", at: 2 }]);
    expect(store.read()).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(store.read()).toEqual([{ id: "a", at: 2 }]);
  });

  it("writes at once when the page is hidden", () => {
    const store = createSnapshotStore<{ id: string; at: number | null }>(
      "t2",
      schema,
    );
    store.schedule(() => [{ id: "a", at: 1 }]);
    window.dispatchEvent(new Event("pagehide"));
    expect(store.read()).toEqual([{ id: "a", at: 1 }]);
  });

  it("keeps only the schema's fields", () => {
    const store = createSnapshotStore<object>("t3", schema);
    store.schedule(() => [{ id: "a", at: 1, extra: "x".repeat(100) }]);
    vi.advanceTimersByTime(1_000);
    expect(store.read()).toEqual([{ id: "a", at: 1 }]);
  });

  // Full storage must not leave an older snapshot to be painted next launch.
  it("removes its key when a write fails", () => {
    const store = createSnapshotStore<{ id: string; at: number | null }>(
      "t4",
      schema,
    );
    store.schedule(() => [{ id: "a", at: 1 }]);
    vi.advanceTimersByTime(1_000);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    store.schedule(() => [{ id: "a", at: 2 }]);
    vi.advanceTimersByTime(1_000);
    expect(store.read()).toBeNull();
  });

  it("clears the keys of an older row shape when it writes", () => {
    localStorage.setItem("bb-plugin:triage-sidebar:t5:old", "[]");
    const store = createSnapshotStore<{ id: string; at: number | null }>(
      "t5",
      schema,
    );
    store.schedule(() => []);
    vi.advanceTimersByTime(1_000);
    expect(localStorage.getItem("bb-plugin:triage-sidebar:t5:old")).toBeNull();
  });

  it("keys a changed schema apart", () => {
    expect(snapshotKey("x", schema)).not.toBe(
      snapshotKey("x", { ...schema, at: "string?" }),
    );
  });
});

describe("parseRows", () => {
  it("rejects the whole snapshot for one bad field", () => {
    expect(
      parseRows([{ id: "a", at: 1 }, { id: "b", at: "soon" }], schema),
    ).toBeNull();
  });

  it("rejects a missing field rather than guessing it", () => {
    expect(parseRows([{ id: "a" }], schema)).toBeNull();
  });

  it("checks an enum", () => {
    const kinds = { kind: ["image", "emoji"] } as const;
    expect(parseRows([{ kind: "emoji" }, { kind: null }], kinds)).toHaveLength(2);
    expect(parseRows([{ kind: "gif" }], kinds)).toBeNull();
  });
});
