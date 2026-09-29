import { useEffect, useState } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Icon } from "./components/Icon";
import { ContextMenuItem, ContextMenuSeparator } from "./components/ContextMenu";
import { cn } from "./lib/utils";
import { usePortalScopeProps } from "./lib/portal-scope";
import { isLastInputKeyboard } from "./lib/input-modality";
import { useHoldOrderWhile } from "./useOrderFreeze";
import { ProjectCommandEditor } from "./ProjectCommandEditor";
import type { ProjectCommandStatus } from "./project-commands";
import {
  useThreadCommands,
  useWatchOnScreen,
  type CommandNotice,
} from "./ThreadCommandsProvider";

type Row = "card" | "slim";

/**
 * Hover and keyboard focus reveal the button, per row kind; written out in
 * full because the build only emits classes it can read. The box is always
 * laid out, so revealing it moves nothing. A device without hover never sees
 * it at rest (the right-click menu offers the same), and it cannot be tapped
 * while unseen.
 */
const REVEAL: Record<Row, string> = {
  card: "opacity-0 group-hover/card:opacity-100 group-has-[:focus-visible]/card:opacity-100 [@media(hover:none)]:invisible",
  slim: "opacity-0 group-hover/slim:opacity-100 group-has-[:focus-visible]/slim:opacity-100 [@media(hover:none)]:invisible",
};

/**
 * A thread's project commands, beside its ports: a terminal icon that opens
 * a popover to run or stop each command, and to edit the project's list.
 *
 * Shown on hover or keyboard focus, and always while one of the project's
 * commands runs in this thread, with a dot. Drawn for every thread whose
 * project the list knows, even one with no commands yet, so the first can be
 * added from here. The icon sits on top of the row's full-bleed link and
 * keeps its clicks, so using it never selects the thread.
 */
