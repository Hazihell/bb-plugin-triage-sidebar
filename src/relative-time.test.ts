import { describe, expect, it } from "vitest";
import { elapsedLabel, relativeTimeLabel } from "./relative-time";

const NOW = 1_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("relativeTimeLabel", () => {
  it("reads 'now' under a minute", () => {
    expect(relativeTimeLabel(NOW - 30_000, NOW)).toBe("now");
  });

  it("steps through minutes, hours, days, and weeks", () => {
    expect(relativeTimeLabel(NOW - 5 * MINUTE, NOW)).toBe("5m");
    expect(relativeTimeLabel(NOW - 3 * HOUR, NOW)).toBe("3h");
    expect(relativeTimeLabel(NOW - 2 * DAY, NOW)).toBe("2d");
    expect(relativeTimeLabel(NOW - 20 * DAY, NOW)).toBe("2w");
  });

  it("floors rather than rounds, so a label never overstates age", () => {
    expect(relativeTimeLabel(NOW - (59 * MINUTE + 59_000), NOW)).toBe("59m");
    expect(relativeTimeLabel(NOW - (23 * HOUR + 59 * MINUTE), NOW)).toBe("23h");
  });

  // Clocks disagree across machines, so a thread can carry a timestamp that
  // is slightly in the future. It must not read as a negative age.
  it("treats a future timestamp as 'now'", () => {
    expect(relativeTimeLabel(NOW + 5 * MINUTE, NOW)).toBe("now");
  });
});

describe("elapsedLabel", () => {
  it("counts seconds under a minute, where a run is most likely to be watched", () => {
    expect(elapsedLabel(NOW, NOW)).toBe("0s");
    expect(elapsedLabel(NOW - 8_000, NOW)).toBe("8s");
    expect(elapsedLabel(NOW - 59_000, NOW)).toBe("59s");
  });

  it("switches to coarser units as the run gets long", () => {
    expect(elapsedLabel(NOW - MINUTE, NOW)).toBe("1m");
    expect(elapsedLabel(NOW - 90 * MINUTE, NOW)).toBe("1h");
    expect(elapsedLabel(NOW - 2 * DAY, NOW)).toBe("2d");
  });

  it("floors a clock that runs ahead of the start stamp at zero", () => {
    expect(elapsedLabel(NOW + 5_000, NOW)).toBe("0s");
  });
});
