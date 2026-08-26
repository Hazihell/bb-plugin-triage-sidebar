/**
 * Deriving a project avatar from its git remote, as pure functions.
 *
 * Everything here is a decision the backend makes before it touches the
 * network: which URL an avatar would come from, and whether it is worth
 * asking for one again. Keeping both out of the fetch routine means the
 * interesting behaviour — host parsing, cache invalidation, backoff — is
 * testable without a socket, a clock, or a database.
 */

/** Wait after the first failure; each further failure doubles it. */
export const AVATAR_BACKOFF_BASE_MS = 5 * 60 * 1000;

/**
 * Ceiling on the backoff. A host that has refused us ten times in a row is
 * probably private, and a private host will keep refusing — but people do fix
 * permissions, so the retry never stops entirely, it just goes quiet.
 */
export const AVATAR_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Hosts this plugin never fetches from.
 *
 * A loopback or bare-IP host is somebody's own machine or a box on their LAN.
 * Two callers share this one refusal, so neither can quietly relax it: the
 * git-remote guess must not point an unprompted outbound fetch at an internal
 * address, and a URL the user pastes must not turn a button in Settings into a
 * probe of their own network from inside bb. For the first the monogram is the
 * right answer; for the second an error is.
 *
 * Every IP literal is refused, not only the reserved ranges. `new URL`
 * normalizes the alternative v4 spellings — `127.1`, `0x7f.1`, `2130706433`
 * all arrive here as `127.0.0.1` — so the dotted-quad test is not the hole it
 * looks like; and a host reachable only by address is rare enough that
 * refusing the public ones too costs nothing worth the extra rules.
 */
export function isPrivateAvatarHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // IPv6 arrives from URL as `::1`; from a scp-style remote it cannot appear
  // unbracketed without being ambiguous with the `host:path` separator.
  if (host.includes(":")) return true;
  if (/^\[.*\]$/.test(host)) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

/** A git host can only serve an avatar for a name it could route to. */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

interface ParsedRemote {
  /** Host as it should appear in a URL, port included. */
  host: string;
  hostname: string;
  owner: string;
}

/**
 * The two shapes git remotes actually come in: a URL with a scheme, and the
 * scp-style `git@host:owner/repo.git` that ssh remotes use. The second is not
 * a URL — `new URL` reads `git@github.com:owner/repo.git` as the `git` scheme
 * with everything else as its path — so it needs its own pass.
 */
function parseRemote(gitRemoteUrl: string): ParsedRemote | null {
  const trimmed = gitRemoteUrl.trim();
  if (trimmed === "") return null;

  let host: string;
  let hostname: string;
  let path: string;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (url.hostname === "") return null;
    host = url.host;
    hostname = url.hostname;
    path = url.pathname;
  } else {
    const scp = /^(?:[^@/\s]+@)?([^@/:\s]+):(.+)$/.exec(trimmed);
    if (scp === null) return null;
    host = scp[1]!;
    hostname = host;
    path = scp[2]!;
  }

  const segments = path
    .replace(/\.git\/?$/i, "")
    .split("/")
    .filter((segment) => segment !== "");
  // Owner alone is not a repository, and a remote we cannot read as
  // owner/repo is one we have no business guessing about.
  if (segments.length < 2) return null;

  const owner = segments[0]!;
  if (!OWNER_PATTERN.test(owner)) return null;

  return { host: host.toLowerCase(), hostname: hostname.toLowerCase(), owner };
}

/**
 * The URL that would serve the owner's avatar for a git remote, or null when
 * there is nothing sensible to ask for.
 *
 * `/<owner>.png` is a convention both GitLab and Gitea serve, so a generic
 * host gets that guess rather than no avatar at all; if the host does not
 * serve it, the fetch fails, the backoff takes over, and the frontend draws a
 * monogram. GitHub is the one host worth special-casing, because it accepts a
 * size and returns a much smaller image than its default.
 */
export function remoteAvatarUrl(gitRemoteUrl: string | null): string | null {
  if (gitRemoteUrl === null) return null;
  const parsed = parseRemote(gitRemoteUrl);
  if (parsed === null) return null;
  if (isPrivateAvatarHost(parsed.hostname)) return null;

  if (parsed.host === "github.com" || parsed.host === "www.github.com") {
    return `https://github.com/${parsed.owner}.png?size=128`;
  }
  // Always https, even for an http or git remote: this is a request the user
  // did not type, so it should not be one that travels in the clear.
  return `https://${parsed.host}/${parsed.owner}.png`;
}

