const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The compact age label on a card: "now", "5m", "2h", "3d", "2w".
 *
 * Deliberately coarse. The exact minute does not help you decide what to look
 * at next, and a precise label would change on every render.
 *
 * Callers pass a cached `now` (the card quantizes it to the minute), so a
 * timestamp sitting exactly on a bucket boundary can read one unit low for up
 * to a minute. That is the accepted cost of a clock that does not churn.
 */
export function relativeTimeLabel(timestamp: number, now: number): string {
  const elapsed = now - timestamp;
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d`;
  return `${Math.floor(elapsed / (7 * DAY))}w`;
}

/**
 * How long a run has been going: "8s", "45s", "3m", "2h".
 *
 * Separate from {@link relativeTimeLabel} because a duration and an age answer
 * different questions. An age under a minute is "now" — near enough that the
 * exact figure is noise. A run under a minute is the opposite: it is the live
 * one, the seconds are the whole point, and "now" reads as though the clock
 * were broken.
 */
export function elapsedLabel(startedAt: number, now: number): string {
  const elapsed = Math.max(0, now - startedAt);
  if (elapsed < MINUTE) return `${Math.floor(elapsed / 1000)}s`;
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  return `${Math.floor(elapsed / DAY)}d`;
}
