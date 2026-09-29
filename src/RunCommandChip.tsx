import { useCallback, useEffect, useState } from "react";
import { useRpc, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { triageSidebarRpcContract } from "./server";
import type { ProjectCommandStatus } from "./project-commands";
import { Icon } from "./components/Icon";
import { cn } from "./lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/DropdownMenu";

/**
 * How often the running state refreshes while the header is on screen. A
 * command can exit on its own, and nothing tells the header when it does.
 */
export const COMMAND_STATUS_POLL_MS = 5_000;

type Notice =
  | { kind: "already-running"; command: ProjectCommandStatus }
  | { kind: "error"; message: string };

/**
 * Runs the thread's project commands in a terminal on the thread.
 *
 * The dev server, when the project marks one, is the play button itself; the
 * other commands sit in the menu beside it. A command whose terminal is alive
 * offers Stop instead of Run, so one click never starts a second copy. The
 * server makes the same check again before it starts anything, because the
 * state shown here can be up to one poll old.
 */
export function RunCommandChip({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof triageSidebarRpcContract>();
  const [commands, setCommands] = useState<readonly ProjectCommandStatus[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await rpc.call("threadCommandStatus", { threadId });
      setCommands(result.commands);
    } catch {
      // Keep the last state; the next tick asks again.
    }
  }, [rpc, threadId]);

  useEffect(() => {
    setNotice(null);
    void refresh();
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(tick, COMMAND_STATUS_POLL_MS);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, [refresh]);

  const act = async (command: ProjectCommandStatus, action: "run" | "stop") => {
    setBusy(command.id);
    setNotice(null);
    try {
      if (action === "run") {
        const result = await rpc.call("runProjectCommand", { threadId, commandId: command.id });
        if (result.outcome === "already-running") setNotice({ kind: "already-running", command });
      } else {
        await rpc.call("stopProjectCommand", { threadId, commandId: command.id });
      }
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  if (commands.length === 0) return null;

  const devServer = commands.find((command) => command.isDevServer);
  const others = commands.filter((command) => command !== devServer);
  const anyRunning = commands.some((command) => command.terminalId !== null);

  return (
    <div className="flex items-center gap-1.5">
      <div
        className={cn(
          "flex h-7 items-center rounded-full border text-2xs text-muted-foreground",
          anyRunning ? "border-emerald-500/60" : "border-border",
        )}
      >
        {devServer ? (
          <PrimaryButton
            command={devServer}
            busy={busy === devServer.id}
            showName={!isCompactViewport}
            joined={others.length > 0}
            onClick={() => void act(devServer, devServer.terminalId ? "stop" : "run")}
          />
        ) : null}
        {others.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={devServer ? "More commands" : "Run a command"}
                className={cn(
                  "flex h-full items-center gap-1 rounded-full px-2 outline-none",
                  "hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
                  "data-[state=open]:bg-state-active data-[state=open]:text-foreground",
                  devServer && "rounded-l-none border-l border-border pl-1.5",
                )}
              >
                {devServer ? null : (
                  <>
                    <Icon name="Play" className="size-3" aria-hidden />
                    {isCompactViewport ? null : <span>Run</span>}
                  </>
                )}
                <Icon name="ChevronDown" className="size-3" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64 max-w-[calc(100vw-1rem)]">
              {others.map((command) => {
                const running = command.terminalId !== null;
                return (
                  <DropdownMenuItem
                    key={command.id}
                    textValue={command.name}
                    disabled={busy === command.id}
                    onSelect={() => void act(command, running ? "stop" : "run")}
                    className="py-1.5"
                  >
                    <Icon
                      name={running ? "Stop" : "Play"}
                      className={cn("size-3 shrink-0", running && "text-emerald-500")}
                      aria-hidden
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-xs">
                        {running ? `Stop ${command.name}` : command.name}
                      </span>
                      <span className="truncate font-mono text-2xs text-muted-foreground">
                        {command.command}
                      </span>
                    </span>
                    {running ? <span className="text-2xs text-emerald-500">running</span> : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {notice ? <NoticeLine notice={notice} onStop={(command) => void act(command, "stop")} /> : null}
    </div>
  );
}

function PrimaryButton({
  command,
  busy,
  showName,
  joined,
  onClick,
}: {
  command: ProjectCommandStatus;
  busy: boolean;
  showName: boolean;
  joined: boolean;
  onClick: () => void;
}) {
  const running = command.terminalId !== null;
  return (
    <button
      type="button"
      aria-label={`${running ? "Stop" : "Run"} ${command.name}`}
      title={command.command}
      disabled={busy}
      onClick={onClick}
      className={cn(
        "flex h-full items-center gap-1.5 rounded-full px-2 outline-none",
        "hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:opacity-60",
        joined && "rounded-r-none",
        running && "text-emerald-500",
      )}
    >
      <Icon
        name={busy ? "Loading" : running ? "Stop" : "Play"}
        className={cn("size-3 shrink-0", busy && "animate-spin")}
        aria-hidden
      />
      {showName ? <span className="max-w-32 truncate">{command.name}</span> : null}
    </button>
  );
}

function NoticeLine({
  notice,
  onStop,
}: {
  notice: Notice;
  onStop: (command: ProjectCommandStatus) => void;
}) {
  if (notice.kind === "error") {
    return (
      <span role="status" className="max-w-48 truncate text-2xs text-destructive" title={notice.message}>
        {notice.message}
      </span>
    );
  }
  return (
    <span role="status" className="flex items-center gap-1 text-2xs text-muted-foreground">
      <span className="max-w-40 truncate">{notice.command.name} is already running</span>
      <button
        type="button"
        onClick={() => onStop(notice.command)}
        className="rounded px-1 text-foreground underline-offset-2 hover:underline"
      >
        Stop
      </button>
    </span>
  );
}
