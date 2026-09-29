import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useProviders as useProviders,
  experimental_useSidebarThreads as useSidebarThreads,
  type PluginSidebarThread,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "./components/Icon";
import { cn } from "./lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/Select";
import { ThreadCard } from "./ThreadCard";
import type { ParkMenuActions } from "./RowContextMenu";
import { SlimRow } from "./SlimRow";
import { isWorking, useLifecycle } from "./useLifecycle";
import { useCacheWindow } from "./useCacheWindow";
import { usePorts } from "./usePorts";
import { useClock } from "./clock";
import type { CacheWindow } from "./cache-window";
import { useProjectAvatars } from "./useProjectAvatars";
import { ProjectAvatar } from "./ProjectAvatar";
import { TRAILING_GLYPH_BOX_CLASS } from "./StatusSlot";
import {
  filterByProject,
  hideChildrenOfVisibleParents,
  partitionPinned,
  sortByAttentionDescending,
  visibleInboxThreads,
} from "./inbox";
import { useFlipReorder } from "./useFlipReorder";
import { ListEmpty, ListError, ListSkeleton, StaleNotice } from "./ListStates";
import { holdOrder, OrderHoldContext, useOrderFreeze } from "./useOrderFreeze";

const ALL_PROJECTS = "__all__";

/**
 * The sidebar's scrolling list: one flat stack of cards, ordered by attention.
 *
 * Ordering by attention means rows move. Two rules keep that from becoming
 * noise. The order holds still while the user is using the list — pointer
 * over it, a row focused from the keyboard, a row's menu open — so the row
 * under the pointer is the row they meant. And when it catches up, each row
 * that changed rank slides from where it was, once, so the user sees a thread
 * travel rather than a different list.
 *
 * The host owns the New-thread button and thread search (the quick
 * palette), so this ships neither. It keeps only the one control the host has
 * no equivalent for: the project scope picker.
 */
