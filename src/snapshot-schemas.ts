import type { FieldKind } from "./local-snapshot";
import type { ThreadLifecycleRow } from "./lifecycle";
import type { StoredAvatarRow } from "./project-avatar-store";
import type { CacheWindow } from "./cache-window";

/**
 * The rows each first-frame snapshot keeps, field by field. Changing a
 * schema changes its storage key, so a new build never reads rows of an older
 * shape. Kept apart from the hooks that use them so tests can seed a
 * snapshot through the same key.
 *
 * Each schema must name every field of its row type and nothing else, so a
 * field added to a row cannot be dropped from the snapshot unnoticed: the
 * build fails until the schema names it.
 */

/** The first frame reads a row's shelf and its idle age, nothing else. */
export const LIFECYCLE_SNAPSHOT = {
  threadId: "string",
  settledAt: "number?",
  snoozedUntil: "number?",
  snoozedAt: "number?",
  startedWorkingAt: "number?",
  lastRunEndedAt: "number?",
  quietAttentionAt: "number?",
} as const satisfies Record<keyof ThreadLifecycleRow, FieldKind>;

/** Every field of a stored avatar row; the settings page reads the same map. */
export const AVATAR_SNAPSHOT = {
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
} as const satisfies Record<keyof StoredAvatarRow, FieldKind>;

export const CACHE_WINDOW_SNAPSHOT = {
  warnAfterMs: "number",
  coldAfterMs: "number",
} as const satisfies Record<keyof CacheWindow, FieldKind>;
