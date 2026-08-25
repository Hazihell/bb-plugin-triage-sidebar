/**
 * The identity of a project, reduced to one small square.
 *
 * A sidebar row already says which project a thread belongs to, in words. The
 * avatar is not there to repeat that: it is there so the eye can group rows
 * before it reads any of them. That is why colour is derived from the project
 * id rather than the name — a rename must not repaint the sidebar, because the
 * user has already learned "the teal one is work".
 *
 * Four sources, in order: an avatar the user set by hand, the icon this
 * project ships in its own checkout, an image cached from the git remote host
 * (the GitHub org's logo, say), and a generated monogram. The order is intent
 * first, then the project's own answer, then the world's, then ours.
 *
 * The favicon sits above the host's image because the two identify different
 * things. A favicon is the project's own mark; a host avatar belongs to the
 * ORG that owns the repository, so every project under one organization would
 * otherwise wear the same face — which is precisely what this chip exists to
 * prevent.
 */

/**
 * What this plugin has recorded for one project.
 *
 * Every field is optional AND nullable: the row is written by more than one
 * path (a user action, a background fetch of the remote's avatar), and a store
 * that has only ever seen one of them should not have to invent the rest.
 * `undefined` means "no row yet", `null` means "recorded, and empty".
 */
export type StoredProjectAvatar = {
  /**
   * Which custom avatar the user chose. Kept explicitly rather than inferred
   * from which field is filled, so clearing an image back to a monogram does
   * not have to erase the image the user may want back tomorrow.
   */
  customKind?: "image" | "emoji" | "monogram" | null;
  /** A colour the user picked, overriding the hashed hue. Any CSS colour. */
  customColor?: string | null;
  /** Letters the user typed, overriding the ones derived from the name. */
  customInitials?: string | null;
  customEmoji?: string | null;
  /** A user-supplied image: a data URL, or a URL bb can load. */
  customImage?: string | null;
  /**
   * An icon read out of the project's own folder on this machine — its
   * favicon — cached by this plugin.
   */
  faviconImage?: string | null;
  /**
   * Where that icon came from, relative to the project root. Kept for the
   * user, not for the renderer: when the wrong icon appears, the path is the
   * only thing that explains why, and the only thing they can act on.
   */
  faviconPath?: string | null;
  /** An image fetched from the git remote host and cached by this plugin. */
  remoteImage?: string | null;
};

/** The minimum a caller must know about a project to draw its avatar. */
export type AvatarProject = {
  id: string;
  name: string;
};

export type ResolvedProjectAvatar =
  | { kind: "image"; src: string }
  | { kind: "emoji"; emoji: string; background: string }
  | { kind: "monogram"; initials: string; background: string };

/**
 * The generated background: one fixed lightness and chroma, hue from the id.
 *
 * L = 0.54 and C = 0.09 are not taste, they are the two constraints this chip
 * has to satisfy at once, and they were picked by sweeping the pair over all
 * 360 hues:
 *
 * - White text must stay readable on EVERY hue, not the average one. At these
 *   values the worst hue (a cyan-green near 175) still clears 4.8:1 against
 *   white, above the 4.5:1 bar for small text. Push L to 0.58 and that hue
 *   drops to 4.1:1 — a monogram that is legible on blue and mud on teal.
 * - Every hue must land inside the sRGB gamut. At C = 0.11 roughly sixty hues
 *   fall outside it and the browser gamut-maps them, which quietly collapses
 *   the hue spacing this palette depends on. C = 0.09 is the largest chroma
 *   where all 360 hues survive intact.
 *
 * The low chroma also earns its keep visually: these chips sit next to muted
 * sidebar text, and a saturated square would pull the eye away from the status
 * column, which is the one thing in this list that is supposed to shout.
 *
 * `src/project-avatar.test.ts` re-runs both checks over every hue, so a future
 * tweak to these numbers fails loudly rather than silently.
 */
const AVATAR_LIGHTNESS = 0.54;
const AVATAR_CHROMA = 0.09;

export function avatarBackground(hue: number): string {
  // Wrap rather than clamp: hue is an angle, so 400 is 40, and a caller doing
  // its own rotation should not have to know that.
  const wrapped = ((hue % 360) + 360) % 360;
  return `oklch(${AVATAR_LIGHTNESS} ${AVATAR_CHROMA} ${wrapped})`;
}

/**
 * A stable hue for a project id.
 *
 * FNV-1a over UTF-16 code units, with `Math.imul` so the multiply stays 32-bit
 * on every engine. Integer arithmetic end to end: no floats, no locale, no
 * platform hash — the same id has to produce the same colour on the user's
 * laptop, on their desktop, and after an update, forever. This colour is
 * something people memorize, so changing the function later is a visual
 * migration, not a refactor.
 *
 * Deliberately not shared with `hashHue` in Disc.tsx. That one colours threads
 * and this one colours projects; they sit next to each other in the same row,
 * and tuning either palette must not repaint the other.
 */
