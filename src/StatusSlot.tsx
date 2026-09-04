import { useEffect, useState } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { StatusGlyph, hasStatusGlyph, WAITING_COLOR } from "./StatusGlyph";
import { isWorking } from "./useLifecycle";
import { elapsedLabel, idleAgeLabel } from "./relative-time";
import { cn } from "./lib/utils";
import {
  DEFAULT_CACHE_WINDOW,
  isCacheWarning,
  type CacheWindow,
} from "./cache-window";

/**
 * A one-second clock, live only while `enabled`.
 *
 * The list's shared clock ticks once a minute, which is right for ages and
 * wrong for a running timer: a run that started eight seconds ago would read
 * the same for its first full minute. This ticker is deliberately local to the
 * rows that need it, so a sidebar with one working thread re-renders one row a
 * second rather than all of them.
 */
function useSecondsClock(enabled: boolean): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setTick(Date.now());
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return tick;
}

/**
 * The row's trailing slot: one fixed width, right-aligned, on every row.
 *
 * Fixed rather than intrinsic because the label's width follows its text —
 * "59s" is wider than "7m" — and an intrinsic slot drags whatever sits beside
 * it back and forth, so no two rows agree on a column. The width holds the
 * widest thing this sidebar can produce: a glyph AND a clock side by side,
 * which is why it is wider than one label alone. Every row that carries either
 * now carries the pair, so this width is the common case rather than the
 * exception it was drawn for.
 */
export const STATUS_SLOT_CLASS = "flex w-12 shrink-0 items-center justify-end";

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
 * Glyph on the left, a clock on the right, on every row that has either.
 *
 * The slot used to spend itself on one or the other, on the reasoning that a
 * glyph makes an age redundant. It does not. The glyph says what state the
 * thread is in; the age says how long it has been in it, and on an idle thread
 * that is the number that decides whether replying resumes a cached
 * conversation or pays to rebuild one. So the two now share the slot.
 *
 * Which clock depends on whose run it is. The thread's OWN run is a duration
 * being accrued, counted from when bb reported it starting. Anything else is
 * an idle age, counted from when its own last run ENDED — including while a
 * child is running, because a child's clock is not this card's and the sidebar
 * keeps none.
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
  /**
   * When bb recorded this run starting, from the plugin's lifecycle store.
   * Optional and null by default: a caller that has not wired the store yet
   * keeps today's behaviour rather than breaking.
   */
  startedWorkingAt?: number | null;
  /**
   * When the thread's own last run ended. Null falls back to bb's `updatedAt`,
   * which is what this slot read before the store recorded run ends and what
   * every thread that predates the column still has.
   */
  lastRunEndedAt?: number | null;
  /** A direct child is running while this thread itself is not. */
  isChildWorking?: boolean;
  cacheWindow?: CacheWindow;
}) {
  const isOwnRunLive = isWorking(thread);
  const isRunning = startedWorkingAt !== null && isOwnRunLive;
  const liveNow = useSecondsClock(isRunning);

  if (isOwnRunLive) {
    const clock = Math.max(liveNow, now);
    return (
      <span className="flex items-center gap-1">
        {/* The thread's own glyph when it has one, so a workflow still reads
            as a workflow; the runtime spinner otherwise, because something is
            running and the slot must say so. */}
        <StatusGlyph
          indicator={
            hasStatusGlyph(thread.indicator) ? thread.indicator : "runtime"
          }
          label={thread.indicatorLabel}
        />
        {/* No idle age here, ever, even when the store has no start time: this
            thread is not idle, and its clock is simply unknown. */}
        {startedWorkingAt === null ? null : (
          <span className="tabular-nums text-2xs text-muted-foreground">
            {elapsedLabel(startedWorkingAt, clock)}
          </span>
        )}
      </span>
    );
  }

  const idleSince = lastRunEndedAt ?? thread.updatedAt;
  const age = idleAgeLabel(idleSince, now);
  return (
    <span className="flex items-center gap-1">
      {hasStatusGlyph(thread.indicator) ? (
        <StatusGlyph indicator={thread.indicator} label={thread.indicatorLabel} />
      ) : isChildWorking ? (
        // The thread is quiet and its children are not. The spinner is the
        // sidebar's word for "something is running", and the flat list has
        // nowhere else to say it.
        <StatusGlyph indicator="runtime" label="Child thread working" />
      ) : null}
      <span
        className={cn(
          "tabular-nums text-2xs",
          // Only the idle age is ever coloured. An own-run timer counts work
          // in flight, where the cache window is not yet a question.
          isCacheWarning(now - idleSince, cacheWindow)
            ? WAITING_COLOR
            : "text-muted-foreground",
        )}
      >
        {age}
      </span>
    </span>
  );
}
