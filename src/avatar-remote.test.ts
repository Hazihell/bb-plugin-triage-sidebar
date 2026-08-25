import { describe, expect, it } from "vitest";
import {
  AVATAR_BACKOFF_BASE_MS,
  AVATAR_BACKOFF_MAX_MS,
  AVATAR_REFRESH_MS,
  backoffDelayMs,
  remoteAvatarUrl,
  shouldRefetch,
  type AvatarRefetchState,
} from "./avatar-remote";

describe("remoteAvatarUrl", () => {
  it("reads an https remote", () => {
    expect(remoteAvatarUrl("https://github.com/get-bb/bb.git")).toBe(
      "https://github.com/get-bb.png?size=128",
    );
    // A remote copied out of a browser has no .git suffix.
    expect(remoteAvatarUrl("https://github.com/get-bb/bb")).toBe(
      "https://github.com/get-bb.png?size=128",
    );
  });

  it("reads an scp-style ssh remote", () => {
    expect(remoteAvatarUrl("git@github.com:get-bb/bb.git")).toBe(
      "https://github.com/get-bb.png?size=128",
    );
    expect(remoteAvatarUrl("ssh://git@github.com/get-bb/bb.git")).toBe(
      "https://github.com/get-bb.png?size=128",
    );
  });

  it("guesses /<owner>.png on any other host", () => {
    expect(remoteAvatarUrl("https://gitlab.com/group/repo.git")).toBe(
      "https://gitlab.com/group.png",
    );
    expect(remoteAvatarUrl("git@gitea.example.org:team/repo.git")).toBe(
      "https://gitea.example.org/team.png",
    );
  });

  it("keeps a non-default port, which self-hosted forges use", () => {
    expect(remoteAvatarUrl("https://git.example.org:3000/team/repo.git")).toBe(
      "https://git.example.org:3000/team.png",
    );
  });

  // The user did not type this request, so it should not travel in the clear
  // even when their remote does.
  it("always asks over https", () => {
    expect(remoteAvatarUrl("http://git.example.org/team/repo.git")).toBe(
      "https://git.example.org/team.png",
    );
  });

  it("takes the top-level group of a nested gitlab path", () => {
    expect(remoteAvatarUrl("https://gitlab.com/top/sub/repo.git")).toBe(
      "https://gitlab.com/top.png",
    );
  });

  it("has nothing to ask for without a remote", () => {
    expect(remoteAvatarUrl(null)).toBeNull();
    expect(remoteAvatarUrl("")).toBeNull();
    expect(remoteAvatarUrl("   ")).toBeNull();
  });

  it("refuses a remote it cannot read as owner/repo", () => {
    expect(remoteAvatarUrl("not a url")).toBeNull();
    expect(remoteAvatarUrl("/srv/git/repo.git")).toBeNull();
    expect(remoteAvatarUrl("https://github.com/onlyowner")).toBeNull();
    expect(remoteAvatarUrl("file:///srv/git/repo.git")).toBeNull();
  });

  // A loopback or bare-IP remote is the user's own machine or their LAN:
  // it will not serve an avatar, and it is not somewhere to send a request.
  it("refuses localhost and IP hosts", () => {
    expect(remoteAvatarUrl("http://localhost:3000/team/repo.git")).toBeNull();
    expect(remoteAvatarUrl("git@localhost:team/repo.git")).toBeNull();
    expect(remoteAvatarUrl("https://192.168.1.10/team/repo.git")).toBeNull();
    expect(remoteAvatarUrl("git@127.0.0.1:team/repo.git")).toBeNull();
    expect(remoteAvatarUrl("http://[::1]:3000/team/repo.git")).toBeNull();
  });
});

const NOW = 1_700_000_000_000;

const state = (overrides: Partial<AvatarRefetchState>): AvatarRefetchState => ({
  customKind: null,
  customImage: null,
  remoteImage: null,
  remoteUrl: null,
  fetchedAt: null,
  failedAt: null,
  failureCount: null,
  desiredUrl: "https://github.com/get-bb.png?size=128",
  ...overrides,
});

describe("backoffDelayMs", () => {
  it("doubles from the base and stops at a day", () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(1)).toBe(AVATAR_BACKOFF_BASE_MS);
    expect(backoffDelayMs(2)).toBe(AVATAR_BACKOFF_BASE_MS * 2);
    expect(backoffDelayMs(3)).toBe(AVATAR_BACKOFF_BASE_MS * 4);
    expect(backoffDelayMs(50)).toBe(AVATAR_BACKOFF_MAX_MS);
  });
});

describe("shouldRefetch", () => {
  it("fetches a project it has never fetched", () => {
    expect(shouldRefetch(state({}), NOW)).toBe(true);
  });

  it("leaves a project whose remote gives no avatar url alone", () => {
    expect(shouldRefetch(state({ desiredUrl: null }), NOW)).toBe(false);
  });

  // The user's own picture wins at render time, so asking the host for one
  // is noise on somebody else's server.
  it("never fetches for a project with a custom image", () => {
    expect(
      shouldRefetch(
        state({ customKind: "image", customImage: "data:image/png;base64,AA" }),
        NOW,
      ),
    ).toBe(false);
  });

  it("still fetches behind a custom colour or emoji", () => {
    expect(
      shouldRefetch(state({ customKind: "color" }), NOW),
    ).toBe(true);
  });

  it("keeps a fresh cache", () => {
    expect(
      shouldRefetch(
        state({
          remoteImage: "data:image/png;base64,AA",
          remoteUrl: "https://github.com/get-bb.png?size=128",
          fetchedAt: NOW - 1000,
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it("refreshes a cache older than a week", () => {
    expect(
      shouldRefetch(
        state({
          remoteImage: "data:image/png;base64,AA",
          remoteUrl: "https://github.com/get-bb.png?size=128",
          fetchedAt: NOW - AVATAR_REFRESH_MS - 1,
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it("waits out the backoff after a failure, then tries again", () => {
    const failed = state({
      remoteUrl: "https://github.com/get-bb.png?size=128",
      failedAt: NOW - AVATAR_BACKOFF_BASE_MS + 1,
      failureCount: 1,
    });
    expect(shouldRefetch(failed, NOW)).toBe(false);
    expect(shouldRefetch(failed, NOW + AVATAR_BACKOFF_BASE_MS)).toBe(true);
  });

  it("backs off further with each consecutive failure", () => {
    const failed = state({
      remoteUrl: "https://github.com/get-bb.png?size=128",
      failedAt: NOW - AVATAR_BACKOFF_BASE_MS * 3,
      failureCount: 4,
    });
    expect(shouldRefetch(failed, NOW)).toBe(false);
  });

  // Those failures were about a different host; holding the new remote to
  // them would leave the project blank for up to a day.
  it("ignores the backoff when the remote changed", () => {
    expect(
      shouldRefetch(
        state({
          remoteUrl: "https://gitlab.com/old.png",
          failedAt: NOW,
          failureCount: 9,
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it("invalidates a cache fetched from a different url", () => {
    expect(
      shouldRefetch(
        state({
          remoteImage: "data:image/png;base64,AA",
          remoteUrl: "https://github.com/previous-owner.png?size=128",
          fetchedAt: NOW,
        }),
        NOW,
      ),
    ).toBe(true);
  });
});
