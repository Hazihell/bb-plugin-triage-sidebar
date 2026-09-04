/**
 * The prompt-cache window, as the sidebar reads it.
 *
 * An idle thread's age is not only trivia about when you last spoke to it: an
 * agent's prompt cache lapses on a timer, so the age says whether the next
 * reply resumes cheaply or pays for a full re-read. This module owns the one
 * judgement that follows from that — when the age is worth colouring — and
 * nothing else, so the rule can be read and tested without a component.
 *
 * The band is closed at the top on purpose. Past the cold threshold the window
 * has already gone, and an age that stayed amber would go on warning about a
 * decision there is nothing left to make.
 */

const MINUTE_MS = 60_000;

export interface CacheWindow {
  warnAfterMs: number;
  coldAfterMs: number;
}

/** Mirrors the backend's defaults, for the moment before the settings land. */
export const DEFAULT_CACHE_WINDOW: CacheWindow = {
  warnAfterMs: 50 * MINUTE_MS,
  coldAfterMs: 60 * MINUTE_MS,
};

export function cacheWindowFromMinutes(
  warnAfterMinutes: number,
  coldAfterMinutes: number,
): CacheWindow {
  return {
    warnAfterMs: warnAfterMinutes * MINUTE_MS,
    coldAfterMs: coldAfterMinutes * MINUTE_MS,
  };
}

/** Whether an idle age falls inside the warning band. */
export function isCacheWarning(ageMs: number, window: CacheWindow): boolean {
  return ageMs >= window.warnAfterMs && ageMs < window.coldAfterMs;
}
