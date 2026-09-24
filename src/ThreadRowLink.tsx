import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  type PluginSidebarThread,
  type PluginSidebarThreadShortcut,
  type PluginSidebarThreadSplit,
} from "@get-bb/plugin-sdk/app";

/**
 * The full-bleed anchor under a row's controls, shared by the card and the
 * slim row so the two can never disagree about what a click does.
 *
 * It carries the thread's real `href`, so the host routes a plain click in
 * place, and middle-click, copy-link and open-in-new-window work as they do
 * on any link. The row only steps in for the one gesture a link cannot
 * express: Cmd/Ctrl-click opens a split while splits are available. When they
 * are not, the row leaves the click alone and the host's link router takes it
 * and navigates in place, which is what bb's own row does.
 */
export function ThreadRowLink({
  thread,
  split,
  shortcut,
  onNavigate,
}: {
  thread: PluginSidebarThread;
  split: PluginSidebarThreadSplit;
  shortcut: PluginSidebarThreadShortcut | null;
  onNavigate: () => void;
}) {
  const actions = useSidebarThreadActions();
  return (
    <a
      // Both attributes, or bb's numbered thread shortcuts stop finding rows.
      data-sidebar-thread-shortcut-target=""
      data-sidebar-thread-id={thread.id}
      href={thread.href}
      aria-label={thread.displayTitle}
      aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
      {...split.splitProps}
      onClick={(event) => {
        if (split.isAvailable && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          actions.open(thread.id, { split: true });
          return;
        }
        onNavigate();
      }}
      className="absolute inset-0 cursor-pointer rounded-md"
    />
  );
}

/**
 * The key bb assigns a row while the command modifier is held. The hook
 * reports null the rest of the time. Rows draw it just left of the status
 * slot, never in it: bb's own list swaps its status for the key, but this
 * sidebar's slot carries the idle age, and that is never hidden.
 */
export function ShortcutPill({
  shortcut,
}: {
  shortcut: PluginSidebarThreadShortcut;
}) {
  return (
    <kbd
      aria-hidden
      className="pointer-events-none inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-sm bg-muted px-1.5 py-0.5 font-sans text-2xs leading-none tabular-nums text-muted-foreground"
    >
      {shortcut.label}
    </kbd>
  );
}
