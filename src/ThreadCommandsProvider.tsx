import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { triageSidebarRpcContract } from "./server";
import type { ProjectCommandStatus } from "./project-commands";
import { MAX_STATUS_THREADS } from "./project-command-limits";
import { COMMAND_STATUS_POLL_MS } from "./RunCommandChip";

/** What a run or stop left to say, shown in that row's popover. */
export type CommandNotice =
  | { kind: "already-running"; command: ProjectCommandStatus }
  | { kind: "error"; message: string };

/** Which row's commands popover is open, and on which of its two views. */
export type OpenCommands = { threadId: string; view: "list" | "edit" };

interface ThreadCommandsValue {
  /** The project's name, or null for a project the list does not know. */
  projectName(projectId: string): string | null;
  /** The thread's commands as last read, or undefined before the first read. */
  commandsOf(threadId: string): readonly ProjectCommandStatus[] | undefined;
  busyOf(threadId: string): string | null;
  noticeOf(threadId: string): CommandNotice | null;
  open: OpenCommands | null;
  setOpen(next: OpenCommands | null): void;
  refresh(threadId: string): Promise<void>;
  act(threadId: string, command: ProjectCommandStatus, action: "run" | "stop"): Promise<void>;
  /** Counts a row's element as on screen while it intersects the viewport. */
  watch(threadId: string, element: Element): () => void;
}

const ThreadCommandsContext = createContext<ThreadCommandsValue | null>(null);

/**
 * The thread list's one view of project commands: what each on-screen row's
 * project offers, which of those run in that thread's terminals, and which
 * row's popover is open.
 *
 * Rows only read it. Running state is polled here, for the rows currently
 * on screen and nothing else, in one batched call on the header chip's
 * interval, so a hundred threads cost one call per tick rather than a
 * hundred timers. A row scrolled away, or on a collapsed shelf, is not asked
 * about until it comes back. Run and stop go through the same calls the
 * header chip uses, and the server's "already running" answer is shown in
 * the row's popover with a Stop beside it.
 *
 * Absent (no provider), every row control renders nothing.
 */
