import type { ReactNode } from "react";
import { useClock } from "./clock";
import {
  experimental_Icon as HostIcon,
  useSidebarThreadDraft,
  useSidebarThreadRowStatus,
  type PluginSidebarThread,
  type PluginSidebarThreadRowStatus,
} from "@get-bb/plugin-sdk/app";
import {
  composeIndicator,
  DRAFT_INDICATOR_LABELS,
  StatusGlyph,
  hasStatusGlyph,
  WAITING_COLOR,
} from "./StatusGlyph";
import { isTurnRunning, isWorking } from "./useLifecycle";
import { elapsedLabel, idleAgeLabel } from "./relative-time";
import { cn } from "./lib/utils";
import {
  DEFAULT_CACHE_WINDOW,
  isCacheWarning,
  type CacheWindow,
} from "./cache-window";

/**
 * The row's trailing slot: one fixed width, right-aligned, on every row.
 *
 * Fixed rather than intrinsic because the label's width follows its text —
 * "59s" is wider than "7m" — and an intrinsic slot drags whatever sits beside
 * it back and forth, so no two rows agree on a column. Inside it the glyph and
 * the clock each have a fixed box of their own, so the glyphs form one column
 * and the clocks another, and a row with no glyph keeps its clock where every
 * other row has it.
 *
 * Nothing else ever enters this slot. The jump-key pill and the hover actions
 * sit to its left, so the clock never moves and is never covered.
 */
export const STATUS_SLOT_CLASS = "flex w-12 shrink-0 items-center justify-end";

/** Wide enough for the widest label: "59m", "23h", "now". */
const CLOCK_BOX_CLASS = "w-7 shrink-0 text-right tabular-nums text-2xs";

/**
 * The box every trailing glyph sits in, whatever its artwork measures.
 *
 * The status glyph, the provider glyph and a shelf's chevron all end a line at
 * the same inset, but they are drawn at different sizes. A shared box centres
 * each one on the same vertical axis, so right-aligning the boxes lines the
 * icons up instead of leaving them one or two pixels apart.
 */
export const TRAILING_GLYPH_BOX_CLASS =
  "flex size-3.5 shrink-0 items-center justify-center";

/**
 * Glyph on the left, a clock on the right, on every row.
 *
 * The clock is ALWAYS drawn. The glyph says what state the thread is in; the
 * clock says how long it has been in it, and on an idle thread that is the
 * number that decides whether replying resumes a cached conversation or pays
 * to rebuild one. No glyph, key pill or action ever takes its place.
 *
 * Which clock depends on whether the thread's agent is inside a turn. A turn
 * is a duration being accrued, counted from when bb logged it starting.
 * Anything else is an idle age, counted from when the last turn ENDED —
 * including while background work runs, since a dev server or a workflow does
 * not keep the prompt cache warm, and while a child runs, because a child's
 * clock is not this card's.
 *
 * Two rows have no such clock, and both still get a time:
 * - A thread that has never finished a turn shows how long since bb last
 *   recorded activity on it, dimmed and never amber: it is not a cache clock,
 *   and colouring it would claim a cache that does not exist.
 * - A running turn whose start the store has not read yet (the few seconds
 *   after a reload) shows a dash until it has.
 */
