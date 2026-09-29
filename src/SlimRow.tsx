import {
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  ThreadTitle,
  useSidebarThreadShortcut,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "./components/Icon";
import { cn } from "./lib/utils";
import { RowContextMenu, type ParkMenuActions } from "./RowContextMenu";
import { STATUS_SLOT_CLASS, StatusOrTime } from "./StatusSlot";
import { ThreadRowLink } from "./ThreadRowLink";
import { ROW_ACTION_BUTTON_CLASS, RowAside } from "./RowAside";
import { snoozeWakeLabel } from "./lifecycle";
import type { CacheWindow } from "./cache-window";
import { PortsMenu } from "./PortsMenu";
import type { PortListing } from "./host-contract";

/**
 * A parked thread: one line instead of a card. Density comes from the user
 * actually parking work, never from the sidebar guessing what still matters.
 *
 * Same structure as the card — a full-bleed anchor under the restore button,
 * because a `<button>` inside an `<a>` is invalid interactive nesting.
 */
export function SlimRow({
  thread,
  isActive,
  shelf,
  wakeAt,
  now,
  startedWorkingAt,
  lastRunEndedAt,
  cacheWindow,
  park,
  onNavigate,
  onRestore,
  ports,
}: {
  thread: PluginSidebarThread;
  isActive: boolean;
  shelf: "snoozed" | "settled";
  wakeAt: number | null;
  now: number;
  /** The card's clock inputs, so a parked row reads the same time. */
  startedWorkingAt: number | null;
  lastRunEndedAt: number | null;
  cacheWindow: CacheWindow;
  /** Parking from the right-click / long-press menu, as on a card. */
  park: ParkMenuActions;
  onNavigate: () => void;
  onRestore: () => void;
  /** What this thread's worktree is listening on, as on a card. */
  ports?: PortListing;
}) {
  const split = useSidebarThreadSplit(thread.id);
  const shortcut = useSidebarThreadShortcut(thread.id);
  // A countdown rounds UP, so it reads the real time rather than the list's
  // clock, which is floored to the minute: floored, a snooze of one hour
  // would read "2h" for its first minute.
  const wakeLabel =
    shelf === "snoozed" && wakeAt !== null
      ? snoozeWakeLabel(wakeAt, Math.max(now, Date.now()))
      : null;

  return (
    <RowContextMenu thread={thread} park={park}>
      <li className="list-none">
        <div
          className={cn(
            "group/slim relative flex h-8 items-center gap-2 rounded-md px-2.5 text-xs [@media(hover:none)]:select-none",
            isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
          )}
        >
          <ThreadRowLink
            thread={thread}
            split={split}
            shortcut={shortcut}
            onNavigate={onNavigate}
          />
          <span
            className={cn(
              "pointer-events-none relative min-w-0 flex-1 truncate",
              isActive ? "text-foreground" : "text-muted-foreground/70",
              "group-hover/slim:text-foreground",
            )}
          >
            <ThreadTitle threadId={thread.id} />
          </span>
          <PortsMenu threadId={thread.id} listing={ports} />
          {/* Left of the slot, as on a card: the jump key while the modifier
              is held; otherwise, for a snoozed row, when it comes back, which
              yields on hover to the restore button. The slot itself keeps the
              card's glyph and clock, in the card's column. */}
          <RowAside
            row="slim"
            shortcut={shortcut}
            rest={
              wakeLabel === null ? null : (
                <span
                  aria-label={`Wakes in ${wakeLabel}`}
                  className="flex items-center gap-0.5 text-2xs tabular-nums text-muted-foreground/60"
                >
                  <Icon name="Clock" className="size-3" aria-hidden />
                  {wakeLabel}
                </span>
              )
            }
          >
            <button
              type="button"
              aria-label={
                shelf === "snoozed" ? "Wake thread now" : "Un-settle thread"
              }
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRestore();
              }}
              className={ROW_ACTION_BUTTON_CLASS}
            >
              <Icon
                name={shelf === "snoozed" ? "Clock" : "ArrowTurnBackward"}
                className="size-3.5"
              />
            </button>
          </RowAside>
          <span
            className={cn(STATUS_SLOT_CLASS, "pointer-events-none relative")}
          >
            <StatusOrTime
              thread={thread}
              now={now}
              startedWorkingAt={startedWorkingAt}
              lastRunEndedAt={lastRunEndedAt}
              cacheWindow={cacheWindow}
            />
          </span>
        </div>
      </li>
    </RowContextMenu>
  );
}
