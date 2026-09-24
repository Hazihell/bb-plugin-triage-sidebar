import type { ReactNode } from "react";
import type { PluginSidebarThreadShortcut } from "@get-bb/plugin-sdk/app";
import { cn } from "./lib/utils";
import { ShortcutPill } from "./ThreadRowLink";

/**
 * Which row the aside sits in. Tailwind's group variants are written out in
 * full per row kind, because the build only emits classes it can read.
 */
const REVEAL = {
  card: {
    actions:
      "sr-only group-hover/card:not-sr-only group-hover/card:flex group-has-[:focus-visible]/card:not-sr-only group-has-[:focus-visible]/card:flex",
    rest: "group-hover/card:hidden group-has-[:focus-visible]/card:hidden",
  },
  slim: {
    actions:
      "sr-only group-hover/slim:not-sr-only group-hover/slim:flex group-has-[:focus-visible]/slim:not-sr-only group-has-[:focus-visible]/slim:flex",
    rest: "group-hover/slim:hidden group-has-[:focus-visible]/slim:hidden",
  },
} as const;

/** One row action button, drawn only where there is hover to reveal it. */
export const ROW_ACTION_BUTTON_CLASS =
  "relative cursor-pointer rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring";

/** An action whose menu is open stays drawn, whatever else is going on. */
const WHILE_MENU_OPEN =
  "has-[[data-state=open]]:not-sr-only has-[[data-state=open]]:flex";

/**
 * Everything just left of a row's status slot, one rule for cards and parked
 * rows alike, and never inside the slot: the slot's glyph and time stay put.
 *
 * - While the app modifier is held, bb's jump key for the row.
 * - Otherwise `rest` (a parked row's wake countdown) at rest, and the row's
 *   actions on hover or keyboard focus.
 *
 * A touch device never draws the actions. It has no hover, and hover variants
 * only apply where the pointer can hover, so the strip stays visually hidden
 * and the row menu, on long-press, is where a finger parks a thread. A screen
 * reader still reaches the buttons, since it cannot long-press.
 *
 * The actions stay mounted throughout. Visually hidden at rest rather than
 * removed, so Tab and Shift+Tab reach them from either neighbour; hidden while
 * the key pill shows, but still there, so a menu open from one survives the
 * modifier being pressed; and drawn for as long as one of their menus is open.
 */
export function RowAside({
  row,
  shortcut,
  rest,
  children,
}: {
  row: keyof typeof REVEAL;
  shortcut: PluginSidebarThreadShortcut | null;
  rest?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className="flex shrink-0 items-center">
      {shortcut !== null ? (
        <ShortcutPill shortcut={shortcut} />
      ) : rest != null ? (
        <span className={cn("pointer-events-none flex items-center", REVEAL[row].rest)}>
          {rest}
        </span>
      ) : null}
      <span
        className={cn(
          "pointer-events-auto items-center gap-0.5",
          shortcut !== null ? "hidden" : REVEAL[row].actions,
          WHILE_MENU_OPEN,
        )}
      >
        {children}
      </span>
    </span>
  );
}
