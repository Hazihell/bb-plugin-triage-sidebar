import { useState } from "react";
import {
  projectMonogram,
  resolveProjectAvatar,
  type AvatarProject,
  type StoredProjectAvatar,
} from "./project-avatar";
import { cn } from "./lib/utils";

/**
 * One project's avatar: an image, an emoji, or a generated monogram.
 *
 * A rounded square, not a circle. A circle is the web's shorthand for a
 * person, and half the things in a bb sidebar already are people-shaped; a
 * project is a thing, and the corner radius is the whole difference between
 * "who" and "what" at 14 pixels.
 *
 * The box is fixed at both sizes and never grows to its content. This sits on
 * the first line of a thread card, beside a status slot that is already
 * pinned to one width, and a chip that measured its own image would move the
 * project name every time an avatar finished loading.
 */

/**
 * THE ONE PLACE THIS PLUGIN USES A HARDCODED COLOUR, ON PURPOSE. DO NOT
 * "FIX" IT INTO A TAILWIND CLASS.
 *
 * Everywhere else this plugin uses Tailwind theme tokens only, because the
 * frontend's Tailwind pass emits default-theme utilities and a hardcoded color
 * breaks custom palettes. Identity colors are the exception — a hashed hue
 * cannot come from a token — so the background is applied via an inline
 * `style`, which bypasses Tailwind entirely. Everything else (radius, size,
 * font weight, layout) stays on Tailwind classes.
 */
const SIZES = {
  /** 14px, the size of the status glyph, so both ends of a card line agree. */
  sm: "size-3.5 rounded-sm text-2xs",
  /** 20px, the smallest size at which a remote logo is still recognisable. */
  md: "size-5 rounded-md text-xs",
} as const;

export type ProjectAvatarSize = keyof typeof SIZES;

export function ProjectAvatar({
  project,
  stored,
  size = "sm",
  className,
}: {
  project: AvatarProject;
  stored?: StoredProjectAvatar;
  size?: ProjectAvatarSize;
  className?: string;
}) {
  /**
   * Which src failed, not merely "an image failed". A project whose remote
   * avatar 404s can be given a custom image a second later, and remembering
   * only a boolean would refuse to try the new one.
   */
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const resolved = resolveProjectAvatar(project, stored);
  const brokenImage = resolved.kind === "image" && resolved.src === failedSrc;
  // A broken image degrades to the monogram rather than to a torn-page icon:
  // the row still has to say which project this is, and a failed fetch is not
  // information the user can act on.
  const avatar = brokenImage ? projectMonogram(project, stored) : resolved;

  const box = cn(
    "flex shrink-0 items-center justify-center overflow-hidden",
    "select-none font-semibold leading-none text-white",
    SIZES[size],
    className,
  );

  if (avatar.kind === "image") {
    return (
      <img
        src={avatar.src}
        // Decorative: the project's name is already written next to this chip,
        // and a screen reader reading it twice is noise, not access.
        alt=""
        className={cn(box, "object-cover")}
        onError={() => setFailedSrc(avatar.src)}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={box}
      style={{ background: avatar.background }}
    >
      {avatar.kind === "emoji" ? avatar.emoji : avatar.initials}
    </span>
  );
}
