import { Icon } from "./components/Icon";

/**
 * What the list shows when it has no list to show.
 *
 * The skeleton stands in for cards while nothing trustworthy has arrived: no
 * threads from the host, or no parking state yet and no snapshot of it. Drawn
 * at a card's exact geometry, so the real rows land where the placeholders
 * were, and still, because a pulse in the corner of the eye reads as activity
 * the sidebar does not have. It never shows the threads themselves unranked:
 * a list that appears in one order and re-sorts a second later is the flash
 * this exists to prevent.
 */
export function ListSkeleton() {
  return (
    <div role="status" aria-label="Loading threads" aria-busy="true">
      <ul className="flex flex-col gap-px" aria-hidden>
        {SKELETON_TITLE_WIDTHS.map((width, index) => (
          <li key={index} className="list-none rounded-md px-2.5 py-2">
            <div className="flex h-5 items-center gap-1.5">
              <span className="size-3.5 shrink-0 rounded-sm bg-muted" />
              <span className="h-2 w-16 rounded-full bg-muted" />
              <span className="flex-1" />
              <span className="h-2 w-6 rounded-full bg-muted" />
            </div>
            <div className="mt-0.5 flex h-5 items-center">
              <span
                className="h-2.5 rounded-full bg-muted"
                style={{ width: `${width}%` }}
              />
            </div>
            <div className="mt-0.5 flex h-4 items-center">
              <span className="h-2 w-20 rounded-full bg-muted/70" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Varied, so the placeholder reads as a list of titles, not a grid. */
const SKELETON_TITLE_WIDTHS = [72, 55, 84, 63, 48];

const RETRY_BUTTON_CLASS =
  "cursor-pointer rounded-md border border-border px-2 py-0.5 text-2xs font-medium text-foreground outline-none transition-colors duration-150 hover:bg-state-hover hover:duration-0 focus-visible:ring-1 focus-visible:ring-ring";

/**
 * Nothing to show because something failed. Says what, in the sidebar's own
 * quiet voice, and offers the one thing the user can do about it when there
 * is one: bb's own thread feed has no retry to offer, the plugin's store does.
 */
export function ListError({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail: string | null;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-1.5 px-4 py-8 text-center"
    >
      <Icon name="CircleX" className="size-4 text-muted-foreground" aria-hidden />
      <p className="text-xs font-medium text-foreground">{title}</p>
      {detail ? (
        <p className="line-clamp-3 break-words text-2xs text-muted-foreground">
          {detail}
        </p>
      ) : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className={`mt-1 ${RETRY_BUTTON_CLASS}`}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

/**
 * The list is showing, but its parking state could not be refreshed: the
 * shelves are last known, not current. One line above the list rather than a
 * takeover, because the list is still mostly right and still usable.
 */
export function StaleNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="status"
      className="mx-1 mb-1 flex items-center gap-2 rounded-md bg-muted/60 px-2 py-1 text-2xs text-muted-foreground"
    >
      <span className="min-w-0 flex-1 truncate">
        Snoozed and settled may be out of date.
      </span>
      <button type="button" onClick={onRetry} className={RETRY_BUTTON_CLASS}>
        Retry
      </button>
    </div>
  );
}

/** Nothing to show because there is nothing: no threads, or none in scope. */
export function ListEmpty({ scopeName }: { scopeName: string | null }) {
  return (
    <div role="status" className="px-4 py-8 text-center">
      <p className="text-xs text-muted-foreground">
        {scopeName === null ? "No threads yet" : `No threads in ${scopeName}`}
      </p>
    </div>
  );
}
