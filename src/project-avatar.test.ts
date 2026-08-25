import { describe, expect, it } from "vitest";
import {
  avatarBackground,
  projectHue,
  projectInitials,
  projectMonogram,
  resolveProjectAvatar,
} from "./project-avatar";

const PROJECT = { id: "proj_1", name: "captouro" };

describe("projectInitials", () => {
  it("takes one letter from a single word and two from several", () => {
    expect(projectInitials("captouro")).toBe("C");
    expect(projectInitials("my cool app")).toBe("MC");
  });

  it("treats punctuation and hyphens as word breaks", () => {
    expect(projectInitials("bb-plugin-triage")).toBe("BP");
    expect(projectInitials("triage_sidebar")).toBe("TS");
    expect(projectInitials("acme.co/website")).toBe("AC");
  });

  it("splits camelCase, because repo names rarely bother with spaces", () => {
    expect(projectInitials("myCoolApp")).toBe("MC");
    expect(projectInitials("TriageSidebar")).toBe("TS");
  });

  // An all-caps run is one word to a reader ("API" is not A, P, I), so it must
  // not be split into three.
  it("does not split a run of capitals", () => {
    expect(projectInitials("APIServer")).toBe("AS");
    expect(projectInitials("API")).toBe("A");
  });

  it("keeps an apostrophe inside its word rather than splitting on it", () => {
    expect(projectInitials("Roger's app")).toBe("RA");
  });

  it("ignores leading and trailing noise", () => {
    expect(projectInitials("  ~my app~  ")).toBe("MA");
    expect(projectInitials("🚀 rocket app")).toBe("RA");
  });

  it("returns nothing for a name with no letters, rather than a placeholder", () => {
    expect(projectInitials("")).toBe("");
    expect(projectInitials("   ")).toBe("");
    expect(projectInitials("---")).toBe("");
  });

  describe("scripts that are not latin", () => {
    it("takes the first character of a caseless script untouched", () => {
      expect(projectInitials("我的应用")).toBe("我");
      expect(projectInitials("プロジェクト")).toBe("プ");
      expect(projectInitials("مشروع جديد")).toBe("مج");
    });

    // The cluster is one character to a reader; slicing code units would cut
    // the vowel sign off the consonant and render a different letter.
    it("keeps a combining mark attached to its letter", () => {
      expect(projectInitials("हिन्दी ऐप")).toBe("हिऐ");
    });

    it("uppercases Cyrillic and Greek, which do have case", () => {
      expect(projectInitials("проект")).toBe("П");
      expect(projectInitials("έργο")).toBe("Έ");
    });

    // "ß".toUpperCase() is "SS": uppercasing here would double the width of a
    // one-letter monogram.
    it("leaves a letter alone when uppercasing would expand it", () => {
      expect(projectInitials("ßeta")).toBe("ß");
    });
  });
});

describe("projectHue", () => {
  it("is stable for the same id", () => {
    expect(projectHue("proj_1")).toBe(projectHue("proj_1"));
  });

  // The hue is baked into what a user has memorized, so these are pinned
  // literals on purpose: changing the hash is a visual migration, and this
  // test is the alarm that says so.
  it("returns the hues it has always returned", () => {
    expect(projectHue("proj_1")).toBe(118);
    expect(projectHue("proj_2")).toBe(299);
    expect(projectHue("captouro")).toBe(42);
    expect(projectHue("")).toBe(61);
  });

  it("stays inside a hue circle for every input", () => {
    for (let index = 0; index < 500; index += 1) {
      const hue = projectHue(`proj_${index}`);
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThanOrEqual(359);
    }
  });

  it("spreads ids across the circle rather than clumping", () => {
    const buckets = new Set(
      Array.from({ length: 200 }, (_, index) =>
        Math.floor(projectHue(`proj_${index}`) / 30),
      ),
    );
    // All twelve 30-degree segments should see traffic; a hash that clumped
    // would give neighbouring projects the same colour.
    expect(buckets.size).toBe(12);
  });

  it("gives visibly different hues to ids that differ by one character", () => {
    expect(Math.abs(projectHue("proj_1") - projectHue("proj_2"))).toBeGreaterThan(
      10,
    );
  });
});

