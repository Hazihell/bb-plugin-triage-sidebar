import { useState } from "react";
import { experimental_useSidebarThreads as useSidebarThreads } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarProject } from "@get-bb/plugin-sdk";
import { ProjectAvatar } from "./ProjectAvatar";
import {
  avatarBackground,
  projectHue,
  projectInitials,
  type StoredProjectAvatar,
} from "./project-avatar";
import { useProjectAvatars, type ProjectAvatarsApi } from "./useProjectAvatars";
import { cn } from "./lib/utils";

/**
 * The one place a project avatar is edited.
 *
 * It lives in Settings rather than on a right-click in the sidebar because
 * this is a rare, deliberate act — you name a project's colour once and then
 * live with it for months — and because it is per project, not per thread,
 * while everything the sidebar's menu offers is per thread.
 *
 * Every project is listed, including the ones that already look right. A user
 * who wants to change the teal one has to be able to find the teal one, and a
 * list of "projects you have already customized" would hide exactly the rows
 * they are looking for.
 */

/**
 * The colours offered, as a grid rather than a colour input.
 *
 * A free picker lets someone choose white, and the monogram's text is white:
 * the chip would be readable in the picker and invisible in the sidebar.
 * These twelve come out of the same `avatarBackground` the generated palette
 * uses, so every one of them is inside sRGB and clears 4.5:1 against white —
 * the guarantee is in the function, not in this list, and the test in
 * `project-avatar.test.ts` is what holds it.
 *
 * Twelve, at 30° apart, because the hues have to be told apart at 14px. A
 * finer grid would offer pairs no one could distinguish in the sidebar.
 */
const PRESET_HUES = Array.from({ length: 12 }, (_, index) => index * 30);

export function ProjectAvatarSettings() {
  const { status, projects } = useSidebarThreads();
  const avatars = useProjectAvatars();

  if (status === "loading") return null;
  if (status === "error") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Could not load projects.
      </p>
    );
  }
  if (projects.length === 0) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        No projects yet.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {projects.map((project) => (
        <ProjectAvatarRow
          // Keyed by project, so switching projects cannot leave another
          // project's half-typed initials in the fields.
          key={project.id}
          project={project}
          stored={avatars.rows.get(project.id)}
          avatars={avatars}
        />
      ))}
    </ul>
  );
}

/**
 * What the user is currently getting, said in words next to the Clear button.
 *
 * The favicon case names the file, where the others name only the source. It
 * is the one case where the answer can be surprising — a project can ship an
 * icon nobody remembers putting there, or its framework's untouched default —
 * and the path is both the explanation and the thing the user can go and
 * change.
 */
function describeSource(stored: StoredProjectAvatar | undefined): string {
  switch (stored?.customKind) {
    case "monogram":
      return "Your monogram";
    case "emoji":
      return "Your emoji";
    case "image":
      return "Your image";
    default:
      if (stored?.faviconImage) {
        return stored.faviconPath
          ? `Project folder: ${stored.faviconPath}`
          : "From the project folder";
      }
      return stored?.remoteImage ? "From the git host" : "Generated";
  }
}