export function ThreadInbox({
  activeThreadId,
  onNavigate,
}: PluginThreadListProps) {
  const { status, threads, projects } = useSidebarThreads();
  const { providers } = useProviders();
  const lifecycle = useLifecycle(threads);
  const avatars = useProjectAvatars();
  const cacheWindow = useCacheWindow();
  const [scope, setScope] = useState<string>(ALL_PROJECTS);
  // One clock for every card in a render, quantized to the minute so the
  // labels do not disagree and do not churn on unrelated re-renders.
  const now = useClock("minute");
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [showSettled, setShowSettled] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { frozen, orderHold } = useOrderFreeze(scrollRef);

  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );

  // Counted over every thread the host reports, not the filtered list: the
  // children whose work this reports are exactly the rows the list has
  // removed, and a project scope must not make a parent look idle.
  const childWorkByParent = useMemo(() => {
    const counts = new Map<string, { running: number; needingYou: number }>();
    for (const thread of threads) {
      if (thread.parentThreadId === null) continue;
      const entry = counts.get(thread.parentThreadId) ?? {
        running: 0,
        needingYou: 0,
      };
      if (isWorking(thread)) entry.running += 1;
      if (thread.hasPendingInteraction) entry.needingYou += 1;
      counts.set(thread.parentThreadId, entry);
    }
    return counts;
  }, [threads]);
  const noChildWork = { running: 0, needingYou: 0 };

  const live = useMemo(() => {
    const scoped = filterByProject(
      visibleInboxThreads(threads),
      scope === ALL_PROJECTS ? null : scope,
    );
    // Children live in their parent's header chip instead of the flat list;
    // an orphan whose parent is not on screen stays here.
    const matched = hideChildrenOfVisibleParents(scoped);
    const active: typeof matched = [];
    const onSnoozeShelf: typeof matched = [];
    const onSettledShelf: typeof matched = [];
    for (const thread of matched) {
      const shelf = lifecycle.shelfFor(thread);
      if (shelf === "snoozed") onSnoozeShelf.push(thread);
      else if (shelf === "settled") onSettledShelf.push(thread);
      else active.push(thread);
    }
    const split = partitionPinned(active);
    // Every shelf reads the same ranking, including the parked ones: a user
    // who opens Snoozed is asking the same question as everywhere else, and a
    // second ordering rule would be one more thing to learn.
    return {
      pinned: sortByAttentionDescending(split.pinned, lifecycle.isBusy),
      inbox: sortByAttentionDescending(split.inbox, lifecycle.isBusy),
      snoozed: sortByAttentionDescending(onSnoozeShelf, lifecycle.isBusy),
      settled: sortByAttentionDescending(onSettledShelf, lifecycle.isBusy),
    };
  }, [lifecycle, scope, threads]);

  // Only the rows this list can show are scanned for; a child shares its
  // parent's worktree, and one scan per machine covers every directory.
  const ports = usePorts(
    useMemo(
      () => [...live.pinned, ...live.inbox, ...live.snoozed, ...live.settled],
      [live],
    ),
  );

  // What changed underneath the list without the user seeing it happen: the
  // host's threads or the parking store landing, or a different project.
  // Order changes across one of these are adopted at once, frozen or not, and
  // never slide.
  const loadKey = `${status}|${lifecycle.source}|${lifecycle.status}|${scope}`;

  // While frozen, each shelf keeps the order it last showed (see holdOrder);
  // the ids it showed are recorded after every commit.
  const shownIds = useRef<Record<SectionName, readonly string[]>>(NO_SECTIONS);
  const shownLoadKey = useRef(loadKey);
  const { pinned, inbox, snoozed, settled } = useMemo(() => {
    if (!frozen || shownLoadKey.current !== loadKey) return live;
    return {
      pinned: holdOrder(shownIds.current.pinned, live.pinned),
      inbox: holdOrder(shownIds.current.inbox, live.inbox),
      snoozed: holdOrder(shownIds.current.snoozed, live.snoozed),
      settled: holdOrder(shownIds.current.settled, live.settled),
    };
  }, [frozen, live, loadKey]);
  useLayoutEffect(() => {
    shownLoadKey.current = loadKey;
    shownIds.current = {
      pinned: pinned.map((thread) => thread.id),
      inbox: inbox.map((thread) => thread.id),
      snoozed: snoozed.map((thread) => thread.id),
      settled: settled.map((thread) => thread.id),
    };
  }, [inbox, loadKey, pinned, settled, snoozed]);

  // Opening or closing a shelf moves the rows below it, and that is not a
  // re-rank either.
  useFlipReorder(scrollRef, `${loadKey}|${showSnoozed}|${showSettled}`);

  // One bundle per row, built where the lifecycle store lives. The card's
  // hover buttons and the menu's items then drive the same four calls, so the
  // two surfaces can never fall out of step.
  const parkFor = (thread: PluginSidebarThread): ParkMenuActions => ({
    canPark: lifecycle.canPark(thread),
    shelf: lifecycle.shelfFor(thread),
    onSettle: () => lifecycle.settle(thread.id),
    onUnsettle: () => lifecycle.unsettle(thread.id),
    onSnooze: (until) => lifecycle.snooze(thread.id, until),
    onUnsnooze: () => lifecycle.unsnooze(thread.id),
  });

  // Pinned and Inbox are two shelves of the same card, not two kinds of row —
  // their difference is entirely in the ordering above. One renderer keeps it
  // that way: a card gains a prop in one place, and both shelves get it.
  const renderCard = (thread: PluginSidebarThread) => (
    <ThreadCard
      key={thread.id}
      thread={thread}
      projectName={projectNameById.get(thread.projectId) ?? null}
      projectAvatar={avatars.rows.get(thread.projectId)}
      provider={providerById.get(thread.providerId) ?? null}
      isActive={thread.id === activeThreadId}
      park={parkFor(thread)}
      onNavigate={onNavigate}
      startedWorkingAt={lifecycle.startedWorkingAtFor(thread.id)}
      lastRunEndedAt={lifecycle.lastRunEndedAtFor(thread.id)}
      childWork={childWorkByParent.get(thread.id) ?? noChildWork}
      cacheWindow={cacheWindow}
      now={now}
      ports={ports.get(thread.id)}
    />
  );

  const scopeLabel =
    scope === ALL_PROJECTS
      ? "All projects"
      : (projectNameById.get(scope) ?? "All projects");
  // A scope pointing at a project the host no longer reports falls back to
  // the "All projects" label above, so the avatar has to fall away with it
  // rather than colouring a name that is not being shown.
  const scopeProject =
    scope === ALL_PROJECTS ? null : (projects.find((p) => p.id === scope) ?? null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The one control the host has no equivalent for. Everything else in
          the chrome above — New thread, search — is bb's and stays bb's. */}
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1">
        <Select value={scope} onValueChange={setScope}>
          {/* Ghost trigger: no border, no filled track — it reads as a label
              until you hover it. */}
          <SelectTrigger
            className="h-7 min-w-0 flex-1 cursor-pointer border-0 px-1.5 py-1 text-xs font-medium text-muted-foreground shadow-none hover:bg-sidebar-accent focus:ring-0"
            aria-label={`Project scope: ${scopeLabel}`}
          >
            {/* Children rather than the selected item's own text: the
                trigger has to show the avatar too, and Radix renders only
                text from the item it mirrors. */}
            <SelectValue>
              <span className="flex min-w-0 items-center gap-1.5">
                {scopeProject === null ? null : (
                  <ProjectAvatar
                    project={scopeProject}
                    stored={avatars.rows.get(scopeProject.id)}
                  />
                )}
                <span className="truncate">{scopeLabel}</span>
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {/* "All projects" is a scope, not a project — there is no
                identity to draw, and a placeholder square would invent one. */}
            <SelectItem value={ALL_PROJECTS} className="text-xs">
              All projects
            </SelectItem>
            {projects.map((project) => (
              <SelectItem
                key={project.id}
                value={project.id}
                className="text-xs"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <ProjectAvatar
                    project={project}
                    stored={avatars.rows.get(project.id)}
                  />
                  <span className="truncate">{project.name}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Positioned, so it is every row's offset parent and the slide can
          measure rows by layout alone. */}
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-y-auto px-1.5 pb-2"
      >
        <OrderHoldContext.Provider value={orderHold}>
        {status === "loading" ||
        (lifecycle.source === "none" && lifecycle.status === "loading") ? (
          <ListSkeleton />
        ) : status === "error" ? (
          <ListError title="Couldn't load threads" detail={null} />
        ) : lifecycle.source === "none" ? (
          // Never the threads unshelved: without the store, settled threads
          // would sit in the inbox as if they needed the user.
          <ListError
            title="Couldn't load snoozed and settled threads"
            detail={lifecycle.error}
            onRetry={lifecycle.retry}
          />
        ) : pinned.length + inbox.length + snoozed.length + settled.length ===
          0 ? (
          <ListEmpty
            scopeName={scope === ALL_PROJECTS ? null : scopeLabel}
          />
        ) : (
          <>
            {lifecycle.status === "error" ? (
              <StaleNotice onRetry={lifecycle.retry} />
            ) : null}
            {pinned.length > 0 ? (
              <Shelf label="Pinned">
                {pinned.map(renderCard)}
              </Shelf>
            ) : null}
            {inbox.length > 0 ? (
              <Shelf label={pinned.length > 0 ? "Inbox" : null}>
                {inbox.map(renderCard)}
              </Shelf>
            ) : null}
            <ParkedShelf
              label="Snoozed"
              threads={snoozed}
              expanded={showSnoozed}
              onToggle={() => setShowSnoozed((open) => !open)}
              shelf="snoozed"
              activeThreadId={activeThreadId}
              lifecycle={lifecycle}
              parkFor={parkFor}
              onNavigate={onNavigate}
              now={now}
              cacheWindow={cacheWindow}
              ports={ports}
            />
            <ParkedShelf
              label="Settled"
              threads={settled}
              expanded={showSettled}
              onToggle={() => setShowSettled((open) => !open)}
              shelf="settled"
              activeThreadId={activeThreadId}
              lifecycle={lifecycle}
              parkFor={parkFor}
              onNavigate={onNavigate}
              now={now}
              cacheWindow={cacheWindow}
              ports={ports}
            />
          </>
        )}
        </OrderHoldContext.Provider>
      </div>
    </div>
  );
}

