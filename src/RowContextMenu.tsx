import { useState, type ReactNode } from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./components/ContextMenu";
import { resolveSnoozePresets, type ThreadShelf } from "./lifecycle";
import { useHoldOrderWhile } from "./useOrderFreeze";

/**
 * Everything the menu needs to park a thread, supplied by whoever owns the
 * lifecycle store rather than read here: the row components already receive
 * their shelf and their handlers, and a second reader of the store would give
 * the menu a chance to disagree with the row it was opened from.
 */
export interface ParkMenuActions {
  /** False while the thread is working or blocked on the user. */
  canPark: boolean;
  shelf: ThreadShelf;
  onSettle: () => void;
  onUnsettle: () => void;
  onSnooze: (snoozedUntil: number) => void;
  onUnsnooze: () => void;
}

/**
 * This sidebar's own right-click menu.
 *
 * The plugin API ships no menu component on purpose, so a replaced sidebar
 * owns this surface. The host actions below are one call each on
 * `experimental_useSidebarThreadActions`, and the destructive one is
 * `requestDelete`, which opens BB's confirmation rather than deleting a
 * subtree silently.
 *
 * The park actions live here as well as on the card's hover strip, and that
 * duplication is the point. Hover does not exist on a touch device, so the
 * strip puts settle and snooze out of reach there entirely. Radix opens this
 * menu on long-press, so every preset is reachable on both.
 */
export function RowContextMenu({
  thread,
  park,
  children,
}: {
  thread: PluginSidebarThread;
  /**
   * Omitted by a caller that has no lifecycle store to hand; the menu then
   * shows the host actions alone rather than offering a park that goes
   * nowhere.
   */
  park?: ParkMenuActions;
  children: ReactNode;
}) {
  const actions = useSidebarThreadActions();
  // Portaled out of the list, so the pointer leaves the list for the menu:
  // the row must not re-rank out from under the menu it opened.
  const [open, setOpen] = useState(false);
  useHoldOrderWhile(open);

  return (
    <ContextMenu onOpenChange={setOpen}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent aria-label="Thread actions" className="min-w-44">
        {/* Parking is this plugin's reason to exist, so it leads the menu.
            A thread that is working or holding a question is not parkable at
            all — hiding the items says that more honestly than a disabled
            row the user keeps trying to click. */}
        {park?.canPark ? (
          <>
            <ParkItems park={park} />
            <ContextMenuSeparator />
          </>
        ) : null}
        <ContextMenuItem
          onSelect={() => actions.open(thread.id, { split: true })}
        >
          Open in split
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => void actions.setRead(thread.id, thread.isUnread)}
        >
          {thread.isUnread ? "Mark read" : "Mark unread"}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => void actions.setPinned(thread.id, !thread.isPinned)}
        >
          {thread.isPinned ? "Unpin" : "Pin"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.archive(thread.id)}>
          Archive
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          onSelect={() => actions.requestDelete(thread.id)}
        >
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ParkItems({ park }: { park: ParkMenuActions }) {
  const isSettled = park.shelf === "settled";
  const isSnoozed = park.shelf === "snoozed";

  return (
    <>
      <ContextMenuItem onSelect={isSettled ? park.onUnsettle : park.onSettle}>
        {isSettled ? "Un-settle" : "Settle"}
      </ContextMenuItem>
      {isSnoozed ? (
        <ContextMenuItem onSelect={park.onUnsnooze}>Wake now</ContextMenuItem>
      ) : (
        // Presets are resolved when the menu renders, not once at module load:
        // "This evening" drops out of the list after 5pm, and a list computed
        // at load would still be offering it at midnight.
        <ContextMenuSub>
          <ContextMenuSubTrigger>Snooze</ContextMenuSubTrigger>
          {/* No aria-label: Radix labels a submenu from its trigger, and an
              aria-labelledby always beats an aria-label, so one here would be
              dead markup that reads as if it worked. */}
          <ContextMenuSubContent className="min-w-36">
            {resolveSnoozePresets(new Date()).map((preset) => (
              <ContextMenuItem
                key={preset.id}
                onSelect={() => park.onSnooze(preset.snoozedUntil)}
              >
                {preset.label}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
    </>
  );
}
