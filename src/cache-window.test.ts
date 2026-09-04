import { describe, expect, it } from "vitest";
import {
  cacheWindowFromMinutes,
  DEFAULT_CACHE_WINDOW,
  isCacheWarning,
} from "./cache-window";

const MINUTE = 60_000;

describe("isCacheWarning", () => {
  const window = cacheWindowFromMinutes(50, 60);

  it("says nothing while the window is comfortably open", () => {
    expect(isCacheWarning(0, window)).toBe(false);
    expect(isCacheWarning(49 * MINUTE, window)).toBe(false);
  });

  it("warns from the threshold on", () => {
    expect(isCacheWarning(50 * MINUTE, window)).toBe(true);
    expect(isCacheWarning(59 * MINUTE, window)).toBe(true);
  });

  // Past the cold edge the window is gone, and a warning about a decision
  // there is nothing left to make is just noise on every stale row.
  it("stops once the window has lapsed", () => {
    expect(isCacheWarning(60 * MINUTE, window)).toBe(false);
    expect(isCacheWarning(5 * 60 * MINUTE, window)).toBe(false);
  });

  it("defaults to the backend's fifty and sixty minutes", () => {
    expect(DEFAULT_CACHE_WINDOW).toEqual({
      warnAfterMs: 50 * MINUTE,
      coldAfterMs: 60 * MINUTE,
    });
  });
});
