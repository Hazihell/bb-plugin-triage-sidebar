import {
  experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  ThreadTitle,
  useSidebarThreadShortcut,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Icon, type IconName } from "./components/Icon";
import { ProjectAvatar } from "./ProjectAvatar";
import type { StoredProjectAvatar } from "./project-avatar";
import { cn } from "./lib/utils";
import { RowContextMenu, type ParkMenuActions } from "./RowContextMenu";
import { ProviderGlyph, type ProviderRecord } from "./ProviderGlyph";
import { ShortcutPill, ThreadRowLink } from "./ThreadRowLink";
import { STATUS_SLOT_CLASS, StatusOrTime } from "./StatusSlot";
import { WAITING_COLOR } from "./StatusGlyph";
import type { CacheWindow } from "./cache-window";
import { resolveSnoozePresets } from "./lifecycle";

/**
 * One thread as a three-line card: project and status, title, then branch and
 * activity. The card is the whole point of this sidebar — status lives in the
 * row instead of in its position, which is what lets the list stay still.
 *
 * The row is a positioned container with a full-bleed anchor UNDER the
 * controls, the way bb's own thread row does it: a `<button>` inside an `<a>`
 * is invalid interactive nesting and breaks keyboard behaviour.
 */
export function ThreadCard({
  thread,
  projectName,
  projectAvatar,
  provider,
  isActive,
  park,
  onNavigate,
  startedWorkingAt,
  lastRunEndedAt,
  childWork,
  cacheWindow,
  now,
}: {
  thread: PluginSidebarThread;
  projectName: string | null;
  /** This project's stored avatar, or undefined for a generated monogram. */
  projectAvatar?: StoredProjectAvatar;
  /**
   * This thread's agent provider from bb's directory, or null while the
   * directory loads or when it does not list the provider.
   */
  provider: ProviderRecord | null;
  isActive: boolean;
  /**
   * Parking, for both surfaces that offer it: the hover buttons below and the
   * right-click / long-press menu. One bundle rather than loose handlers, so
   * the two can never be handed a different answer for the same thread.
   */
  park: ParkMenuActions;
  onNavigate: () => void;
  /**
   * When bb recorded this thread's current run starting, or null when it is
   * not running. Only a working row spends it, as an elapsed label beside the
   * spinner.
   */
  startedWorkingAt: number | null;
  /**
   * When this thread's newest turn ended, from bb's event log, or null when
   * no turn has ended yet.
   */
  lastRunEndedAt: number | null;
  /**
   * This thread's direct children, as counts rather than threads.
   *
   * The list hides a child while its parent is on screen, so a parent with
   * three running subagents otherwise reads as an idle card. Counts, not the
   * children themselves: the card says that work is happening down there and
   * the header chip is where you go to see whose.
   */
  childWork: { running: number; needingYou: number };
  /** Thresholds for the amber idle age. */
  cacheWindow: CacheWindow;
  /** Quantized clock, so every card in one render agrees on "now". */
  now: number;
}) {
  const split = useSidebarThreadSplit(thread.id);
  const shortcut = useSidebarThreadShortcut(thread.id);
  // Opt-in per row: this costs a git-host lookup, and threads sharing a
  // worktree share one.
  const { pullRequest } = useSidebarThreadPullRequest(thread.id);

  return (
    <RowContextMenu thread={thread} park={park}>
      <li className="list-none">
        <div
          className={cn(
            "group/card relative rounded-md px-2.5 py-2 transition-colors",
            isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
            // A thread open in another pane gets a weaker tint than the active
            // row, so the two states stay distinguishable.
            !isActive && split.layout !== null && "bg-sidebar-accent/30",
          )}
        >
          <ThreadRowLink
            thread={thread}
            split={split}
            shortcut={shortcut}
            onNavigate={onNavigate}
          />
          <div className="pointer-events-none relative flex h-5 items-center gap-1.5">
            {/* Grouping, not labelling: the name is right there in words, and
                the chip is what lets the eye sort the column into projects
                before it reads any of it. Nothing here when the project is
                unknown — an avatar for a name we do not have is a coloured
                square that means nothing. */}
            {projectName === null ? null : (
              <ProjectAvatar
                project={{ id: thread.projectId, name: projectName }}
                stored={projectAvatar}
              />
            )}
            <span className="min-w-0 flex-1 truncate text-2xs font-medium text-muted-foreground">
              {projectName ?? " "}
            </span>
            {/* Left of the slot, never in it: the jump key while the
                modifier is held, otherwise the park actions on hover or
                keyboard focus. The slot keeps its glyph and clock through
                all of it. */}
            {shortcut !== null ? (
              <ShortcutPill shortcut={shortcut} />
            ) : park.canPark ? (
              <span className="pointer-events-auto hidden items-center gap-0.5 group-hover/card:flex group-has-[:focus-visible]/card:flex">
                <ParkButton
                  label="Snooze until tomorrow"
                  icon="Clock"
                  onActivate={() =>
                    park.onSnooze(
                      resolveSnoozePresets(new Date())[2]!.snoozedUntil,
                    )
                  }
                />
                <ParkButton
                  label="Settle thread"
                  icon="Check"
                  onActivate={park.onSettle}
                />
              </span>
            ) : null}
            <span className={STATUS_SLOT_CLASS}>
              <StatusOrTime
                thread={thread}
                now={now}
                startedWorkingAt={startedWorkingAt}
                lastRunEndedAt={lastRunEndedAt}
                isChildWorking={childWork.running > 0}
                cacheWindow={cacheWindow}
              />
            </span>
          </div>
          <div
            className={cn(
              // Weight alone carries unread. Fading the title — or the whole
              // card — makes a thread at rest read as disabled, and at rest is
              // what most of the list is most of the time.
              "pointer-events-none relative mt-0.5 truncate text-sm text-foreground",
              thread.isUnread && "font-medium",
            )}
          >
            {/* bb's own title: the resolved text with mention chips drawn
                inline, clipped by this line's truncation. */}
            <ThreadTitle threadId={thread.id} />
          </div>
          <div className="pointer-events-none relative mt-0.5 flex h-4 items-center gap-1.5 text-2xs text-muted-foreground">
            {/* A thread without a worktree still runs somewhere, so the
                machine takes the branch's place rather than leaving the line
                blank. */}
            {thread.environment?.branchName ? (
              <span className="min-w-0 flex-1 truncate font-mono">
                {thread.environment.branchName}
              </span>
            ) : thread.host ? (
              <span className="min-w-0 flex-1 truncate">
                {thread.host.name}
              </span>
            ) : (
              <span className="flex-1" />
            )}
            {thread.activity.workflows > 0 ? (
              <ActivityCount
                label="workflows"
                count={thread.activity.workflows}
              />
            ) : null}
            {thread.activity.backgroundAgents > 0 ? (
              <ActivityCount
                label="background agents"
                count={thread.activity.backgroundAgents}
              />
            ) : null}
            {/* Child threads, in the same family as the counts beside them and
                glyphed rather than bare, because a naked number here would
                read as more of the parent's own activity. */}
            {childWork.running > 0 ? (
              <ActivityCount
                label="running child threads"
                count={childWork.running}
                icon="UserRoundPlus"
              />
            ) : null}
            {childWork.needingYou > 0 ? (
              <ActivityCount
                label="child threads needing you"
                count={childWork.needingYou}
                icon="CircleQuestion"
                // The one thing on this line that is waiting on the human, in
                // the colour the sidebar reserves for exactly that.
                className={WAITING_COLOR}
              />
            ) : null}
            {pullRequest ? (
              <a
                href={pullRequest.url}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => event.stopPropagation()}
                title={pullRequest.title}
                className={cn(
                  "relative shrink-0 font-mono hover:underline",
                  pullRequest.state === "merged"
                    ? "text-[color:var(--pr-merged)]"
                    : pullRequest.attention === "checks_failed" ||
                        pullRequest.attention === "conflicts"
                      ? "text-destructive-text"
                      : pullRequest.attention === "ready_to_merge"
                        ? "text-success-foreground"
                        : "text-muted-foreground",
                )}
              >
                #{pullRequest.number}
              </a>
            ) : null}
            {/* Always drawn, so the line has a fixed right edge. */}
            <ProviderGlyph
              providerId={thread.providerId}
              provider={provider}
            />
          </div>
        </div>
      </li>
    </RowContextMenu>
  );
}

function ParkButton({
  label,
  icon,
  onActivate,
}: {
  label: string;
  icon: Extract<IconName, "Clock" | "Check">;
  onActivate: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onActivate();
      }}
      className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
    >
      <Icon name={icon} className="size-3.5" />
    </button>
  );
}

function ActivityCount({
  label,
  count,
  icon,
  className,
}: {
  label: string;
  count: number;
  /** Drawn before the number when the count alone would not say what of. */
  icon?: Extract<IconName, "UserRoundPlus" | "CircleQuestion">;
  className?: string;
}) {
  return (
    <span
      aria-label={`${count} ${label}`}
      className={cn(
        "flex shrink-0 items-center gap-0.5 rounded bg-muted px-1 font-mono text-2xs text-muted-foreground",
        className,
      )}
    >
      {icon ? <Icon name={icon} className="size-3" aria-hidden /> : null}
      {count}
    </span>
  );
}
