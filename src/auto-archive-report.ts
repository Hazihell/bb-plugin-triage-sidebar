/**
 * The tally as a sentence.
 *
 * Only the non-zero outcomes are named. A run that archived one thread out of
 * one candidate should say so in a clause, not make the user read four zeros
 * to find the number that moved.
 */
export function summarize({
  days,
  candidates,
  archived,
  skipped,
  unsettled,
  failed,
}: {
  days: number;
  candidates: number;
  archived: { threadId: string; title: string }[];
  skipped: number;
  unsettled: number;
  failed: number;
}): string {
  if (candidates === 0) {
    return `No settled thread has been on the shelf longer than ${days} days, so there was nothing to archive.`;
  }
  const clauses: string[] = [`Archived ${archived.length} of ${candidates}`];
  if (skipped > 0) clauses.push(`skipped ${skipped} still live`);
  if (unsettled > 0) clauses.push(`put ${unsettled} back in the inbox`);
  if (failed > 0) clauses.push(`${failed} failed`);
  return `${clauses.join(", ")}.`;
}

/**
 * "in 3h 20m" — how long until the next sweep.
 *
 * Coarser than a countdown and finer than the card labels: the user is
 * deciding whether to wait or press the button, and "in 3h" is enough to
 * answer that while "in 3h 19m 42s" would churn every second.
 *
 * A due time in the past reads as "any moment now" rather than a negative
 * number: the ticker fires on the hour, so there is always a gap between due
 * and run, and during it the honest answer is that it is about to happen.
 */
export function untilLabel(nextRunAt: number, now: number): string {
  const remaining = nextRunAt - now;
  if (remaining <= 0) return "any moment now";
  const minutes = Math.round(remaining / 60_000);
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `in ${hours}h` : `in ${hours}h ${rest}m`;
}
