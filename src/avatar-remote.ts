/**
 * Deriving a project avatar from its git remote, as pure functions.
 *
 * Everything here is a decision the backend makes before it touches the
 * network: which URL an avatar would come from, and whether it is worth
 * asking for one again. Keeping both out of the fetch routine means the
 * interesting behaviour — host parsing, cache invalidation, backoff — is
 * testable without a socket, a clock, or a database.
 */

/** How long a successful cache stays fresh before it is refetched. */
export const AVATAR_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** Wait after the first failure; each further failure doubles it. */
export const AVATAR_BACKOFF_BASE_MS = 5 * 60 * 1000;

/**
 * Ceiling on the backoff. A host that has refused us ten times in a row is
 * probably private, and a private host will keep refusing — but people do fix
 * permissions, so the retry never stops entirely, it just goes quiet.
 */
export const AVATAR_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Hosts we never ask.
 *
 * A loopback or bare-IP remote is somebody's own machine or a box on their
 * LAN. It will not be serving `/<owner>.png`, and pointing an outbound fetch
 * at an internal address is the kind of request a plugin should not make on
 * its own initiative. The monogram is the right answer for these.
 */
function isPrivateHostname(hostname: string): boolean {
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
  if (isPrivateHostname(parsed.hostname)) return null;

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
 * The order of the checks is the point. A user's own image outranks
 * everything, because fetching for a project whose avatar will never be shown
 * is pure noise on someone else's server. A changed remote outranks the
 * backoff, because the previous failures were about a different host and
 * holding the new one to them would leave a project blank for a day.
 */
export function shouldRefetch(row: AvatarRefetchState, now: number): boolean {
  // The user set a picture; the remote one would never be rendered.
  if (row.customKind === "image" && row.customImage !== null) return false;

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
  return now - row.fetchedAt >= AVATAR_REFRESH_MS;
}