type SectionName = "pinned" | "inbox" | "snoozed" | "settled";
const NO_SECTIONS: Record<SectionName, readonly string[]> = {
  pinned: [],
  inbox: [],
  snoozed: [],
  settled: [],
};

/**
 * A collapsed shelf of parked threads. The header stays while anything is
 * parked — the count is the whole footprint when collapsed — and the shelf
 * vanishes entirely at zero.
 */
function ParkedShelf({
  label,
  threads,
  expanded,
  onToggle,
  shelf,
  activeThreadId,
  lifecycle,
  parkFor,
  onNavigate,
  now,
  cacheWindow,
  ports,
}: {
  label: string;
  threads: readonly PluginSidebarThread[];
  expanded: boolean;
  onToggle: () => void;
  shelf: "snoozed" | "settled";
  activeThreadId: string | null;
  lifecycle: ReturnType<typeof useLifecycle>;
  parkFor: (thread: PluginSidebarThread) => ParkMenuActions;
  onNavigate: () => void;
  now: number;
  cacheWindow: CacheWindow;
  ports: ReadonlyMap<string, readonly number[]>;
}) {
  if (threads.length === 0) return null;
  return (
    <section aria-label={label}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        // Padded like a card, so the chevron ends on the same right edge as
        // every row's status and provider glyph.
        className="mt-3 flex w-full cursor-pointer items-center gap-2 px-2.5 pb-1 text-left"
      >
        <span className="text-2xs font-medium text-muted-foreground/70">
          {expanded ? label : `${label} (${threads.length})`}
        </span>
        <span className="h-px flex-1 bg-sidebar-border" />
        <span className={TRAILING_GLYPH_BOX_CLASS}>
          <Icon
            name="ChevronDown"
            className={cn(
              "size-3 text-muted-foreground/70 transition-transform",
              expanded && "rotate-180",
            )}
          />
        </span>
      </button>
      {expanded ? (
        <ul className="flex flex-col gap-px">
          {threads.map((thread) => (
            <SlimRow
              key={thread.id}
              thread={thread}
              isActive={thread.id === activeThreadId}
              shelf={shelf}
              wakeAt={lifecycle.wakeAtFor(thread)}
              now={now}
              startedWorkingAt={lifecycle.startedWorkingAtFor(thread.id)}
              lastRunEndedAt={lifecycle.lastRunEndedAtFor(thread.id)}
              cacheWindow={cacheWindow}
              park={parkFor(thread)}
              onNavigate={onNavigate}
              ports={ports.get(thread.id)}
              onRestore={() =>
                shelf === "snoozed"
                  ? lifecycle.unsnooze(thread.id)
                  : lifecycle.unsettle(thread.id)
              }
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Shelf({
  label,
  children,
}: {
  label: string | null;
  children: React.ReactNode;
}) {
  return (
    // A named section is exposed as a landmark region; an unnamed one is not,
    // which is exactly right for the single unlabelled inbox list.
    <section {...(label ? { "aria-label": label } : {})}>
      {label ? (
        <h2 className={cn("flex items-center gap-2 px-2.5 pb-1 pt-3")}>
          <span className="text-2xs font-medium text-muted-foreground/70">
            {label}
          </span>
          <span className="h-px flex-1 bg-sidebar-border" />
        </h2>
      ) : null}
      <ul className="flex flex-col gap-px">{children}</ul>
    </section>
  );
}
