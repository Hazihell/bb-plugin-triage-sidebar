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
