/**
 * Whether the user's last input was a key rather than a pointer — the rule
 * `:focus-visible` follows, and the one bb's overlays use to decide whether
 * closing a menu hands focus back to its trigger. Tracked once, at capture,
 * for the whole window.
 */
let lastInputWasKeyboard = false;

if (typeof document !== "undefined") {
  document.addEventListener(
    "keydown",
    () => {
      lastInputWasKeyboard = true;
    },
    { capture: true },
  );
  document.addEventListener(
    "pointerdown",
    () => {
      lastInputWasKeyboard = false;
    },
    { capture: true },
  );
}

export function isLastInputKeyboard(): boolean {
  return lastInputWasKeyboard;
}
