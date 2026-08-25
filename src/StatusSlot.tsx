import { useEffect, useState } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { StatusGlyph, hasStatusGlyph } from "./StatusGlyph";
import { isWorking } from "./useLifecycle";
import { elapsedLabel, relativeTimeLabel } from "./relative-time";

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
 * Fixed rather than intrinsic because the age label's width follows its text —
 * "now" is wider than "7m" — and an intrinsic slot drags whatever sits beside
 * it back and forth, so no two rows agree on a column. The width holds the
 * widest thing this sidebar can produce: a working row's spinner AND its
 * elapsed label side by side, which is why it is wider than one label alone.
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
 * Status OR age, never both — with one exception: a running thread shows its
 * spinner AND how long it has been running.
 *
 * The glyph alone answers "is it busy", which the user can already see. On a
 * thread that has been working a while the useful question is "how long", and
 * that is the one reading a glance cannot supply. Every other row keeps the
 * either/or rule: the glyph implies the row is current, and the age only earns
 * its place once the thread has nothing to say.
 */
export function StatusOrTime({
  thread,
  now,
  startedWorkingAt = null,
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
}) {
  const isRunning = startedWorkingAt !== null && isWorking(thread);
  const liveNow = useSecondsClock(isRunning);
  if (isRunning) {
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
        <span className="tabular-nums text-2xs text-muted-foreground">
          {elapsedLabel(startedWorkingAt, Math.max(liveNow, now))}
        </span>
      </span>
    );
  }
  if (hasStatusGlyph(thread.indicator)) {
    return (
      <StatusGlyph indicator={thread.indicator} label={thread.indicatorLabel} />
    );
  }
  return (
    <span className="tabular-nums text-2xs text-muted-foreground">
      {relativeTimeLabel(thread.updatedAt, now)}
    </span>
  );
}
