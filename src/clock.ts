import { useCallback, useSyncExternalStore } from "react";

const SECOND = 1_000;
const MINUTE = 60_000;

export type ClockResolution = "second" | "minute";

/**
 * One clock for the whole sidebar.
 *
 * Every age in the list is quantized to the minute, and only a running turn's
 * timer counts seconds. So there is one timer, not one per row: it ticks each
 * second while any row is counting seconds, and otherwise wakes once per
 * minute, on the minute, so every label in the list turns over together. A
 * subscriber hears only its own resolution: a minute reader is not
 * re-rendered sixty times a minute because some other row is counting.
 */
const subscribers: Record<ClockResolution, Set<() => void>> = {
  second: new Set(),
  minute: new Set(),
};
let now = Date.now();
let timer: ReturnType<typeof setTimeout> | null = null;

function arm(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  const unit =
    subscribers.second.size > 0
      ? SECOND
      : subscribers.minute.size > 0
        ? MINUTE
        : null;
  if (unit === null) return;
  // Just past the boundary, so the tick lands on the new second or minute.
  timer = setTimeout(tick, unit - (Date.now() % unit) + 5);
}

function tick(): void {
  timer = null;
  const previousMinute = Math.floor(now / MINUTE);
  now = Date.now();
  for (const listener of subscribers.second) listener();
  if (Math.floor(now / MINUTE) !== previousMinute) {
    for (const listener of subscribers.minute) listener();
  }
  arm();
}

function read(resolution: ClockResolution): number {
  // Nothing is ticking, so the stored time may be old: read the real one.
  if (timer === null) now = Date.now();
  const unit = resolution === "second" ? SECOND : MINUTE;
  return Math.floor(now / unit) * unit;
}

/**
 * The shared clock, floored to `resolution`. With `enabled` false the caller
 * gets the time once and is never woken, which is how a row with no running
 * turn opts out of the per-second tick.
 */
export function useClock(
  resolution: ClockResolution,
  enabled = true,
): number {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!enabled) return () => {};
      subscribers[resolution].add(listener);
      arm();
      return () => {
        subscribers[resolution].delete(listener);
        arm();
      };
    },
    [enabled, resolution],
  );
  return useSyncExternalStore(subscribe, () => read(resolution));
}
