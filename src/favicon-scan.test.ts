import { describe, expect, it } from "vitest";
import {
  FAVICON_DIRECTORIES,
  faviconMimeType,
  faviconSearchDirectories,
  isSearchableDirectory,
  pickFavicon,
  rankFaviconCandidates,
} from "./favicon-scan";

describe("pickFavicon", () => {
  it("prefers the apple touch icon over everything else", () => {
    expect(
      pickFavicon([
        "public/favicon.ico",
        "public/favicon.svg",
        "public/apple-touch-icon.png",
        "public/logo.svg",
      ]),
    ).toBe("public/apple-touch-icon.png");
  });

  // The name is a family, not a constant: a generator emits
  // `apple-touch-icon-180x180.png` and iOS's older convention adds
  // `-precomposed`.
  it("accepts the apple touch icon's named variants", () => {
    expect(pickFavicon(["public/apple-touch-icon-180x180.png"])).toBe(
      "public/apple-touch-icon-180x180.png",
    );
    expect(pickFavicon(["apple-touch-icon-precomposed.png"])).toBe(
      "apple-touch-icon-precomposed.png",
    );
  });

  it("prefers vector over raster", () => {
    expect(pickFavicon(["public/favicon.png", "public/favicon.svg"])).toBe(
      "public/favicon.svg",
    );
  });

  it("prefers icon.svg over favicon.svg", () => {
    expect(pickFavicon(["app/favicon.svg", "app/icon.svg"])).toBe(
      "app/icon.svg",
    );
  });

  it("takes the largest sized favicon", () => {
    expect(
      pickFavicon([
        "static/favicon-16x16.png",
        "static/favicon-192x192.png",
        "static/favicon-32x32.png",
      ]),
    ).toBe("static/favicon-192x192.png");
  });

  // The short side is what survives at 14px, so a lopsided image is judged by
  // it rather than by whichever number happens to be written first.
  it("measures a lopsided image by its short side", () => {
    expect(
      pickFavicon(["public/favicon-64x16.png", "public/favicon-32x32.png"]),
    ).toBe("public/favicon-32x32.png");
  });

  it("falls back through the raster names in order", () => {
    expect(pickFavicon(["www/logo.png", "www/favicon.ico"])).toBe(
      "www/favicon.ico",
    );
    expect(pickFavicon(["www/logo.png", "www/logo.svg"])).toBe("www/logo.svg");
    expect(pickFavicon(["www/logo.svg", "www/favicon.png"])).toBe(
      "www/favicon.png",
    );
  });

  it("returns null when a listing holds no icon", () => {
    expect(pickFavicon(["public/index.html", "src/main.ts", "README.md"])).toBe(
      null,
    );
    expect(pickFavicon([])).toBe(null);
  });

  // A repository written on a case-insensitive filesystem carries whatever the
  // author typed, and the same checkout on Linux must still find its icon.
  it("matches names regardless of case", () => {
    expect(pickFavicon(["public/Favicon.SVG"])).toBe("public/Favicon.SVG");
  });

  it("ignores a name that only looks like an icon", () => {
    expect(
      pickFavicon([
        "public/favicon.ts",
        "public/favicon-generator.png",
        "public/my-logo.svg",
      ]),
    ).toBe(null);
  });
});