function ProjectAvatarRow({
  project,
  stored,
  avatars,
}: {
  project: PluginSidebarProject;
  stored: StoredProjectAvatar | undefined;
  avatars: ProjectAvatarsApi;
}) {
  // Drafts seeded from the store once, and never re-seeded from it. A realtime
  // signal arrives whenever any client writes, and rewriting a field under
  // someone who is typing into it is worse than showing a stale draft.
  const [initials, setInitials] = useState(
    () => stored?.customInitials ?? projectInitials(project.name),
  );
  const [color, setColor] = useState(
    () => stored?.customColor ?? avatarBackground(projectHue(project.id)),
  );
  const [emoji, setEmoji] = useState(() => stored?.customEmoji ?? "");
  // Never seeded from `customImage`: that value can be a quarter of a megabyte
  // of base64, and putting it in a text field would be unreadable and slow.
  const [imageUrl, setImageUrl] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isBusy, setBusy] = useState(false);

  /**
   * One place for the three things every action here needs: no double
   * submits, the backend's own sentence when it refuses, and a message the
   * user can read rather than a rejected promise nobody sees.
   */
  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await action());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        {/* The preview is the stored avatar, not the draft: it is the answer
            to "what does the sidebar show", and a preview that ran ahead of
            what was saved would answer a different question. */}
        <ProjectAvatar project={project} stored={stored} size="md" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {project.name}
        </span>
        {/* Truncated rather than fixed-width: a favicon's path can be as long
            as `apps/web/public/apple-touch-icon.png`, and the project's name
            is the more important of the two things competing for this line.
            The title carries the whole path for the one moment it matters. */}
        <span
          title={describeSource(stored)}
          className="max-w-48 shrink-0 truncate text-2xs text-muted-foreground"
        >
          {describeSource(stored)}
        </span>
        <RowButton
          disabled={isBusy}
          onClick={() =>
            void run(async () => {
              const ok = await avatars.refresh(project.id);
              return ok
                ? "Fetched a new image from the git host."
                : "The git host had no avatar for this project.";
            })
          }
        >
          Refresh from git host
        </RowButton>
        <RowButton
          // Nothing to clear when the user has set nothing; the button would
          // otherwise promise an undo for a change they never made.
          disabled={isBusy || !stored?.customKind}
          onClick={() =>
            void run(async () => {
              await avatars.clear(project.id);
              return null;
            })
          }
        >
          Clear
        </RowButton>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Field label="Initials">
          <input
            value={initials}
            aria-label={`Initials for ${project.name}`}
            // Two graphemes is the chip's budget at 14px; the backend enforces
            // the same ceiling, this only stops the user reaching it blind.
            maxLength={2}
            onChange={(event) => setInitials(event.target.value)}
            className={cn(INPUT_CLASS, "w-14")}
          />
        </Field>
        <div
          role="group"
          aria-label={`Background colour for ${project.name}`}
          className="flex flex-wrap gap-1"
        >
          {PRESET_HUES.map((hue) => {
            const background = avatarBackground(hue);
            return (
              <button
                key={hue}
                type="button"
                aria-label={`Hue ${hue}`}
                aria-pressed={background === color}
                onClick={() => setColor(background)}
                className={cn(
                  "size-5 cursor-pointer rounded-md",
                  background === color && "ring-2 ring-ring ring-offset-1",
                )}
                // The one hardcoded colour this plugin allows itself, for the
                // reason written at the top of ProjectAvatar.tsx: a hashed hue
                // cannot come out of a Tailwind token.
                style={{ background }}
              />
            );
          })}
        </div>
        <RowButton
          disabled={isBusy || initials.trim().length === 0}
          onClick={() =>
            void run(async () => {
              await avatars.set(project.id, {
                kind: "monogram",
                color,
                initials: initials.trim(),
              });
              return null;
            })
          }
        >
          Use monogram
        </RowButton>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Field label="Emoji">
          <input
            value={emoji}
            aria-label={`Emoji for ${project.name}`}
            onChange={(event) => setEmoji(event.target.value)}
            className={cn(INPUT_CLASS, "w-14")}
          />
        </Field>
        <RowButton
          disabled={isBusy || emoji.trim().length === 0}
          onClick={() =>
            void run(async () => {
              // The emoji carries the same background as the monogram, so
              // switching between the two does not also change the colour the
              // user has already learned for this project.
              await avatars.set(project.id, {
                kind: "emoji",
                emoji: emoji.trim(),
                color,
              });
              return null;
            })
          }
        >
          Use emoji
        </RowButton>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Field label="Image">
          <input
            value={imageUrl}
            aria-label={`Image URL for ${project.name}`}
            placeholder="https://… or data:image/png;base64,…"
            onChange={(event) => setImageUrl(event.target.value)}
            className={cn(INPUT_CLASS, "w-64")}
          />
        </Field>
        <RowButton
          disabled={isBusy || imageUrl.trim().length === 0}
          onClick={() =>
            void run(async () => {
              await avatars.set(project.id, {
                kind: "image",
                image: await asStorableImage(imageUrl.trim()),
              });
              setImageUrl("");
              return null;
            })
          }
        >
          Use image
        </RowButton>
      </div>

      {message === null ? null : (
        // `alert`, not `status`: every message here answers a button the user
        // just pressed, and the failures are the ones worth interrupting for.
        <p role="alert" className="text-2xs text-muted-foreground">
          {message}
        </p>
      )}
    </li>
  );
}

/**
 * A pasted address, turned into something the store will accept.
 *
 * The store keeps data URLs only, and that is not a limitation to work around:
 * a remote `<img src>` in the sidebar would ask a third-party server for the
 * same picture on every render of every card, and would leave the avatar blank
 * whenever that server is unreachable. So a link is downloaded once, here,
 * exactly as the background fetch does it for the git host — the difference is
 * only who chose the URL.
 *
 * The type and size are not checked here. The backend refuses anything it will
 * not render, in one sentence written for a person, and duplicating that rule
 * in the UI would give us two rules to keep in step.
 */
async function asStorableImage(value: string): Promise<string> {
  if (value.startsWith("data:")) return value;

  let response: Response;
  try {
    response = await fetch(value);
  } catch {
    throw new Error("That address could not be reached.");
  }
  if (!response.ok) {
    throw new Error(`That address answered ${response.status}.`);
  }
  const contentType = (response.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  const bytes = new Uint8Array(await response.arrayBuffer());
  return `data:${contentType};base64,${base64(bytes)}`;
}

/**
 * Base64 without `FileReader` or Node's Buffer: one is asynchronous for no
 * reason here, the other does not exist in the app window. Chunked because
 * `String.fromCharCode(...bytes)` on a whole image overflows the call stack.
 */
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}

const INPUT_CLASS =
  "h-7 rounded-md border border-input bg-transparent px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5">
      {/* The control carries its own accessible name, including the project's,
          so this text is a visual heading and nothing more. */}
      <span aria-hidden="true" className="text-2xs text-muted-foreground">
        {label}
      </span>
      {children}
    </span>
  );
}

function RowButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="shrink-0 cursor-pointer rounded-md border border-input px-2 py-1 text-2xs text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}
