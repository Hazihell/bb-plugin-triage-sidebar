/**
 * The last state this client saw, kept in localStorage so the next launch can
 * paint it on its first frame.
 *
 * Without it the sidebar's first frame is wrong in a way the user can see:
 * the host's threads arrive at once, but the parking store and the avatars
 * are a round trip away, so settled threads sit in the inbox and avatars are
 * monograms until they land, and then everything jumps. A snapshot makes the
 * first frame the list the user last saw; the live read replaces it a moment
 * later, and only what really changed meanwhile moves.
 *
 * A snapshot is a cache, never a source of truth: unreadable, malformed or
 * missing, it is simply absent, and a write that fails (quota, private mode)
 * is dropped. Keys carry a version, so a change of shape starts clean.
 */
const PREFIX = "bb-plugin:triage-sidebar:";

export function readSnapshot<T>(
  key: string,
  parse: (value: unknown) => T | null,
): T | null {
  try {
    const raw = storage()?.getItem(PREFIX + key);
    if (raw == null) return null;
    return parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeSnapshot(key: string, value: unknown): void {
  try {
    storage()?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Full or unavailable: the next launch reads the store instead.
  }
}

function storage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
