import { useLayoutEffect, useRef, type RefObject } from "react";

const DURATION_MS = 250;
/** Fast out, long settle: the row lands before the eye finishes tracking it. */
const EASING = "cubic-bezier(0.2, 0, 0, 1)";
/** Sub-pixel drift from a re-layout is not a move, and animating it jitters. */
const MOVE_THRESHOLD_PX = 1;

/**
 * FLIP (First, Last, Invert, Play) for the thread list, hand-written because
 * one 20-line layout effect is not worth an animation dependency in a sidebar
 * plugin.
 *
 * The list re-sorts itself now, so a row can jump half a screen between two
 * commits. Without the tween the user sees a new list rather than a moved
 * row, and loses track of the thread they were reading. So: after every
 * commit, compare each row's position to where it sat on the previous commit
 * and, when it moved, start it from its old offset and let it slide home. The
 * DOM is already correct throughout — only the paint is a lie.
 *
 * Rows are found by the `data-sidebar-thread-id` attribute every row already
 * carries for bb's thread shortcuts, so no row component has to hand a ref up.
 *
 * A row seen for the first time fades in. A leaving row is not animated at
 * all: its React element is gone by the time this runs, and holding it alive
 * for an exit would mean owning the list's mount lifecycle for one flourish.
 */
export function useFlipReorder(containerRef: RefObject<HTMLElement | null>) {
  const previousTops = useRef(new Map<string, number>());

  // No dependency array on purpose: any commit can re-order rows, and the
  // measurement has to be taken from the DOM the user is about to see.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const tops = new Map<string, number>();
    const previous = previousTops.current;
    const shouldAnimate = canAnimate() && !prefersReducedMotion();
    const containerTop = container.getBoundingClientRect().top;

    for (const anchor of container.querySelectorAll<HTMLElement>(
      "[data-sidebar-thread-id]",
    )) {
      const id = anchor.getAttribute("data-sidebar-thread-id");
      if (id === null) continue;
      // The anchor is a full-bleed overlay inside the row; the row itself is
      // the list item, and that is what has to move.
      const row = anchor.closest<HTMLElement>("li") ?? anchor;
      // Measured against the scroll content rather than the viewport:
      // scrolling shifts every client rect at once, and reading that as a
      // re-order would animate the entire list on every wheel tick.
      const top =
        row.getBoundingClientRect().top - containerTop + container.scrollTop;
      tops.set(id, top);
      if (!shouldAnimate) continue;

      const previousTop = previous.get(id);
      if (previousTop === undefined) {
        row.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: DURATION_MS,
          easing: EASING,
        });
        continue;
      }
      const delta = previousTop - top;
      if (Math.abs(delta) <= MOVE_THRESHOLD_PX) continue;
      row.animate(
        [
          { transform: `translateY(${delta}px)` },
          { transform: "translateY(0)" },
        ],
        { duration: DURATION_MS, easing: EASING },
      );
    }

    previousTops.current = tops;
  });
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
