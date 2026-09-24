// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useClock } from "./clock";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-24T10:00:00.000Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useClock", () => {
  it("runs one timer however many rows count seconds", () => {
    renderHook(() => useClock("second"));
    renderHook(() => useClock("second"));
    renderHook(() => useClock("minute"));
    expect(vi.getTimerCount()).toBe(1);
  });

  it("wakes a minute reader once a minute, not every second", () => {
    let minuteRenders = 0;
    renderHook(() => useClock("second"));
    const minute = renderHook(() => {
      minuteRenders += 1;
      return useClock("minute");
    });
    const before = minuteRenders;
    act(() => vi.advanceTimersByTime(59_000));
    expect(minuteRenders).toBe(before);
    act(() => vi.advanceTimersByTime(2_000));
    expect(minuteRenders).toBe(before + 1);
    expect(minute.result.current).toBe(Date.parse("2026-09-24T10:01:00.000Z"));
  });

  it("ticks a seconds reader every second", () => {
    const seconds = renderHook(() => useClock("second"));
    // Each tick lands just past its second.
    act(() => vi.advanceTimersByTime(3_010));
    expect(seconds.result.current).toBe(Date.parse("2026-09-24T10:00:03.000Z"));
  });

  // A row with no running turn opts out, and nothing ticks for it.
  it("arms nothing for a reader that is not counting", () => {
    renderHook(() => useClock("second", false));
    expect(vi.getTimerCount()).toBe(0);
  });
});
