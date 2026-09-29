import type { MouseEvent } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { cn } from "./lib/utils";

/** Pills drawn before the rest fold behind "+N". */
export const VISIBLE_PORTS = 3;

export const PORT_PILL_TITLE = "Click: BB browser · ⌘-click: default browser";

/**
 * What a thread's worktree is serving, as `:3000` pills.
 *
 * A click opens the port through bb, so it lands in bb's browser; ⌘- or
 * Ctrl-click hands it to the operating system's default browser instead. The
 * pill sits on top of the row's full-bleed link, so it swallows the click —
 * opening a server must not also select the thread.
 *
 * Nothing at all when nothing listens: an empty row stays as it was.
 */
export function PortPills({
  ports,
  className,
}: {
  ports: readonly number[] | undefined;
  className?: string;
}) {
  const navigate = useBbNavigate();
  if (ports === undefined || ports.length === 0) return null;
  const shown = ports.slice(0, VISIBLE_PORTS);
  const folded = ports.slice(VISIBLE_PORTS);

  const open = (event: MouseEvent, port: number) => {
    event.preventDefault();
    event.stopPropagation();
    const url = `http://localhost:${port}`;
    if (event.metaKey || event.ctrlKey || !navigate.openUrl(url)) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <span className={cn("pointer-events-auto relative flex shrink-0 items-center gap-0.5", className)}>
      {shown.map((port) => (
        <button
          key={port}
          type="button"
          title={PORT_PILL_TITLE}
          aria-label={`Open localhost:${port}`}
          onClick={(event) => open(event, port)}
          className="cursor-pointer rounded bg-muted px-1 font-mono text-2xs leading-4 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          :{port}
        </button>
      ))}
      {folded.length > 0 ? (
        <span
          title={folded.map((port) => `:${port}`).join(" ")}
          className="px-0.5 font-mono text-2xs text-muted-foreground"
        >
          +{folded.length}
        </span>
      ) : null}
    </span>
  );
}
