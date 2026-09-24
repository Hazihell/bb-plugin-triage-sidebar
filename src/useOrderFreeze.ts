import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { isLastInputKeyboard } from "./lib/input-modality";

/** How long the order stays held after the last reason to hold it ends. */
const RELEASE_GRACE_MS = 200;

/**
 * The displayed order of one list while it is frozen.
 *
 * Rows already on screen keep the places they had. A row that left (settled,
 * archived) leaves at once, because the user asked for that or it is gone. A
 * row that arrived (a snooze that woke, a new thread) goes at the END, below
 * everything the user might be about to click, and takes its real place when
 * the freeze ends.
 */
export function holdOrder<T extends { id: string }>(
  heldIds: readonly string[],
  live: readonly T[],
): T[] {
  const byId = new Map(live.map((row) => [row.id, row]));
  const kept: T[] = [];
  const seen = new Set<string>();
  for (const id of heldIds) {
    const row = byId.get(id);
    if (row === undefined) continue;
    kept.push(row);
    seen.add(id);
  }
  for (const row of live) if (!seen.has(row.id)) kept.push(row);
  return kept;
}

/**
 * Something outside the list's own box that needs the order held: a menu
 * opened from a row is portaled out of the list, so the pointer leaving the
 * list for the menu must not let the row move out from under it.
 */
export interface OrderHold {
  hold(): () => void;
}

export const OrderHoldContext = createContext<OrderHold>({
  hold: () => () => {},
});

/** Hold the list's order for as long as `active` is true. */
export function useHoldOrderWhile(active: boolean): void {
  const { hold } = useContext(OrderHoldContext);
  useEffect(() => (active ? hold() : undefined), [active, hold]);
}

/**
 * Whether the list's order is frozen: the pointer is over it, a row holds
 * keyboard focus, or a menu opened from a row is still open.
 *
 * A ranked list that re-sorts under the pointer moves the row the user was
 * about to click. So the order holds while they are plainly using the list,
 * and catches up — with the slide — once they are done. The release waits a
 * moment, so a pointer skimming off the edge and back does not shuffle rows.
 *
 * Keyboard focus counts only when it is visible focus. A mouse click on a row
 * also focuses its link, and that focus can outlive the click by minutes; it
 * must not pin the order that long.
 */
export function useOrderFreeze(containerRef: RefObject<HTMLElement | null>): {
  frozen: boolean;
  orderHold: OrderHold;
} {
  const [frozen, setFrozen] = useState(false);
  const reasons = useRef({ pointer: false, focus: false, holds: 0 });
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Focus can leave without a focusout: Firefox and Safari fire none when the
  // focused element is removed, as when a row settled from the keyboard
  // unmounts. So the focus reason is re-checked against the DOM wherever the
  // freeze is decided, rather than trusted from the last focus event.
  const focusStillInside = useCallback(() => {
    const container = containerRef.current;
    const active = document.activeElement;
    return (
      container !== null &&
      active instanceof HTMLElement &&
      container.contains(active)
    );
  }, [containerRef]);

  const update = useCallback(() => {
    if (reasons.current.focus && !focusStillInside()) {
      reasons.current.focus = false;
    }
    const { pointer, focus, holds } = reasons.current;
    if (pointer || focus || holds > 0) {
      if (releaseTimer.current !== null) clearTimeout(releaseTimer.current);
      releaseTimer.current = null;
      setFrozen(true);
      return;
    }
    if (releaseTimer.current !== null) return;
    releaseTimer.current = setTimeout(() => {
      releaseTimer.current = null;
      if (reasons.current.focus && !focusStillInside()) {
        reasons.current.focus = false;
      }
      const now = reasons.current;
      if (!now.pointer && !now.focus && now.holds === 0) setFrozen(false);
    }, RELEASE_GRACE_MS);
  }, [focusStillInside]);

  // A focused row can only disappear in a commit of the list, so every commit
  // is a chance to notice that the focus the freeze relies on has gone.
  useEffect(() => {
    if (reasons.current.focus) update();
  });

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const onPointerEnter = () => {
      reasons.current.pointer = true;
      update();
    };
    const onPointerLeave = () => {
      reasons.current.pointer = false;
      update();
    };
    const onFocusChange = () => {
      const active = document.activeElement;
      reasons.current.focus =
        active instanceof HTMLElement &&
        container.contains(active) &&
        isFocusVisible(active);
      update();
    };
    container.addEventListener("pointerenter", onPointerEnter);
    container.addEventListener("pointerleave", onPointerLeave);
    container.addEventListener("focusin", onFocusChange);
    // After the blur has landed, so activeElement names the new owner.
    const onFocusOut = () => setTimeout(onFocusChange, 0);
    container.addEventListener("focusout", onFocusOut);
    return () => {
      container.removeEventListener("pointerenter", onPointerEnter);
      container.removeEventListener("pointerleave", onPointerLeave);
      container.removeEventListener("focusin", onFocusChange);
      container.removeEventListener("focusout", onFocusOut);
    };
  }, [containerRef, update]);

  useEffect(
    () => () => {
      if (releaseTimer.current !== null) clearTimeout(releaseTimer.current);
    },
    [],
  );

  const hold = useCallback(() => {
    reasons.current.holds += 1;
    update();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      reasons.current.holds -= 1;
      update();
    };
  }, [update]);

  const orderHold = useMemo<OrderHold>(() => ({ hold }), [hold]);
  return { frozen, orderHold };
}

/**
 * Focus the user can see: the engine's own verdict, or, where the engine has
 * none to give, whether the last input was a key rather than a pointer, which
 * is the rule `:focus-visible` itself follows.
 */
function isFocusVisible(element: HTMLElement): boolean {
  try {
    if (element.matches(":focus-visible")) return true;
  } catch {
    // An engine without the selector falls through to the input modality.
  }
  return isLastInputKeyboard();
}
