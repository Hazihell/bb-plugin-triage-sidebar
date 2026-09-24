import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  type PluginSidebarThread,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { cn } from "./lib/utils";
import { Disc } from "./Disc";
import { StatusGlyph } from "./StatusGlyph";
import { childrenOf } from "./inbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./components/DropdownMenu";

const MAX_DISCS = 3;

/**
 * The home for child threads the flat list hides: a chip in the thread header
 * that opens the list of this thread's children.
 *
 * These are bb CHILD THREADS — forks, side chats, and plugin-spawned threads.
 * bb's in-turn subagents are activity counters on the parent, not threads, so
 * the label deliberately says "children".
 *
 * A real menu, portaled out of the header with the plugin's style scope, so
 * it is never clipped by the header, flips to stay on screen, closes on
 * Escape and outside click, and moves between children with the arrow keys
 * and type-ahead — none of which a hand-rolled absolute panel did.
 */
export function SubagentsChip({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const { threads } = useSidebarThreads();
  const actions = useSidebarThreadActions();

  const children = childrenOf(threads, threadId);
  if (children.length === 0) return null;

  const needsYou = children.some((child) => child.hasPendingInteraction);
  const label = needsYou ? "Needs you" : `${children.length} children`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${children.length} child threads`}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-full border border-border px-2 text-2xs text-muted-foreground outline-none",
            "hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
            "data-[state=open]:bg-state-active data-[state=open]:text-foreground",
          )}
        >
          <DiscCluster threads={children} />
          {isCompactViewport ? null : <span className="truncate">{label}</span>}
        </button>
      </DropdownMenuTrigger>
      {/* Named by its trigger: Radix labels the menu with the button that
          opened it, and that label wins over any aria-label here. */}
      <DropdownMenuContent
        align="end"
        className="w-80 max-w-[calc(100vw-1rem)]"
      >
        <DropdownMenuLabel className="flex items-center gap-2">
          <span className="font-semibold text-foreground">Children</span>
          <span className="ml-auto text-2xs font-normal">
            {children.length}
          </span>
        </DropdownMenuLabel>
        {children.map((child) => (
          <DropdownMenuItem
            key={child.id}
            textValue={child.displayTitle}
            onSelect={() => actions.open(child.id)}
            className="py-1.5"
          >
            <Disc thread={child} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-xs">{child.displayTitle}</span>
              <span className="truncate text-2xs text-muted-foreground">
                {child.originKind ?? "thread"}
              </span>
            </span>
            <StatusGlyph
              indicator={child.indicator}
              label={child.indicatorLabel}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DiscCluster({ threads }: { threads: readonly PluginSidebarThread[] }) {
  const shown = threads.slice(0, MAX_DISCS);
  return (
    <span className="flex shrink-0 items-center" aria-hidden>
      {shown.map((thread, index) => (
        <span key={thread.id} className={cn(index > 0 && "-ml-1.5")}>
          <Disc thread={thread} />
        </span>
      ))}
      {threads.length > MAX_DISCS ? (
        <span className="-ml-1.5">
          <Disc thread={null} />
        </span>
      ) : null}
    </span>
  );
}