describe("where pickFavicon is willing to look", () => {
  it("accepts every listed directory and the root", () => {
    for (const directory of FAVICON_DIRECTORIES) {
      const path = directory === "" ? "favicon.svg" : `${directory}/favicon.svg`;
      expect(pickFavicon([path])).toBe(path);
    }
  });

  // A recursive walk would find every icon in every fixture and vendored
  // asset directory, and the wrong icon is worse than none: the user cannot
  // tell where it came from.
  it("refuses a directory it was never told to search", () => {
    expect(
      pickFavicon([
        "node_modules/some-pkg/favicon.svg",
        "src/components/icons/favicon.svg",
        "public/nested/favicon.svg",
        "docs/favicon.svg",
      ]),
    ).toBe(null);
  });

  it("accepts one level of monorepo nesting under public", () => {
    expect(pickFavicon(["apps/web/public/favicon.svg"])).toBe(
      "apps/web/public/favicon.svg",
    );
    expect(pickFavicon(["packages/ui/public/favicon.svg"])).toBe(
      "packages/ui/public/favicon.svg",
    );
    // Two levels down, or beside `public` rather than inside it, is a walk.
    expect(pickFavicon(["apps/web/site/public/favicon.svg"])).toBe(null);
    expect(pickFavicon(["apps/web/favicon.svg"])).toBe(null);
  });

  it("prefers the shallowest icon, then the alphabetical one", () => {
    expect(
      pickFavicon([
        "apps/web/public/favicon.svg",
        "public/favicon.svg",
      ]),
    ).toBe("public/favicon.svg");
    expect(
      pickFavicon([
        "apps/web/public/favicon.svg",
        "apps/admin/public/favicon.svg",
      ]),
    ).toBe("apps/admin/public/favicon.svg");
  });

  // The same repository has to produce the same icon on every machine, so the
  // order may not depend on how a directory listing happened to come back.
  it("gives the same answer whatever order the listing arrives in", () => {
    const paths = [
      "apps/web/public/favicon.svg",
      "public/favicon-32x32.png",
      "static/logo.svg",
      "favicon.ico",
      "apps/admin/public/favicon.svg",
    ];
    const ranked = rankFaviconCandidates(paths);
    expect(rankFaviconCandidates([...paths].reverse())).toEqual(ranked);
    expect(rankFaviconCandidates([...paths].sort())).toEqual(ranked);
  });
});

describe("rankFaviconCandidates", () => {
  // The caller reads files, and reading fails: a `.ico` is refused by the
  // data-URL allow-list, and a name can turn out to be a directory. Without
  // the rest of the order the project would fall back to its org's logo
  // because of one unusable file.
  it("keeps the also-rans so a failed read can fall through", () => {
    expect(
      rankFaviconCandidates([
        "public/logo.png",
        "public/favicon.ico",
        "public/apple-touch-icon.png",
      ]),
    ).toEqual([
      "public/apple-touch-icon.png",
      "public/favicon.ico",
      "public/logo.png",
    ]);
  });

  it("drops the files that are not icons at all", () => {
    expect(
      rankFaviconCandidates(["public/index.html", "public/favicon.png"]),
    ).toEqual(["public/favicon.png"]);
  });
});

describe("faviconSearchDirectories", () => {
  it("lists the fixed directories when there is no monorepo", () => {
    expect(faviconSearchDirectories()).toEqual([...FAVICON_DIRECTORIES]);
  });

  it("adds a public directory per monorepo member", () => {
    const directories = faviconSearchDirectories({
      apps: ["web", "admin"],
      packages: ["ui"],
    });
    expect(directories).toContain("apps/web/public");
    expect(directories).toContain("apps/admin/public");
    expect(directories).toContain("packages/ui/public");
    // Everything it produces must be somewhere it is allowed to look, or the
    // scanner and the filter would disagree about the search.
    for (const directory of directories) {
      expect(isSearchableDirectory(directory)).toBe(true);
    }
  });
});

describe("faviconMimeType", () => {
  it("names the types the avatar store renders", () => {
    expect(faviconMimeType("public/favicon.png")).toBe("image/png");
    expect(faviconMimeType("public/favicon.svg")).toBe("image/svg+xml");
    expect(faviconMimeType("public/logo.webp")).toBe("image/webp");
    expect(faviconMimeType("public/logo.gif")).toBe("image/gif");
    expect(faviconMimeType("public/logo.jpeg")).toBe("image/jpeg");
    expect(faviconMimeType("public/logo.JPG")).toBe("image/jpeg");
  });

  // `.ico` is ranked as a candidate but has no allowed data-URL type, so it is
  // refused before it is read rather than after.
  it("accepts .ico, which many repositories ship as their only icon", () => {
    expect(faviconMimeType("public/favicon.ico")).toBe("image/x-icon");
  });

  it("refuses a type the store would not accept", () => {
    expect(faviconMimeType("public/favicon")).toBe(null);
    expect(faviconMimeType("public/favicon.bmp")).toBe(null);
  });
});