/**
 * The contrast and gamut checks below are the justification for the lightness
 * and chroma constants, re-run rather than trusted. They convert oklch to
 * linear sRGB with the standard matrices so the assertions do not depend on a
 * browser being present.
 */
function oklchToLinearSrgb(
  lightness: number,
  chroma: number,
  hue: number,
): [number, number, number] {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function parseOklch(color: string): [number, number, number] {
  const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(color);
  if (!match) throw new Error(`not an oklch() string: ${color}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** WCAG contrast of white text on this background. */
function contrastWithWhite(color: string): number {
  const [red, green, blue] = oklchToLinearSrgb(...parseOklch(color));
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return 1.05 / (luminance + 0.05);
}

describe("avatarBackground", () => {
  it("emits an oklch string a browser can use directly", () => {
    expect(avatarBackground(120)).toBe("oklch(0.54 0.09 120)");
  });

  it("wraps a hue past the circle instead of clamping it", () => {
    expect(avatarBackground(400)).toBe(avatarBackground(40));
    expect(avatarBackground(-20)).toBe(avatarBackground(340));
  });

  it("keeps white text readable on every hue, not just the average one", () => {
    for (let hue = 0; hue < 360; hue += 1) {
      expect(contrastWithWhite(avatarBackground(hue))).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it("stays inside sRGB on every hue, so no hue is silently gamut-mapped", () => {
    for (let hue = 0; hue < 360; hue += 1) {
      const channels = oklchToLinearSrgb(...parseOklch(avatarBackground(hue)));
      for (const channel of channels) {
        expect(channel).toBeGreaterThanOrEqual(-0.001);
        expect(channel).toBeLessThanOrEqual(1.001);
      }
    }
  });

  // The chip sits beside muted sidebar text. A saturated square would compete
  // with the status column, which is the one thing in the row meant to shout.
  it("stays muted", () => {
    const [, chroma] = parseOklch(avatarBackground(0));
    expect(chroma).toBeLessThanOrEqual(0.1);
  });
});

describe("resolveProjectAvatar", () => {
  it("falls back to a monogram when nothing is recorded", () => {
    expect(resolveProjectAvatar(PROJECT, undefined)).toEqual({
      kind: "monogram",
      initials: "C",
      background: avatarBackground(projectHue("proj_1")),
    });
  });

  it("treats an empty stored row the same as no row", () => {
    expect(resolveProjectAvatar(PROJECT, {})).toEqual(
      resolveProjectAvatar(PROJECT, undefined),
    );
    expect(
      resolveProjectAvatar(PROJECT, {
        customKind: null,
        customColor: null,
        customInitials: null,
        customEmoji: null,
        customImage: null,
        remoteImage: null,
      }),
    ).toEqual(resolveProjectAvatar(PROJECT, undefined));
  });

  it("uses the cached remote image when the user has set nothing", () => {
    expect(
      resolveProjectAvatar(PROJECT, { remoteImage: "https://host/org.png" }),
    ).toEqual({ kind: "image", src: "https://host/org.png" });
  });

  // A favicon is the project's own mark; a host avatar belongs to the org
  // that owns it, so without this every repository under one organization
  // would wear the same face.
  it("prefers the project's own favicon over the git host's image", () => {
    expect(
      resolveProjectAvatar(PROJECT, {
        faviconImage: "data:image/svg+xml;base64,AAA",
        remoteImage: "https://host/org.png",
      }),
    ).toEqual({ kind: "image", src: "data:image/svg+xml;base64,AAA" });
  });

  it("prefers a custom image over the favicon", () => {
    expect(
      resolveProjectAvatar(PROJECT, {
        customKind: "image",
        customImage: "data:image/png;base64,AAA",
        faviconImage: "data:image/svg+xml;base64,BBB",
      }),
    ).toEqual({ kind: "image", src: "data:image/png;base64,AAA" });
  });

  // The favicon is re-read in the background. If it could override a chosen
  // monogram, the user's choice would undo itself on the next scan.
  it("keeps a chosen monogram even when a favicon was found", () => {
    expect(
      resolveProjectAvatar(PROJECT, {
        customKind: "monogram",
        faviconImage: "data:image/svg+xml;base64,AAA",
      }),
    ).toMatchObject({ kind: "monogram", initials: "C" });
  });

  // A project whose checkout is not on this machine has no favicon, and must
  // fall the rest of the way down rather than render nothing.
  it("falls back to the remote image when there is no favicon", () => {
    expect(
      resolveProjectAvatar(PROJECT, {
        faviconImage: null,
        remoteImage: "https://host/org.png",
      }),
    ).toEqual({ kind: "image", src: "https://host/org.png" });
  });

  it("prefers a custom image over the remote one", () => {
    expect(
      resolveProjectAvatar(PROJECT, {
        customKind: "image",
        customImage: "data:image/png;base64,AAA",
        remoteImage: "https://host/org.png",
      }),
    ).toEqual({ kind: "image", src: "data:image/png;base64,AAA" });
  });

  // The remote image is refetched in the background. If it could override a
  // chosen monogram, the user's choice would undo itself on the next sync.
  it("keeps a chosen monogram even when a remote image is cached", () => {
    expect(
      resolveProjectAvatar(PROJECT, {
        customKind: "monogram",
        remoteImage: "https://host/org.png",
      }),
    ).toMatchObject({ kind: "monogram", initials: "C" });
  });

  it("keeps a chosen emoji even when a remote image is cached", () => {
    expect(
      resolveProjectAvatar(PROJECT, {
        customKind: "emoji",
        customEmoji: "🐙",
        remoteImage: "https://host/org.png",
      }),
    ).toMatchObject({ kind: "emoji", emoji: "🐙" });
  });

  it("uses custom initials over the ones derived from the name", () => {
    expect(
      resolveProjectAvatar(PROJECT, {
        customKind: "monogram",
        customInitials: "ZZ",
      }),
    ).toMatchObject({ kind: "monogram", initials: "ZZ" });
  });

  it("caps custom initials at two, whatever was typed into the field", () => {
    expect(
      projectMonogram(PROJECT, { customInitials: "LONGNAME" }),
    ).toMatchObject({ initials: "LO" });
  });

  it("uses a custom colour in place of the hashed hue", () => {
    expect(
      resolveProjectAvatar(PROJECT, { customColor: "#ff0000" }),
    ).toMatchObject({ background: "#ff0000" });
    expect(
      resolveProjectAvatar(PROJECT, {
        customKind: "emoji",
        customEmoji: "🐙",
        customColor: "#ff0000",
      }),
    ).toMatchObject({ background: "#ff0000" });
  });

  // Half-written rows happen. An empty square is a bug the user cannot
  // diagnose, so a kind pointing at a missing field falls through.
  it("falls through when the chosen kind has no content", () => {
    expect(
      resolveProjectAvatar(PROJECT, {
        customKind: "image",
        customImage: "   ",
        remoteImage: "https://host/org.png",
      }),
    ).toEqual({ kind: "image", src: "https://host/org.png" });
    expect(
      resolveProjectAvatar(PROJECT, { customKind: "emoji", customEmoji: null }),
    ).toMatchObject({ kind: "monogram" });
  });

  // Rows written before `customKind` existed still have to render what their
  // user picked.
  it("infers the kind from the filled field when none was recorded", () => {
    expect(
      resolveProjectAvatar(PROJECT, { customImage: "https://host/mine.png" }),
    ).toEqual({ kind: "image", src: "https://host/mine.png" });
    expect(resolveProjectAvatar(PROJECT, { customEmoji: "🐙" })).toMatchObject({
      kind: "emoji",
      emoji: "🐙",
    });
  });

  it("colours by id, not by name, so a rename keeps the colour", () => {
    const before = resolveProjectAvatar({ id: "proj_1", name: "captouro" });
    const after = resolveProjectAvatar({ id: "proj_1", name: "renamed thing" });
    expect(after).toMatchObject({ background: (before as { background: string }).background });
    expect(after).toMatchObject({ initials: "RT" });
  });
});