export function ThreadCommandsButton({
  thread,
  row,
}: {
  thread: Pick<PluginSidebarThread, "id" | "projectId">;
  row: Row;
}) {
  const commands = useThreadCommands();
  const [element, setElement] = useState<HTMLButtonElement | null>(null);
  useWatchOnScreen(commands, thread.id, element);
  const isOpen = commands?.open?.threadId === thread.id;
  useHoldOrderWhile(isOpen);
  const portalScope = usePortalScopeProps();

  const projectName = commands?.projectName(thread.projectId) ?? null;
  if (commands === null || projectName === null) return null;

  const list = commands.commandsOf(thread.id);
  const anyRunning = list?.some((command) => command.terminalId !== null) ?? false;
  const view = isOpen ? commands.open!.view : "list";

  return (
    <PopoverPrimitive.Root
      open={isOpen}
      onOpenChange={(next) => commands.setOpen(next ? { threadId: thread.id, view: "list" } : null)}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          ref={setElement}
          type="button"
          aria-label={anyRunning ? "Project commands, one running" : "Project commands"}
          onClick={(event) => {
            // Handled here rather than by Radix's toggle, and kept from the
            // row: the thread must not be selected by opening its commands.
            event.preventDefault();
            event.stopPropagation();
            commands.setOpen(isOpen ? null : { threadId: thread.id, view: "list" });
          }}
          className={cn(
            "pointer-events-auto relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:text-foreground",
            anyRunning || isOpen ? null : REVEAL[row],
            anyRunning && "text-emerald-500",
          )}
        >
          <Icon name="Terminal" className="size-3.5" aria-hidden />
          {anyRunning ? (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-emerald-500"
            />
          ) : null}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          {...portalScope}
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          aria-label={`Commands for ${projectName}`}
          onOpenAutoFocus={(event) => {
            if (!isLastInputKeyboard()) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            if (!isLastInputKeyboard()) event.preventDefault();
          }}
          // Opened from the right-click menu, focus returns to the row after
          // the popover appears; only a press outside or Escape closes it.
          onFocusOutside={(event) => event.preventDefault()}
          // A portal still bubbles through React's tree: keep the popover's
          // clicks, presses and right-clicks away from the row.
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
          className={cn(
            "z-50 max-w-[calc(100vw-1rem)] rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            view === "edit" ? "w-[34rem] p-2" : "w-72",
          )}
        >
          {view === "edit" ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Back to commands"
                  onClick={() => commands.setOpen({ threadId: thread.id, view: "list" })}
                  className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground"
                >
                  <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
                </button>
                <span className="truncate text-xs font-medium">Commands for {projectName}</span>
              </div>
              <ProjectCommandEditor
                projectId={thread.projectId}
                projectName={projectName}
                onSaved={() => void commands.refresh(thread.id)}
              />
            </div>
          ) : (
            <CommandList
              projectName={projectName}
              list={list}
              busy={commands.busyOf(thread.id)}
              notice={commands.noticeOf(thread.id)}
              onAct={(command, action) => void commands.act(thread.id, command, action)}
              onEdit={() => commands.setOpen({ threadId: thread.id, view: "edit" })}
            />
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/** The dev server first, then the rest in the project's order. */
const devServerFirst = (list: readonly ProjectCommandStatus[]) => [
  ...list.filter((command) => command.isDevServer),
  ...list.filter((command) => !command.isDevServer),
];

const ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60";

function CommandList({
  projectName,
  list,
  busy,
  notice,
  onAct,
  onEdit,
}: {
  projectName: string;
  list: readonly ProjectCommandStatus[] | undefined;
  busy: string | null;
  notice: CommandNotice | null;
  onAct: (command: ProjectCommandStatus, action: "run" | "stop") => void;
  onEdit: () => void;
}) {
  return (
    <div className="flex flex-col">
      {list === undefined ? (
        <p role="status" className="px-2 py-1.5 text-2xs text-muted-foreground">
          Loading…
        </p>
      ) : list.length === 0 ? (
        <p className="px-2 py-1.5 text-2xs text-muted-foreground">
          No commands for {projectName} yet.
        </p>
      ) : (
        <ul className="flex flex-col">
          {devServerFirst(list).map((command) => {
            const running = command.terminalId !== null;
            const isBusy = busy === command.id;
            return (
              <li key={command.id}>
                <button
                  type="button"
                  aria-label={`${running ? "Stop" : "Run"} ${command.name}`}
                  disabled={isBusy}
                  onClick={() => onAct(command, running ? "stop" : "run")}
                  className={ITEM_CLASS}
                >
                  <Icon
                    name={isBusy ? "Loading" : running ? "Stop" : command.isDevServer ? "Play" : "Terminal"}
                    className={cn("size-3 shrink-0", isBusy && "animate-spin", running && "text-emerald-500")}
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
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {notice ? <NoticeLine notice={notice} onStop={(command) => onAct(command, "stop")} /> : null}
      <div className="my-1 h-px bg-border" />
      <button type="button" onClick={onEdit} className={cn(ITEM_CLASS, "text-xs")}>
        <Icon name="Edit" className="size-3 shrink-0" aria-hidden />
        Edit commands…
      </button>
    </div>
  );
}

function NoticeLine({
  notice,
  onStop,
}: {
  notice: CommandNotice;
  onStop: (command: ProjectCommandStatus) => void;
}) {
  if (notice.kind === "error") {
    return (
      <p role="status" className="px-2 py-1 text-2xs text-destructive" title={notice.message}>
        {notice.message}
      </p>
    );
  }
  return (
    <p role="status" className="flex items-center gap-1 px-2 py-1 text-2xs text-muted-foreground">
      <span className="min-w-0 truncate">{notice.command.name} is already running</span>
      <button
        type="button"
        onClick={() => onStop(notice.command)}
        className="cursor-pointer rounded px-1 text-foreground underline-offset-2 hover:underline"
      >
        Stop
      </button>
    </p>
  );
}

/**
 * The right-click menu's share: run (or stop) the project's dev server, and
 * open the same popover the row's icon opens. Reads the thread's commands
 * afresh when the menu opens, since the row may never have been polled.
 * Nothing for a thread whose project the list does not know.
 */
export function ThreadCommandMenuItems({
  thread,
}: {
  thread: Pick<PluginSidebarThread, "id" | "projectId">;
}) {
  const commands = useThreadCommands();
  const known = commands?.projectName(thread.projectId) != null;
  const refresh = commands?.refresh;
  useEffect(() => {
    if (known && refresh !== undefined) void refresh(thread.id);
  }, [known, refresh, thread.id]);
  if (commands === null || !known) return null;

  const devServer = commands.commandsOf(thread.id)?.find((command) => command.isDevServer);
  const running = devServer !== undefined && devServer.terminalId !== null;

  return (
    <>
      {devServer ? (
        <ContextMenuItem
          onSelect={() => void commands.act(thread.id, devServer, running ? "stop" : "run")}
        >
          {running ? `Stop ${devServer.name}` : `Run ${devServer.name}`}
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem
        // After the menu has closed, so its focus hand-back lands first.
        onSelect={() =>
          window.setTimeout(() => commands.setOpen({ threadId: thread.id, view: "list" }), 0)
        }
      >
        Project commands…
      </ContextMenuItem>
      <ContextMenuSeparator />
    </>
  );
}