export function StatusOrTime({
  thread,
  now,
  startedWorkingAt = null,
  lastRunEndedAt = null,
  isChildWorking = false,
  cacheWindow = DEFAULT_CACHE_WINDOW,
}: {
  thread: PluginSidebarThread;
  /** Quantized clock, shared by every row in one render. */
  now: number;
  /** When bb logged the running turn starting, or null. */
  startedWorkingAt?: number | null;
  /** When the thread's newest turn ended, from bb's event log, or null. */
  lastRunEndedAt?: number | null;
  /** A direct child is running while this thread itself is not. */
  isChildWorking?: boolean;
  cacheWindow?: CacheWindow;
}) {
  const isRunning = isTurnRunning(thread);
  // Seconds only while there is a run to count: the list's shared clock then
  // wakes this row once a second, and every other row keeps to the minute.
  const liveNow = useClock("second", isRunning && startedWorkingAt !== null);
  const { hasUnsubmittedDraft } = useSidebarThreadDraft(thread.id);
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  // The draft ranks against ANY live work, as in bb: a thread whose turn has
  // ended but whose dev server still runs shows the working pencil. Only the
  // clock asks the narrower question of whether a turn is running.
  const indicator = composeIndicator(
    thread.indicator,
    hasUnsubmittedDraft,
    isWorking(thread),
  );
  const isDraftPlace = indicator === "draft" || indicator === "working-draft";

  let glyph: ReactNode = null;
  if (rowStatus !== null && rowStatusIsVisible(indicator)) {
    glyph = <RowStatusGlyph status={rowStatus} />;
  } else if (hasStatusGlyph(indicator)) {
    glyph = (
      <StatusGlyph
        indicator={indicator}
        label={
          isDraftPlace ? DRAFT_INDICATOR_LABELS[indicator] : thread.indicatorLabel
        }
      />
    );
  } else if (isRunning) {
    // Something is running and bb named no glyph for it; the slot must still
    // say so.
    glyph = <StatusGlyph indicator="runtime" label={thread.indicatorLabel} />;
  } else if (isChildWorking) {
    // The thread is quiet and its children are not. The spinner is the
    // sidebar's word for "something is running", and the flat list has
    // nowhere else to say it.
    glyph = <StatusGlyph indicator="runtime" label="Child thread working" />;
  }

  return (
    <span className="flex items-center gap-1">
      <span className={TRAILING_GLYPH_BOX_CLASS}>{glyph}</span>
      <Clock
        isRunning={isRunning}
        startedWorkingAt={startedWorkingAt}
        lastRunEndedAt={lastRunEndedAt}
        lastActivityAt={thread.latestAttentionAt}
        now={now}
        liveNow={liveNow}
        cacheWindow={cacheWindow}
      />
    </span>
  );
}

function Clock({
  isRunning,
  startedWorkingAt,
  lastRunEndedAt,
  lastActivityAt,
  now,
  liveNow,
  cacheWindow,
}: {
  isRunning: boolean;
  startedWorkingAt: number | null;
  lastRunEndedAt: number | null;
  lastActivityAt: number;
  now: number;
  liveNow: number;
  cacheWindow: CacheWindow;
}) {
  if (isRunning) {
    if (startedWorkingAt === null) {
      return (
        <span
          className={cn(CLOCK_BOX_CLASS, "text-muted-foreground/50")}
          title="Turn running; start time not read yet"
        >
          –
        </span>
      );
    }
    return (
      // Never coloured: a turn in flight is not yet a cache question.
      <span className={cn(CLOCK_BOX_CLASS, "text-muted-foreground")}>
        {elapsedLabel(startedWorkingAt, Math.max(liveNow, now))}
      </span>
    );
  }
  if (lastRunEndedAt === null) {
    return (
      <span
        className={cn(CLOCK_BOX_CLASS, "text-muted-foreground/50")}
        title="No finished turn yet; time since last activity"
      >
        {idleAgeLabel(lastActivityAt, now)}
      </span>
    );
  }
  return (
    <span
      className={cn(
        CLOCK_BOX_CLASS,
        isCacheWarning(now - lastRunEndedAt, cacheWindow)
          ? WAITING_COLOR
          : "text-muted-foreground",
      )}
    >
      {idleAgeLabel(lastRunEndedAt, now)}
    </span>
  );
}

/**
 * Whether another plugin's row status shows, by bb's own rule: everywhere
 * except over a running turn, a failure, or a question. It is not ranked as
 * a draft; it simply yields to the three states the user must not miss.
 */
function rowStatusIsVisible(
  indicator: ReturnType<typeof composeIndicator>,
): boolean {
  return (
    indicator !== "runtime" &&
    indicator !== "unread-error" &&
    indicator !== "waiting-for-input"
  );
}

/**
 * A status another plugin set on this row, drawn with bb's own treatment for
 * its tone: a running status pulses and shimmers in the success colour, a
 * finished one is static in the success or failure colour, and anything else
 * is neutral.
 */
function RowStatusGlyph({ status }: { status: PluginSidebarThreadRowStatus }) {
  const tone = status.tone ?? "default";
  if (tone === "running") {
    return (
      <span className="inline-flex size-3.5 items-center justify-center text-success motion-safe:animate-pulse">
        <HostIcon
          name={status.icon}
          aria-label={status.label}
          className="size-3.5 shrink-0 animate-shine-icon"
        />
      </span>
    );
  }
  return (
    <HostIcon
      name={status.icon}
      aria-label={status.label}
      className={cn(
        "size-3.5 shrink-0",
        tone === "success" && "text-success-foreground",
        tone === "error" && "text-destructive",
        tone === "default" && "text-muted-foreground",
      )}
    />
  );
}
