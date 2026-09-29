import { useEffect, useRef, useState, type MouseEvent } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import { Icon } from "./components/Icon";
import { cn } from "./lib/utils";
import { usePortalScopeProps } from "./lib/portal-scope";
import { isLastInputKeyboard } from "./lib/input-modality";
import { useHoldOrderWhile } from "./useOrderFreeze";
import type { ListeningPort, PortListing } from "./host-contract";
import {
  clickTarget,
  openInBb,
  openInSystemBrowser,
  portUrl,
  type PortOpenTarget,
} from "./port-open";

export const PORT_ROW_TITLE = "Click: BB browser · ⌘-click: default browser";

/** Long enough to cross the gap from the icon into the card. */
export const PORTS_CLOSE_DELAY_MS = 150;

/**
 * What a thread's worktree is serving, as one plug icon with a count.
 *
 * Hovering opens a card listing every port, the process behind it and its
 * pid; the card stays open while the pointer is in it, so its rows can be
 * used. A click (or Enter, or a tap) pins it open until dismissed. The icon
 * sits on top of the row's full-bleed link and keeps its clicks, so using it
 * never selects the thread — and its box is the same size whatever the
 * count, so the line around it does not move when a port comes or goes.
 *
 * Nothing at all when nothing listens: an empty row stays as it was.
 */
export function PortsMenu({
  threadId,
  listing,
  className,
}: {
  threadId: string;
  listing: PortListing | undefined;
  className?: string;
}) {
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const [open, setOpen] = useState(false);
  // A hover-opened card closes when the pointer leaves; a pressed one stays.
  const pinned = useRef(false);
  const closeTimer = useRef<number | null>(null);
  const portalScope = usePortalScopeProps();
  useHoldOrderWhile(open);

  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  useEffect(() => cancelClose, []);

  if (listing === undefined || listing.ports.length === 0) return null;
  const count = listing.ports.length + listing.more;

  const setOpenState = (next: boolean) => {
    cancelClose();
    if (!next) pinned.current = false;
    setOpen(next);
  };
  const hoverOpen = () => {
    cancelClose();
    setOpen(true);
  };
  const hoverClose = () => {
    if (pinned.current) return;
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), PORTS_CLOSE_DELAY_MS);
  };

  const openPort = (port: number, target: PortOpenTarget) => {
    setOpenState(false);
    const url = portUrl(port);
    if (target === "system") openInSystemBrowser(navigate, url);
    else void openInBb({ sdk, navigate, threadId, url });
  };

  const label = `${count} listening ${count === 1 ? "port" : "ports"}`;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpenState}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") hoverOpen();
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") hoverClose();
          }}
          onClick={(event) => {
            // Handled here rather than by Radix's toggle: a click on a card the
            // hover already opened pins it, instead of closing it.
            event.preventDefault();
            event.stopPropagation();
            if (open && !pinned.current) {
              pinned.current = true;
              cancelClose();
            } else if (open) {
              setOpenState(false);
            } else {
              pinned.current = true;
              setOpenState(true);
            }
          }}
          className={cn(
            "pointer-events-auto relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:text-foreground",
            className,
          )}
        >
          <Icon name="Plug" className="size-3.5" aria-hidden />
          <span
            aria-hidden
            className="absolute -right-1 -top-1 min-w-2.5 rounded-full bg-muted px-0.5 text-center font-mono text-[9px] leading-2.5 text-muted-foreground"
          >
            {count}
          </span>
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          {...portalScope}
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          aria-label={label}
          onPointerEnter={cancelClose}
          onPointerLeave={hoverClose}
          // Focus moves into the card only for a keyboard user; a hover must
          // not take focus from wherever it is.
          onOpenAutoFocus={(event) => {
            if (!isLastInputKeyboard()) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            if (!isLastInputKeyboard()) event.preventDefault();
          }}
          // A portal still bubbles through React's tree: keep the card's
          // clicks and right-clicks away from the row that rendered it.
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
          className="z-50 w-80 rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        >
          <ul className="flex flex-col">
            {listing.ports.map((entry) => (
              <PortRow key={entry.port} entry={entry} onOpen={openPort} />
            ))}
          </ul>
          {listing.more > 0 ? (
            <p className="px-2 pb-1 pt-0.5 text-2xs text-muted-foreground">
              +{listing.more} more
            </p>
          ) : null}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

const ACTION_CLASS =
  "shrink-0 cursor-pointer rounded px-1 text-2xs leading-4 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring";

function PortRow({
  entry,
  onOpen,
}: {
  entry: ListeningPort;
  onOpen: (port: number, target: PortOpenTarget) => void;
}) {
  const { port, pid, command } = entry;
  return (
    <li className="flex items-center gap-1 rounded px-1 hover:bg-state-hover">
      <button
        type="button"
        title={PORT_ROW_TITLE}
        aria-label={`Open localhost:${port}`}
        onClick={(event: MouseEvent) => onOpen(port, clickTarget(event))}
        className="flex min-w-0 flex-1 cursor-pointer flex-col rounded px-1 py-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="flex items-baseline gap-2">
          <span className="font-mono text-xs text-foreground">:{port}</span>
          <span className="font-mono text-2xs tabular-nums text-muted-foreground">
            pid {pid}
          </span>
        </span>
        {command === "" ? null : (
          <span className="truncate text-2xs text-muted-foreground" title={command}>
            {command}
          </span>
        )}
      </button>
      <button
        type="button"
        aria-label={`Open localhost:${port} in BB`}
        onClick={() => onOpen(port, "bb")}
        className={ACTION_CLASS}
      >
        Open in BB
      </button>
      <button
        type="button"
        aria-label={`Open localhost:${port} in browser`}
        onClick={() => onOpen(port, "system")}
        className={ACTION_CLASS}
      >
        Open in browser
      </button>
    </li>
  );
}
