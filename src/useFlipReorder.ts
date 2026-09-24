import { useLayoutEffect, useRef, type RefObject } from "react";

const DURATION_MS = 150;
/** Fast out, long settle: the row lands before the eye finishes tracking it. */
const EASING = "cubic-bezier(0.2, 0, 0, 1)";
/** Sub-pixel drift from a re-layout is not a move, and animating it jitters. */
const MOVE_THRESHOLD_PX = 1;

/** One row to fly: start `from` pixels off its new place and slide home. */
export interface Flight {
  id: string;
  from: number;
}

/**
 * Which rows fly, and from where, given where each row's LAYOUT box sat on the
 * last commit and where it sits now.
 *
 * Layout boxes, never painted ones. A row in flight paints somewhere between
 * its old and new place, and measuring that paint is what made flights play
 * twice: any later commit — a timer tick, a second message about the same
 * change — read the half-travelled row as a fresh move and launched it again.
 * A layout box only changes when the list really changes, so a commit that
 * moved nothing launches nothing, and a flight in progress runs to the end.
 *
 * A row that moves AGAIN mid-flight starts from where it is painted right now
 * (`inFlight` is the offset its current flight still applies), so it turns
 * toward its new place instead of jumping back to its old one.
 *
 * A row with no previous box is new to the list and does not fly: first data,
 * an expanded shelf and a new thread all simply appear.
 */
export function planFlights(
  previous: ReadonlyMap<string, number>,
  next: ReadonlyMap<string, number>,
  inFlight: (id: string) => number = () => 0,
): Flight[] {
  const flights: Flight[] = [];
  for (const [id, top] of next) {
    const before = previous.get(id);
    if (before === undefined) continue;
    if (Math.abs(before - top) <= MOVE_THRESHOLD_PX) continue;
    flights.push({ id, from: before - top + inFlight(id) });
  }
  return flights;
}

/**
 * FLIP (First, Last, Invert, Play) for the thread list, hand-written because
 * one layout effect is not worth an animation dependency in a sidebar plugin.
 *
 * The list re-ranks itself, so a row can jump half a screen between two
 * commits. Without the slide the user sees a new list rather than a moved row
 * and loses the thread they were reading. So after every commit this compares
 * each row's layout position with the last one and slides the moved rows home
 * over 150ms. The DOM is already correct throughout — only the paint is a lie.
 *
 * `quietKey` names the list's current data source: which host and store loads
 * have landed, the project scope, which shelves are open. A commit that
 * changes it re-measures without flying anything, because rows that move then
 * moved for a reason the user did not see happen: data arriving, a snapshot
 * being replaced, a different list being shown.
 *
 * Rows are found by the `data-sidebar-thread-id` attribute every row already
 * carries for bb's thread shortcuts, so no row component has to hand a ref up.
 * The container must be the rows' offset parent (positioned), so a row's
 * offsetTop is its place in the scrolling content, not in the viewport.
 */
export function useFlipReorder(
  containerRef: RefObject<HTMLElement | null>,
  quietKey: string,
) {
  const previousTops = useRef(new Map<string, number>());
  const lastQuietKey = useRef<string | null>(null);
  const flights = useRef(new WeakMap<HTMLElement, Animation>());

  // No dependency array on purpose: any commit can move rows. Commits that
  // move nothing cost one layout read and launch nothing.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const rows = new Map<string, HTMLElement>();
    const tops = new Map<string, number>();
    for (const anchor of container.querySelectorAll<HTMLElement>(
      "[data-sidebar-thread-id]",
    )) {
      const id = anchor.getAttribute("data-sidebar-thread-id");
      if (id === null) continue;
      // The anchor is a full-bleed overlay inside the row; the row itself is
      // the list item, and that is what has to move.
      const row = anchor.closest<HTMLElement>("li") ?? anchor;
      rows.set(id, row);
      tops.set(id, layoutTop(row, container));
    }

    const quiet = lastQuietKey.current !== quietKey;
    lastQuietKey.current = quietKey;
    const previous = previousTops.current;
    previousTops.current = tops;

    const shouldAnimate = !quiet && canAnimate() && !prefersReducedMotion();
    if (!shouldAnimate) {
      // Anything still flying lands now: its target is the layout the user
      // is about to see, and a slide toward it would be a slide from nowhere.
      for (const row of rows.values()) flights.current.get(row)?.finish();
      return;
    }

    const containerTop = container.getBoundingClientRect().top;
    const inFlight = (id: string) => {
      const row = rows.get(id);
      if (row === undefined || !flights.current.has(row)) return 0;
      const painted =
        row.getBoundingClientRect().top - containerTop + container.scrollTop;
      return painted - (tops.get(id) ?? painted);
    };

    for (const { id, from } of planFlights(previous, tops, inFlight)) {
      const row = rows.get(id);
      if (row === undefined) continue;
      flights.current.get(row)?.cancel();
      const animation = row.animate(
        [{ transform: `translateY(${from}px)` }, { transform: "none" }],
        { duration: DURATION_MS, easing: EASING },
      );
      flights.current.set(row, animation);
      animation.onfinish = animation.oncancel = () => {
        if (flights.current.get(row) === animation) flights.current.delete(row);
      };
    }
  });
}

/**
 * The row's top in the container's scrolling content, from layout alone.
 * offsetTop ignores transforms, which is the whole point: a row mid-flight
 * reports where it will land, not where it is painted.
 */
function layoutTop(row: HTMLElement, container: HTMLElement): number {
  let top = 0;
  let node: HTMLElement | null = row;
  while (node !== null && node !== container) {
    top += node.offsetTop;
    const parent = node.offsetParent as HTMLElement | null;
    // The container is not in this row's offset chain (it is not
    // positioned): fall back to the painted position, which is still right
    // for any row that is not in flight.
    if (parent !== null && !container.contains(parent)) {
      return (
        row.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop
      );
    }
    node = parent;
  }
  return top;
}

/**
 * A reduced-motion user asked for no movement, and a list that re-sorts is
 * exactly the movement they meant. Read per commit, not once: the setting can
 * change while the sidebar is mounted.
 */
function prefersReducedMotion(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** jsdom ships no Web Animations API, so tests exercise the measuring half. */
function canAnimate(): boolean {
  return (
    typeof Element !== "undefined" &&
    typeof Element.prototype.animate === "function"
  );
}