export function ThreadCommandsProvider({
  projects,
  children,
}: {
  projects: ReadonlyArray<{ id: string; name: string }>;
  children: ReactNode;
}) {
  const nameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const rpc = useRpc<typeof triageSidebarRpcContract>();
  const [byThread, setByThread] = useState<ReadonlyMap<string, readonly ProjectCommandStatus[]>>(
    () => new Map(),
  );
  const [busy, setBusy] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [notices, setNotices] = useState<ReadonlyMap<string, CommandNotice>>(() => new Map());
  const [open, setOpenState] = useState<OpenCommands | null>(null);

  // How many mounted elements of each thread are on screen. A ref, because
  // scrolling must not re-render the list; the next tick reads it.
  const onScreen = useRef(new Map<string, number>());
  const observer = useRef<IntersectionObserver | null>(null);
  const observed = useRef(new Map<Element, { threadId: string; visible: boolean }>());
  const pending = useRef<number | null>(null);

  const load = useCallback(
    async (threadIds: readonly string[]) => {
      if (threadIds.length === 0) return;
      try {
        const { statuses } = await rpc.call("threadsCommandStatus", {
          threadIds: threadIds.slice(0, MAX_STATUS_THREADS),
        });
        setByThread((current) => {
          const next = new Map(current);
          for (const status of statuses) next.set(status.threadId, status.commands);
          return next;
        });
      } catch {
        // Keep the last state; the next tick asks again.
      }
    },
    [rpc],
  );

  const visibleIds = () =>
    [...onScreen.current].filter(([, count]) => count > 0).map(([threadId]) => threadId);

  // A row that has just come on screen is read at once rather than a tick
  // later, batched with any others that arrived in the same frame.
  const loadSoon = useCallback(() => {
    if (pending.current !== null) return;
    pending.current = window.setTimeout(() => {
      pending.current = null;
      void load(visibleIds());
    }, 0);
  }, [load]);

  const setVisible = useCallback(
    (element: Element, visible: boolean) => {
      const entry = observed.current.get(element);
      if (entry === undefined || entry.visible === visible) return;
      entry.visible = visible;
      const count = (onScreen.current.get(entry.threadId) ?? 0) + (visible ? 1 : -1);
      if (count > 0) onScreen.current.set(entry.threadId, count);
      else onScreen.current.delete(entry.threadId);
      if (visible) loadSoon();
    },
    [loadSoon],
  );

  const watch = useCallback(
    (threadId: string, element: Element) => {
      observed.current.set(element, { threadId, visible: false });
      if (typeof IntersectionObserver === "undefined") {
        // Nothing to ask, so count the row as seen.
        setVisible(element, true);
      } else {
        observer.current ??= new IntersectionObserver((entries) => {
          for (const entry of entries) setVisible(entry.target, entry.isIntersecting);
        });
        observer.current.observe(element);
      }
      return () => {
        setVisible(element, false);
        observer.current?.unobserve(element);
        observed.current.delete(element);
      };
    },
    [setVisible],
  );

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void load(visibleIds());
    };
    const timer = window.setInterval(tick, COMMAND_STATUS_POLL_MS);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
      if (pending.current !== null) window.clearTimeout(pending.current);
      observer.current?.disconnect();
      observer.current = null;
    };
  }, [load]);

  const setNotice = (threadId: string, notice: CommandNotice | null) =>
    setNotices((current) => {
      const next = new Map(current);
      if (notice === null) next.delete(threadId);
      else next.set(threadId, notice);
      return next;
    });

  const setOpen = (next: OpenCommands | null) => {
    // A notice belongs to the popover it was shown in.
    if (open !== null && open.threadId !== next?.threadId) setNotice(open.threadId, null);
    setOpenState(next);
  };

  const refresh = useCallback((threadId: string) => load([threadId]), [load]);

  const act = async (
    threadId: string,
    command: ProjectCommandStatus,
    action: "run" | "stop",
  ) => {
    setBusy((current) => new Map(current).set(threadId, command.id));
    setNotice(threadId, null);
    let notice: CommandNotice | null = null;
    try {
      if (action === "run") {
        const result = await rpc.call("runProjectCommand", { threadId, commandId: command.id });
        if (result.outcome === "already-running") notice = { kind: "already-running", command };
      } else {
        await rpc.call("stopProjectCommand", { threadId, commandId: command.id });
      }
    } catch (error) {
      notice = { kind: "error", message: error instanceof Error ? error.message : String(error) };
    } finally {
      setBusy((current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      });
      await refresh(threadId);
    }
    if (notice !== null) {
      setNotice(threadId, notice);
      // Started from the right-click menu, the notice needs somewhere to show.
      setOpenState((current) => current ?? { threadId, view: "list" });
    }
  };

  const value: ThreadCommandsValue = {
    projectName: (projectId) => nameById.get(projectId) ?? null,
    commandsOf: (threadId) => byThread.get(threadId),
    busyOf: (threadId) => busy.get(threadId) ?? null,
    noticeOf: (threadId) => notices.get(threadId) ?? null,
    open,
    setOpen,
    refresh,
    act,
    watch,
  };

  return <ThreadCommandsContext.Provider value={value}>{children}</ThreadCommandsContext.Provider>;
}

/** The list's commands state, or null outside a {@link ThreadCommandsProvider}. */
export function useThreadCommands(): ThreadCommandsValue | null {
  return useContext(ThreadCommandsContext);
}

/** Counts `element` as the thread's on-screen row while it is mounted. */
export function useWatchOnScreen(
  commands: ThreadCommandsValue | null,
  threadId: string,
  element: Element | null,
) {
  const watch = commands?.watch;
  useEffect(() => {
    if (watch === undefined || element === null) return;
    return watch(threadId, element);
  }, [watch, threadId, element]);
}
