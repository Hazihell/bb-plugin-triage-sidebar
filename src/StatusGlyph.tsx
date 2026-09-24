import type { PluginSidebarThreadIndicator } from "@get-bb/plugin-sdk";
import { Icon } from "./components/Icon";
import { cn } from "./lib/utils";

/**
 * This plugin's status glyphs, matching bb's own sidebar shape for shape: the
 * red circle-x for a failure, the circle-question for a raised hand, the
 * spinner for live work, and a dot for a finished thread you have not read.
 *
 * The SDK ships `indicator` as data and no status component on purpose, so a
 * replaced sidebar can choose its own look. This one deliberately does not:
 * the two lists sit in the same window, and a user who switches between them
 * should not have to learn a second vocabulary.
 *
 * An unrecognized indicator draws nothing: bb adds kinds over time, and a
 * plugin built today must not break on a kind shipped tomorrow.
 */

/**
 * The host's indicator with this client's unsent draft folded in.
 *
 * bb never reports a draft in `indicator`: a draft lives in one client's
 * composer, and the thread array is the same for every client. So the row
 * composes it here, with bb's own precedence. A thread blocked on you or
 * failed still says so. A working thread with a draft becomes
 * "working-draft", which outranks every other kind of work. A quiet thread
 * shows the draft only when bb has nothing else to say, so an unread result
 * or a queued message is never hidden behind a pencil.
 */
export function composeIndicator(
  indicator: PluginSidebarThreadIndicator,
  hasUnsubmittedDraft: boolean,
  isOwnWorkLive: boolean,
): PluginSidebarThreadIndicator {
  if (!hasUnsubmittedDraft) return indicator;
  if (indicator === "unread-error" || indicator === "waiting-for-input") {
    return indicator;
  }
  if (isOwnWorkLive) return "working-draft";
  return indicator === "none" ? "draft" : indicator;
}

/**
 * Accessible names for the two kinds {@link composeIndicator} adds. The host
 * labels only what it reports, so these copy bb's own wording for them.
 */
export const DRAFT_INDICATOR_LABELS = {
  draft: "Thread has unsubmitted draft",
  "working-draft": "Thread working with unsubmitted draft",
} as const;

/**
 * Colour carries the state, so a glance at the column answers "what does this
 * list want from me" before any icon is read: blue is the machine working,
 * green is a finished turn, red is a failure, amber is the one state that is
 * waiting on the human. Everything else stays neutral — a fifth hue would only
 * dilute the four that mean something.
 *
 * Every value is a bb theme token, never a literal colour. The plugin build
 * emits utilities against the DEFAULT theme's variables, so a hardcoded oklch
 * or a Tailwind gray would keep its own colour under a custom palette and
 * clash with the surface it sits on.
 *
 * `attention` is bb's own "amber dot" token, which is what waiting-for-input
 * is; `timeline-accent` is the default theme's blue and the only blue token
 * the plugin theme exposes.
 */
const LIVE_WORK_COLOR = "text-timeline-accent";
export const WAITING_COLOR = "text-attention";
const IDLE_COLOR = "text-muted-foreground/50";

/**
 * Whether this indicator draws a glyph that speaks for the row.
 *
 * The row gives the glyph and the age ONE slot, so this decides which of the
 * two the user sees. Listed kind by kind rather than "anything but none": an
 * indicator bb ships tomorrow must fall through to the age label, not blank
 * the slot.
 */
export function hasStatusGlyph(
  indicator: PluginSidebarThreadIndicator,
): boolean {
  switch (indicator) {
    case "unread-error":
    case "queued-failed":
    case "waiting-for-input":
    case "queued-waiting":
    case "unread-success":
    case "runtime":
    case "workflow":
    case "background-agent":
    case "background-command":
    case "plan-mode":
    case "goal":
    case "draft":
    case "working-draft":
      return true;
    default:
      return false;
  }
}

export function StatusGlyph({
  indicator,
  label,
  className,
}: {
  indicator: PluginSidebarThreadIndicator;
  label: string | null;
  className?: string;
}) {
  const shared = cn("size-3.5 shrink-0", className);
  const aria = label ?? undefined;

  switch (indicator) {
    case "unread-error":
    // A message that never sent is a failure the user has to act on, so it
    // takes the failure glyph, as it does in bb's list.
    case "queued-failed":
      return (
        <Icon
          name="CircleX"
          aria-label={aria}
          className={cn(shared, "text-destructive")}
        />
      );
    case "waiting-for-input":
      // Full strength, unlike every other glyph: this is the only state where
      // nothing moves until the user acts, and a muted icon read as "later".
      return (
        <Icon
          name="CircleQuestion"
          aria-label={aria}
          className={cn(shared, WAITING_COLOR)}
        />
      );
    case "queued-waiting":
      // Neutral, not amber: the message will send by itself when the turn
      // ends, so nothing here is waiting on the human.
      return (
        <Icon
          name="Clock"
          aria-label={aria}
          className={cn(shared, "text-muted-foreground/75")}
        />
      );
    case "runtime":
      return (
        <Icon
          name="Loading"
          aria-label={aria}
          className={cn(shared, "animate-spin", LIVE_WORK_COLOR)}
        />
      );
    case "workflow":
      return (
        <ShineIcon
          name="Workflow"
          label={aria}
          color={LIVE_WORK_COLOR}
          className={shared}
        />
      );
    case "background-agent":
      return (
        <ShineIcon
          name="UserRoundPlus"
          label={aria}
          color={LIVE_WORK_COLOR}
          className={shared}
        />
      );
    case "background-command":
      return (
        <ShineIcon
          name="Terminal"
          label={aria}
          color={LIVE_WORK_COLOR}
          className={shared}
        />
      );
    case "plan-mode":
      return (
        <ShineIcon
          name="ListTodo"
          label={aria}
          color={IDLE_COLOR}
          className={shared}
        />
      );
    case "goal":
      return (
        <ShineIcon
          name="Target"
          label={aria}
          color={IDLE_COLOR}
          className={shared}
        />
      );
    case "draft":
      return (
        <Icon
          name="Edit"
          aria-label={aria}
          className={cn(shared, "text-muted-foreground")}
        />
      );
    case "working-draft":
      // The pencil in the live-work colour: the draft is yours, the run is
      // the machine's, and the row has to say both.
      return (
        <ShineIcon
          name="Edit"
          label={aria}
          color={LIVE_WORK_COLOR}
          className={shared}
        />
      );
    case "unread-success":
      // The notification dot, in a box the size of every other glyph, the way
      // bb centers its own trailing indicators. Right-aligned on its own, a
      // 5px dot would sit ~4px off the column the icons share.
      return (
        <span
          aria-label={aria}
          className={cn("flex items-center justify-center", shared)}
        >
          <span className="size-[5px] rounded-full bg-success" />
        </span>
      );
    case "none":
      return null;
    default:
      return null;
  }
}

function ShineIcon({
  name,
  label,
  color,
  className,
}: {
  name:
    | "Workflow"
    | "UserRoundPlus"
    | "Terminal"
    | "ListTodo"
    | "Target"
    | "Edit";
  label: string | undefined;
  color: string;
  className: string;
}) {
  return (
    <Icon
      name={name}
      aria-label={label}
      className={cn("animate-shine-icon", color, className)}
    />
  );
}
