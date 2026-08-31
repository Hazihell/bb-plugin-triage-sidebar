// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyReapSummary, type AutoArchiveSweepResult } from "./server";
import { summarize, untilLabel } from "./auto-archive-report";

const app = await loadPluginApp(() => import("../app"));
const section = app.settingsSections.find((s) => s.id === "auto-archive")!;

afterEach(cleanup);

function sweep(
  overrides: Partial<AutoArchiveSweepResult> = {},
): AutoArchiveSweepResult {
  return {
    enabled: true,
    days: 7,
    candidates: 0,
    archived: [],
    skipped: 0,
    unsettled: 0,
    reaped: emptyReapSummary(false),
    forgotten: 0,
    failed: 0,
    ...overrides,
  };
}

const NOW = Date.UTC(2026, 7, 27, 14, 30);

function status(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    intervalHours: 4,
    days: 7,
    lastRunAt: Date.UTC(2026, 7, 27, 12),
    nextRunAt: Date.UTC(2026, 7, 27, 16),
    now: NOW,
    ...overrides,
  };
}

const render = (
  runAutoArchive: () => unknown,
  autoArchiveStatus: () => unknown = () => status(),
) => renderSlot(section, {}, { rpc: { runAutoArchive, autoArchiveStatus } as never });

const runNow = () => fireEvent.click(screen.getByRole("button", { name: "Run now" }));

describe("running the sweep from Settings", () => {
  it("names every thread it archived", async () => {
    render(() =>
      sweep({
        candidates: 2,
        archived: [
          { threadId: "thr_a", title: "Fix the flake" },
          { threadId: "thr_b", title: "Bump deps" },
        ],
      }),
    );
    runNow();
    await screen.findByText("Fix the flake");
    screen.getByText("Bump deps");
  });

  // The ordinary outcome. Without this sentence the user cannot tell a sweep
  // that found nothing from one that never ran.
  it("says so when nothing was old enough", async () => {
    render(() => sweep());
    runNow();
    await screen.findByText(/nothing to archive/);
  });

  // The switch being off is the reason there is no result, not a result.
  it("points at the setting when auto-archive is off", async () => {
    render(() => sweep({ enabled: false }));
    runNow();
    await screen.findByText(/turned off/);
  });

  it("reports a sweep that could not run", async () => {
    render(() => {
      throw new Error("backend is down");
    });
    runNow();
    await screen.findByText(/could not run/);
  });

  // A second click while the first is in flight would run the sweep twice and
  // race two archives over the same candidates.
  it("disables the button while a run is in flight", async () => {
    let release: (value: AutoArchiveSweepResult) => void = () => {};
    render(() => new Promise((resolve) => (release = resolve)));
    runNow();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Running…" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    release(sweep());
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Run now" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });
});

describe("the next run", () => {
  it("shows when the next sweep happens and on what rhythm", async () => {
    render(() => sweep());
    // The clock time is rendered in the runner's local zone, so this asserts
    // on the parts that do not move: the countdown and the interval.
    await screen.findByText(/in 1h 30m/);
    screen.getByText(/every 4h/);
    screen.getByText(/7 days/);
  });

  // Nothing is scheduled when the switch is off, and a time would imply
  // otherwise.
  it("says nothing is scheduled when auto-archive is off", async () => {
    render(() => sweep(), () => status({ enabled: false }));
    await screen.findByText(/no sweep is scheduled/);
  });

  // The panel is still usable without it: the button is the point, the
  // countdown is a courtesy.
  it("leaves the line out when the status cannot be read", async () => {
    render(
      () => sweep(),
      () => {
        throw new Error("nope");
      },
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run now" })).toBeTruthy(),
    );
    expect(screen.queryByText(/Next sweep/)).toBeNull();
  });
});

describe("untilLabel", () => {
  const now = 0;
  const min = 60_000;

  it("reads in minutes under an hour and in hours above it", () => {
    expect(untilLabel(45 * min, now)).toBe("in 45m");
    expect(untilLabel(120 * min, now)).toBe("in 2h");
    expect(untilLabel(150 * min, now)).toBe("in 2h 30m");
  });

  // Due and run are never the same instant, so the gap needs a reading of its
  // own rather than a negative number.
  it("reads a time already passed as imminent", () => {
    expect(untilLabel(-5 * min, now)).toBe("any moment now");
  });
});

describe("summarize", () => {
  const base = { days: 7, candidates: 1, archived: [], skipped: 0, unsettled: 0, failed: 0 };

  it("names only the outcomes that happened", () => {
    expect(
      summarize({
        ...base,
        candidates: 3,
        archived: [{ threadId: "a", title: "A" }],
        skipped: 2,
      }),
    ).toBe("Archived 1 of 3, skipped 2 still live.");
  });

  it("reads the retention period back when there were no candidates", () => {
    expect(summarize({ ...base, candidates: 0, days: 30 })).toContain("30 days");
  });
});
