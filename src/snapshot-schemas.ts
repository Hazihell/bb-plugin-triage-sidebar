import type { RowSchema } from "./local-snapshot";

/**
 * The rows each first-frame snapshot keeps, field by field. Changing a
 * schema changes its storage key, so a new build never reads rows of an older
 * shape. Kept apart from the hooks that use them so tests can seed a
 * snapshot through the same key.
 */

/** The first frame reads a row's shelf and its idle age, nothing else. */
export const LIFECYCLE_SNAPSHOT: RowSchema = {
  threadId: "string",
  settledAt: "number?",
  snoozedUntil: "number?",
  snoozedAt: "number?",
  startedWorkingAt: "number?",
  lastRunEndedAt: "number?",
};

/** Every field of a stored avatar row; the settings page reads the same map. */
export const AVATAR_SNAPSHOT: RowSchema = {
  projectId: "string",
  customKind: ["monogram", "emoji", "image"],
  customColor: "string?",
  customInitials: "string?",
  customEmoji: "string?",
  customImage: "string?",
  faviconImage: "string?",
  faviconPath: "string?",
  faviconMtime: "number?",
  faviconScannedAt: "number?",
  faviconMissingAt: "number?",
  remoteImage: "string?",
  remoteUrl: "string?",
  fetchedAt: "number?",
  failedAt: "number?",
  failureCount: "number?",
};

export const CACHE_WINDOW_SNAPSHOT: RowSchema = {
  warnAfterMs: "number",
  coldAfterMs: "number",
};
