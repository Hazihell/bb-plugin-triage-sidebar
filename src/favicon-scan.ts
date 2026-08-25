/**
 * Choosing a project's own icon out of its checkout, as pure functions.
 *
 * A favicon identifies the PROJECT. The avatar fetched from a git host
 * identifies the org that owns it, so every repository under one org wears the
 * same face — which is the one thing a project avatar exists to prevent. That
 * is why a favicon found here outranks the host's image.
 *
 * Nothing in this file touches a disk. It is handed the names a directory
 * listing produced and answers which of them to read, so the interesting part
 * — the ranking, and what counts as a place worth looking — is testable
 * without a fixture tree, a platform, or a filesystem at all.
 */

/**
 * Where an icon is allowed to live, relative to the project root.
 *
 * A fixed list, not a walk. A recursive search of a repository would find
 * every icon in every test fixture, node_modules copy and vendored asset
 * directory, and the wrong icon is worse than no icon: the user cannot tell
 * where it came from and has nothing to fix. These are the directories the web
 * frameworks actually serve static files from, and `""` — the root — is where
 * a plain static site keeps its favicon.
 */
export const FAVICON_DIRECTORIES: readonly string[] = [
  "",
  "public",
  "static",
  "assets",
  "app",
  "src",
  "src/assets",
  "resources",
  "www",
];

/**
 * The one shape of nesting worth following: a monorepo's `apps/<name>/public`
 * and `packages/<name>/public`.
 *
 * One level, and only under a `public` directory. A monorepo's root has no
 * favicon of its own — the icon belongs to one of the apps — so refusing to
 * descend at all would leave exactly the repositories with the most projects
 * in them wearing their org's logo.
 */
export const MONOREPO_PARENTS: readonly string[] = ["apps", "packages"];

/** The only child directory of a monorepo member that is searched. */
export const MONOREPO_CHILD_DIRECTORY = "public";

const MONOREPO_PATTERN = new RegExp(
  `^(?:${MONOREPO_PARENTS.join("|")})/[^/]+/${MONOREPO_CHILD_DIRECTORY}$`,
);

/**
 * Every directory to list, given what the monorepo parents actually contain.
 *
 * The caller supplies the children because reading them is a filesystem
 * question; this keeps the list of places in one file with the rules about
 * them, so a reader never has to check whether the scanner and the validator
 * agree.
 */
export function faviconSearchDirectories(
  monorepoChildren: Readonly<Record<string, readonly string[]>> = {},
): string[] {
  const nested = MONOREPO_PARENTS.flatMap((parent) =>
    (monorepoChildren[parent] ?? []).map(
      (child) => `${parent}/${child}/${MONOREPO_CHILD_DIRECTORY}`,
    ),
  );
  return [...FAVICON_DIRECTORIES, ...nested];
}

/** Whether a directory is one this scanner is willing to have looked in. */
export function isSearchableDirectory(directory: string): boolean {
  return (
    FAVICON_DIRECTORIES.includes(directory) || MONOREPO_PATTERN.test(directory)
  );
}

/**
 * The kinds of icon file, best first.
 *
 * `apple-touch-icon` leads because it is the one icon a project is asked to
 * draw at a real size — 180px, meant to be looked at — while a favicon is
 * drawn for a 16px tab and is often a cropped or simplified mark. Vector
 * beats raster next, because this chip is drawn at 14 and 20 CSS pixels on
 * displays with two or three device pixels each.
 *
 * The sized `favicon-32x32.png` family sits ABOVE the unsized `favicon.png`
 * on purpose, following the order this feature was specified with: a name
 * that states its size is a deliberately generated asset, where a bare
 * `favicon.png` is as likely to be a leftover.
 */
const RANK_APPLE_TOUCH = 0;
const RANK_ICON_SVG = 1;
const RANK_FAVICON_SVG = 2;
const RANK_FAVICON_SIZED = 3;
const RANK_FAVICON_PNG = 4;
const RANK_FAVICON_ICO = 5;
const RANK_LOGO_SVG = 6;
const RANK_LOGO_PNG = 7;

/** `apple-touch-icon.png`, and the `-precomposed` / `-180x180` variants. */
const APPLE_TOUCH_PATTERN = /^apple-touch-icon.*\.png$/;
const SIZED_FAVICON_PATTERN = /^favicon-(\d+)x(\d+)\.png$/;

