import { describe, expect, it } from "vitest";
import { holdOrder } from "./useOrderFreeze";
import { planFlights } from "./useFlipReorder";

const rows = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((row) => row.id);

describe("holdOrder", () => {
  it("keeps the order the user was looking at", () => {
    expect(ids(holdOrder(["a", "b", "c"], rows("c", "a", "b")))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  // Settling is the user's own act, and an archived row is gone: neither
  // waits for the freeze to end.
  it("drops a row that left at once", () => {
    expect(ids(holdOrder(["a", "b", "c"], rows("c", "a")))).toEqual(["a", "c"]);
  });

  // Below everything the user might be about to click, never above it.
  it("puts a row that arrived at the end", () => {
    expect(ids(holdOrder(["a", "b"], rows("new", "b", "a")))).toEqual([
      "a",
      "b",
      "new",
    ]);
  });
});

describe("planFlights", () => {
  const tops = (entries: Record<string, number>) =>
    new Map(Object.entries(entries));

  it("flies a row that moved, from where it was", () => {
    expect(planFlights(tops({ a: 0, b: 60 }), tops({ a: 60, b: 0 }))).toEqual([
      { id: "a", from: -60 },
      { id: "b", from: 60 },
    ]);
  });

  // The double-play bug: a later commit that moved nothing — a clock tick, a
  // second message about the same change — must not launch the row again.
  it("launches nothing on a commit that moved nothing", () => {
    expect(
      planFlights(tops({ a: 60, b: 0 }), tops({ a: 60, b: 0 }), () => 30),
    ).toEqual([]);
  });

  // Moved again mid-flight: start from where it is painted, not from its
  // old slot, so it turns rather than jumps.
  it("starts a second move from the painted position", () => {
    expect(
      planFlights(tops({ a: 60 }), tops({ a: 120 }), (id) =>
        id === "a" ? -25 : 0,
      ),
    ).toEqual([{ id: "a", from: -85 }]);
  });

  it("never flies a row it has not seen before", () => {
    expect(planFlights(tops({}), tops({ a: 0 }))).toEqual([]);
  });

  it("ignores sub-pixel drift", () => {
    expect(planFlights(tops({ a: 10 }), tops({ a: 10.5 }))).toEqual([]);
  });
});
