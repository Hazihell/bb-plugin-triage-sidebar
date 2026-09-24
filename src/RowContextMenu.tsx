import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
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
 * duplication is the point. A touch device draws no strip, so on a phone this
 * menu, opened by long-press, is the only way to settle or snooze.
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
  const longPress = useTouchLongPress();

  return (
    <ContextMenu onOpenChange={setOpen}>
      <ContextMenuTrigger asChild {...longPress.trigger}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        aria-label="Thread actions"
        className="min-w-44"
        {...longPress.content}
      >
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

/** bb's own row menu waits as long, and forgives as much drift. */
const LONG_PRESS_MS = 700;
const LONG_PRESS_SLOP_PX = 10;

/**
 * A long-press that survives a finger's natural drift.
 *
 * Radix opens the menu on a held touch too, but drops the press at the first
 * pointer move, and a real finger moves a pixel or two while it is held: on
 * iOS, which sends no contextmenu event of its own, that made the menu
 * unreliable, and it is now the only way to park on a phone. This does what
 * bb's thread list does instead: it lets the finger drift up to 10px, then
 * opens the menu by sending the trigger the contextmenu event Radix already
 * answers, at the point pressed. A native contextmenu (Android sends one)
 * cancels the pending press, so the menu opens once.
 *
 * The finger is still down when the menu opens, and the menu opens under it,
 * so the click that ends the press would land on whichever item is there:
 * Settle, say. Until the next deliberate press or key, clicks on the row and
 * in the menu are swallowed.
 */
function useTouchLongPress() {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ pointerId: number; x: number; y: number } | null>(
    null,
  );
  const fired = useRef(false);

  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };
  useEffect(() => cancel, []);

  const rearm = () => {
    fired.current = false;
  };
  const swallow = (event: MouseEvent<HTMLElement>) => {
    if (!fired.current) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    trigger: {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        rearm();
        if (event.pointerType !== "touch" && event.pointerType !== "pen") {
          return;
        }
        if (!event.isPrimary) return;
        cancel();
        const target = event.currentTarget;
        const { pointerId, clientX, clientY } = event;
        origin.current = { pointerId, x: clientX, y: clientY };
        timer.current = window.setTimeout(() => {
          timer.current = null;
          origin.current = null;
          fired.current = true;
          target.dispatchEvent(
            new window.MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX,
              clientY,
            }),
          );
        }, LONG_PRESS_MS);
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        const start = origin.current;
        if (start === null || start.pointerId !== event.pointerId) return;
        if (
          Math.abs(event.clientX - start.x) > LONG_PRESS_SLOP_PX ||
          Math.abs(event.clientY - start.y) > LONG_PRESS_SLOP_PX
        ) {
          cancel();
        }
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onContextMenu: () => {
        if (timer.current !== null) fired.current = true;
        cancel();
      },
      onClickCapture: swallow,
      onKeyDownCapture: rearm,
    },
    content: {
      onPointerDownCapture: rearm,
      onKeyDownCapture: rearm,
      onClickCapture: swallow,
    },
  };
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