interface Classified {
  rank: number;
  /**
   * Pixels, for the sized favicons only; 0 everywhere else. The SHORT side,
   * because a 32x16 image is a 16px-tall icon however wide it is, and this
   * number exists to answer "how much detail survives".
   */
  size: number;
}

/**
 * What kind of icon a file name is, or null when it is not one.
 *
 * Matched in lower case: a repository written on a case-insensitive
 * filesystem can carry `Favicon.png`, and refusing it would make this feature
 * behave differently on macOS and Linux checkouts of the same project.
 */
function classify(fileName: string): Classified | null {
  const name = fileName.toLowerCase();

  if (APPLE_TOUCH_PATTERN.test(name)) {
    return { rank: RANK_APPLE_TOUCH, size: 0 };
  }
  if (name === "icon.svg") return { rank: RANK_ICON_SVG, size: 0 };
  if (name === "favicon.svg") return { rank: RANK_FAVICON_SVG, size: 0 };

  const sized = SIZED_FAVICON_PATTERN.exec(name);
  if (sized !== null) {
    return {
      rank: RANK_FAVICON_SIZED,
      size: Math.min(Number(sized[1]), Number(sized[2])),
    };
  }

  if (name === "favicon.png") return { rank: RANK_FAVICON_PNG, size: 0 };
  if (name === "favicon.ico") return { rank: RANK_FAVICON_ICO, size: 0 };
  if (name === "logo.svg") return { rank: RANK_LOGO_SVG, size: 0 };
  if (name === "logo.png") return { rank: RANK_LOGO_PNG, size: 0 };
  return null;
}

/** The directory part of a relative path; `""` for a file at the root. */
function directoryOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

function fileNameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

function depthOf(directory: string): number {
  if (directory === "") return 0;
  return directory.split("/").length;
}

/**
 * Every candidate this scanner would accept, best first.
 *
 * A full order rather than a single winner, because the caller reads files and
 * reading can fail — a name that ranks first may be unreadable, may be a
 * directory, or may be a type this plugin will not render. Falling to the next
 * name is the difference between "this project has no icon" and "this
 * project's best icon happened to be a `.ico`".
 *
 * Paths are relative to the project root and use forward slashes. Anything
 * outside {@link isSearchableDirectory} is dropped here rather than trusted,
 * so a caller that lists one directory too many cannot widen the search by
 * accident.
 */
export function rankFaviconCandidates(
  paths: readonly string[],
): string[] {
  const ranked = paths.flatMap((path) => {
    const directory = directoryOf(path);
    if (!isSearchableDirectory(directory)) return [];
    const classified = classify(fileNameOf(path));
    if (classified === null) return [];
    return [{ path, directory, ...classified }];
  });

  ranked.sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    // Bigger is better among the sized favicons, and a no-op elsewhere.
    if (left.size !== right.size) return right.size - left.size;
    // Shallower wins: an icon at `public/` belongs to the project, one at
    // `apps/web/public/` belongs to one app inside it.
    const leftDepth = depthOf(left.directory);
    const rightDepth = depthOf(right.directory);
    if (leftDepth !== rightDepth) return leftDepth - rightDepth;
    // Code-point order, not locale order: two machines with different locales
    // must pick the same icon, or the same project looks different on each.
    if (left.path === right.path) return 0;
    return left.path < right.path ? -1 : 1;
  });

  return ranked.map((candidate) => candidate.path);
}

/** The one icon to prefer, or null when the listing holds none. */
export function pickFavicon(paths: readonly string[]): string | null {
  return rankFaviconCandidates(paths)[0] ?? null;
}

/**
 * The MIME type to stamp on a file's data URL, or null for a name this plugin
 * will not store.
 *
 * Derived from the extension because a local file carries no content type.
 * `.ico` maps to `image/x-icon`, which the shared data-URL allow-list accepts.
 * It ranks below every other format because an .ico is usually 16 or 32 pixels
 * and looks soft next to an SVG — but a soft icon beats no icon, and plenty of
 * repositories ship nothing else.
 */
export function faviconMimeType(path: string): string | null {
  const name = fileNameOf(path).toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".svg")) return "image/svg+xml";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".ico")) return "image/x-icon";
  return null;
}