/**
 * What the refetch decision needs to know.
 *
 * `desiredUrl` is not a stored column — it is what {@link remoteAvatarUrl}
 * says the remote should point at right now. Invalidation is a comparison
 * between the two sides, so a function given only the stored side could not
 * answer; it travels with the row instead of being fetched here, because this
 * module reads no state of its own.
 */
export interface AvatarRefetchState {
  customKind: string | null;
  customImage: string | null;
  /** The icon read out of the project's own checkout, if it has one. */
  faviconImage: string | null;
  remoteImage: string | null;
  remoteUrl: string | null;
  fetchedAt: number | null;
  failedAt: number | null;
  failureCount: number | null;
  desiredUrl: string | null;
}

/** Backoff delay owed after `failureCount` consecutive failures. */
export function backoffDelayMs(failureCount: number): number {
  if (failureCount <= 0) return 0;
  // 2 ** 40 is still finite, but the shift below caps long before that.
  const doublings = Math.min(failureCount - 1, 40);
  return Math.min(
    AVATAR_BACKOFF_BASE_MS * 2 ** doublings,
    AVATAR_BACKOFF_MAX_MS,
  );
}

/**
 * Whether the sweep should go and ask the host for this project's avatar.
 *
 * The order of the checks is the point. Anything that already outranks the
 * host's image comes first, because fetching for a project whose avatar will
 * never be shown is pure noise on someone else's server. A changed remote
 * outranks the backoff, because the previous failures were about a different
 * host and holding the new one to them would leave a project blank for a day.
 */
export function shouldRefetch(row: AvatarRefetchState, now: number): boolean {
  // The user set a picture; the remote one would never be rendered.
  if (row.customKind === "image" && row.customImage !== null) return false;

  // Same reasoning, one rank down: the project's own favicon is drawn instead
  // of the host's image, so this is a request for a picture nobody sees. This
  // lives here rather than beside the call because "is the fetch worth making"
  // is one question, and splitting it across two gates is how the two answers
  // start to disagree.
  if (row.faviconImage !== null) return false;

  if (row.desiredUrl === null) return false;

  // The project moved hosts or owners. Whatever is cached describes someone
  // else, so it is invalid immediately rather than at the next refresh.
  if (row.remoteUrl !== row.desiredUrl) return true;

  const failureCount = row.failureCount ?? 0;
  if (row.failedAt !== null && failureCount > 0) {
    if (now - row.failedAt < backoffDelayMs(failureCount)) return false;
    return true;
  }

  if (row.remoteImage === null) return true;
  if (row.fetchedAt === null) return true;

  // A picture that already arrived is never asked for again, however old it
  // is. An org avatar changes about once a year, and a sweep that re-asks on a
  // timer spends the user's traffic — on someone else's server — for a change
  // nobody is waiting on. The Settings panel has a per-project refresh for the
  // day it does change.
  return false;
}

/**
 * Why a pasted avatar URL was refused, for a caller that has to word it.
 *
 * Three reasons rather than one boolean, because each asks the user for a
 * different fix and a single "bad URL" would leave them guessing which.
 */
export type UserAvatarUrlRefusal = "unparseable" | "scheme" | "private-host";

export type UserAvatarUrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: UserAvatarUrlRefusal };

/**
 * Whether a URL the user typed is one the server will go and fetch.
 *
 * Unlike {@link remoteAvatarUrl} this keeps the scheme it was given: the user
 * named this host, so an `http://` intranet forge they chose is their call to
 * make. Everything that is not http or https is refused outright — `file:`
 * would read this machine's disk and `data:` would smuggle the image past the
 * fetch routine's checks, and neither is a thing a URL field should do.
 */
export function checkUserAvatarUrl(raw: string): UserAvatarUrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "scheme" };
  }
  if (url.hostname === "" || isPrivateAvatarHost(url.hostname)) {
    return { ok: false, reason: "private-host" };
  }
  return { ok: true, url: url.toString() };
}