export function projectHue(projectId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < projectId.length; index += 1) {
    hash ^= projectId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

/**
 * Words, for the purpose of a monogram.
 *
 * Project names are not prose. They are directory names, repo slugs and
 * hurried phrases: "bb-plugin_triage", "MyCoolApp", "captouro". So separators
 * are anything that is not a letter, a digit or a combining mark, and a
 * lower-to-upper transition counts as a boundary too.
 *
 * Combining marks (`\p{M}`) stay INSIDE words: in Devanagari or Thai the mark
 * is part of the letter, and treating it as punctuation would cut a character
 * in half.
 */
const APOSTROPHES = /['’ʼ`]/gu;
const CAMEL_BOUNDARY = /(\p{Ll}|\p{N})(\p{Lu})/gu;
/**
 * The end of an acronym, where the next word starts: "APIServer" is two words
 * to a reader, and a run of capitals on its own ("API") is still one.
 */
const ACRONYM_BOUNDARY = /(\p{Lu})(\p{Lu}\p{Ll})/gu;
const SEPARATORS = /[^\p{L}\p{N}\p{M}]+/gu;

function splitWords(name: string): string[] {
  return name
    // Apostrophes vanish instead of splitting, so "Roger's app" is two words
    // and not three.
    .replace(APOSTROPHES, "")
    .replace(ACRONYM_BOUNDARY, "$1 $2")
    .replace(CAMEL_BOUNDARY, "$1 $2")
    .replace(SEPARATORS, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 0);
}

/**
 * User-perceived characters, not code units.
 *
 * An emoji, a Devanagari cluster and a flag are each one character to a reader
 * and two to five units to JavaScript. `Intl.Segmenter` is the only thing that
 * knows the difference. The fallback matters only on an engine old enough to
 * lack it, where a code point is still better than a code unit.
 */
function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

function firstGrapheme(word: string): string {
  return graphemes(word)[0] ?? "";
}

/**
 * Uppercase, unless uppercasing is a lie.
 *
 * Most scripts have no case at all, so this is a no-op for them and must stay
 * one. The case that bites is the expanding one: German "ß" uppercases to
 * "SS", turning a one-letter monogram into two and breaking the box's width
 * budget. When the result grows, keep the original.
 */
function monogramCase(grapheme: string): string {
  const upper = grapheme.toUpperCase();
  return Array.from(upper).length > Array.from(grapheme).length
    ? grapheme
    : upper;
}

/**
 * One letter for a single word, two for several.
 *
 * Two letters is the ceiling because the chip is 14px wide at its smallest; a
 * third letter would either overflow or shrink the type below reading size.
 *
 * An unnameable project returns "" rather than a "?" placeholder: the coloured
 * square is already a valid identity, and a question mark reads as an error
 * the user cannot fix.
 */
export function projectInitials(name: string): string {
  const words = splitWords(name);
  if (words.length === 0) return "";
  if (words.length === 1) return monogramCase(firstGrapheme(words[0]));
  return (
    monogramCase(firstGrapheme(words[0])) +
    monogramCase(firstGrapheme(words[1]))
  );
}

/** Blank strings count as unset: an empty column is not a choice. */
function present(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function backgroundFor(
  project: AvatarProject,
  stored: StoredProjectAvatar | undefined,
): string {
  return (
    present(stored?.customColor) ?? avatarBackground(projectHue(project.id))
  );
}

/**
 * The monogram this project falls back to, exported because it is a fallback
 * twice over: once here when nothing else resolves, and once in the component
 * when an image that resolved refuses to load.
 */
export function projectMonogram(
  project: AvatarProject,
  stored?: StoredProjectAvatar,
): Extract<ResolvedProjectAvatar, { kind: "monogram" }> {
  // Custom initials are capped at two graphemes for the same width reason the
  // generated ones are, rather than trusting whatever was typed into a field.
  const custom = present(stored?.customInitials);
  const initials = custom
    ? graphemes(custom).slice(0, 2).join("")
    : projectInitials(project.name);
  return {
    kind: "monogram",
    initials,
    background: backgroundFor(project, stored),
  };
}

/**
 * User intent, then the project's own icon, then the remote's image, then a
 * monogram.
 *
 * A user who set a monogram gets a monogram even when a remote image is
 * cached: the remote is a convenience, and the moment someone overrides it the
 * override has to stick, or the next background fetch silently undoes their
 * choice.
 *
 * A `customKind` naming a field that is empty falls through instead of
 * rendering nothing — half-written rows happen, and an empty square is a bug
 * the user cannot diagnose.
 */
export function resolveProjectAvatar(
  project: AvatarProject,
  stored?: StoredProjectAvatar,
): ResolvedProjectAvatar {
  const customImage = present(stored?.customImage);
  const customEmoji = present(stored?.customEmoji);
  const kind = stored?.customKind ?? null;

  if (kind === "monogram") return projectMonogram(project, stored);
  if (kind === "image" && customImage) return { kind: "image", src: customImage };
  if (kind === "emoji" && customEmoji) {
    return {
      kind: "emoji",
      emoji: customEmoji,
      background: backgroundFor(project, stored),
    };
  }

  // No recorded kind: infer from what is filled in. Older rows predate the
  // column, and a store written by a different version of this plugin should
  // still render the avatar its user picked.
  if (kind === null) {
    if (customImage) return { kind: "image", src: customImage };
    if (customEmoji) {
      return {
        kind: "emoji",
        emoji: customEmoji,
        background: backgroundFor(project, stored),
      };
    }
  }

  const faviconImage = present(stored?.faviconImage);
  if (faviconImage) return { kind: "image", src: faviconImage };

  const remoteImage = present(stored?.remoteImage);
  if (remoteImage) return { kind: "image", src: remoteImage };

  return projectMonogram(project, stored);
}
