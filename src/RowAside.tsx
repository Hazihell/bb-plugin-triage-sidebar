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

/** The status slot yields for as long as an action's menu is open. */
const MENU_OPEN_HIDES = "group-has-[[data-state=open]]/aside:hidden";

/**
 * The end of a row: bb's jump key, the row's actions, and its status slot.
 *
 * - While the app modifier is held, bb's jump key for the row, left of the
 *   status slot.
 * - Otherwise `rest` (a parked row's wake countdown) and the status slot at
 *   rest, and the row's actions IN THEIR PLACE on hover or keyboard focus, at
 *   the row's right edge. The actions only ever show while the pointer or
 *   focus is on this row, so covering its clock costs nothing: every other
 *   row still shows its own.
 *
 * A touch device never draws the actions. It has no hover, and hover variants
 * only apply where the pointer can hover, so the strip stays visually hidden
 * and the row menu, on long-press, is where a finger parks a thread. A screen
 * reader still reaches the buttons, since it cannot long-press.
 *
 * The actions stay mounted throughout. Visually hidden at rest rather than
 * removed, so Tab and Shift+Tab reach them from either neighbour; hidden while
 * the key pill shows, but still there, so a menu open from one survives the
 * modifier being pressed; and drawn, with the status slot hidden, for as long
 * as one of their menus is open.
 */
export function RowAside({
  row,
  shortcut,
  rest,
  status,
  children,
}: {
  row: keyof typeof REVEAL;
  shortcut: PluginSidebarThreadShortcut | null;
  rest?: ReactNode;
  /** The status slot, which yields to the actions whenever they show. */
  status: ReactNode;
  /** The row's actions, or null when it has none to offer. */
  children: ReactNode;
}) {
  // A row with nothing to offer (a running thread cannot be parked) keeps its
  // status slot on hover, rather than blanking it for an empty strip.
  const showsActions = shortcut === null && children != null;
  return (
    <span className="group/aside flex shrink-0 items-center">
      {shortcut !== null ? (
        <ShortcutPill shortcut={shortcut} />
      ) : rest != null ? (
        <span
          className={cn(
            "pointer-events-none flex items-center",
            showsActions && REVEAL[row].rest,
          )}
        >
          {rest}
        </span>
      ) : null}
      <span
        className={cn(
          "pointer-events-auto items-center justify-end gap-0.5",
          showsActions ? REVEAL[row].actions : "hidden",
          WHILE_MENU_OPEN,
        )}
      >
        {children}
      </span>
      <span
        className={cn(
          "flex items-center",
          showsActions && [REVEAL[row].rest, MENU_OPEN_HIDES],
        )}
      >
        {status}
      </span>
    </span>
  );
}
