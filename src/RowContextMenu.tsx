import type { ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { cn } from "./lib/utils";
import { resolveSnoozePresets, type ThreadShelf } from "./lifecycle";

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
 * The park actions live here as well as on the card's hover buttons, and that
 * duplication is the point. Hover does not exist on a touch device, so the
 * card's buttons put settle and snooze out of reach there entirely; and even
 * on a desktop the card only has room for ONE snooze preset. Radix opens this
 * menu on long-press, so listing the presets here makes every one of them
 * reachable on both.
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

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          aria-label="Thread actions"
          className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {/* Parking is this plugin's reason to exist, so it leads the menu.
              A thread that is working or holding a question is not parkable at
              all — hiding the items says that more honestly than a disabled
              row the user keeps trying to click. */}
          {park?.canPark ? (
            <>
              <ParkItems park={park} />
              <Separator />
            </>
          ) : null}
          <Item onSelect={() => actions.open(thread.id, { split: true })}>
            Open in split
          </Item>
          <Separator />
          <Item
            onSelect={() => void actions.setRead(thread.id, thread.isUnread)}
          >
            {thread.isUnread ? "Mark read" : "Mark unread"}
          </Item>
          <Item
            onSelect={() => void actions.setPinned(thread.id, !thread.isPinned)}
          >
            {thread.isPinned ? "Unpin" : "Pin"}
          </Item>
          <Separator />
          <Item onSelect={() => actions.archive(thread.id)}>Archive</Item>
          <Item destructive onSelect={() => actions.requestDelete(thread.id)}>
            Delete
          </Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function ParkItems({ park }: { park: ParkMenuActions }) {
  const isSettled = park.shelf === "settled";
  const isSnoozed = park.shelf === "snoozed";

  return (
    <>
      <Item onSelect={isSettled ? park.onUnsettle : park.onSettle}>
        {isSettled ? "Un-settle" : "Settle"}
      </Item>
      {isSnoozed ? (
        <Item onSelect={park.onUnsnooze}>Wake now</Item>
      ) : (
        // Presets are resolved when the menu renders, not once at module load:
        // "This evening" drops out of the list after 5pm, and a list computed
        // at load would still be offering it at midnight.
        <ContextMenu.Sub>
          <ContextMenu.SubTrigger className={ITEM_CLASS}>
            Snooze
          </ContextMenu.SubTrigger>
          <ContextMenu.Portal>
            {/* No aria-label: Radix labels a submenu from its trigger, and an
                aria-labelledby always beats an aria-label, so one here would
                be dead markup that reads as if it worked. */}
            <ContextMenu.SubContent
              className="z-50 min-w-36 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
            >
              {resolveSnoozePresets(new Date()).map((preset) => (
                <Item
                  key={preset.id}
                  onSelect={() => park.onSnooze(preset.snoozedUntil)}
                >
                  {preset.label}
                </Item>
              ))}
            </ContextMenu.SubContent>
          </ContextMenu.Portal>
        </ContextMenu.Sub>
      )}
    </>
  );
}

const ITEM_CLASS = cn(
  "cursor-pointer rounded-md px-2 py-1.5 text-sm outline-none",
  "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
);

function Item({
  children,
  destructive = false,
  onSelect,
}: {
  children: ReactNode;
  destructive?: boolean;
  onSelect: () => void;
}) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className={cn(ITEM_CLASS, destructive && "text-destructive-text")}
    >
      {children}
    </ContextMenu.Item>
  );
}

function Separator() {
  return <ContextMenu.Separator className="my-1 h-px bg-border" />;
}
