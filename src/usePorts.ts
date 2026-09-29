import { useEffect, useMemo, useState } from "react";
import { useRpc, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { triageSidebarRpcContract } from "./server";
import type { PortListing } from "./host-contract";

/** How often the ports refresh while the sidebar is on screen. */
export const PORTS_POLL_MS = 10_000;

const NO_PORTS: ReadonlyMap<string, PortListing> = new Map();

/** Every machine's thread directories, deduplicated, in a stable order. */
export function portTargets(
  threads: readonly PluginSidebarThread[],
): Array<{ hostId: string; directories: string[] }> {
  const byHost = new Map<string, Set<string>>();
  for (const thread of threads) {
    const hostId = thread.host?.id;
    const path = thread.environment?.path?.trim();
    if (!hostId || !path) continue;
    const set = byHost.get(hostId) ?? new Set<string>();
    set.add(path);
    byHost.set(hostId, set);
  }
  return [...byHost]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([hostId, directories]) => ({ hostId, directories: [...directories].sort() }));
}

/**
 * The listening ports of each thread's worktree or checkout, by thread id.
 *
 * A poll, not a push: a port opens without telling anyone, so something has
 * to look. It looks only while the list is mounted and the window visible,
 * and once more when the window regains focus — the moment a user comes back
 * from starting a server elsewhere. No thread with a directory, no call.
 */
export function usePorts(
  threads: readonly PluginSidebarThread[],
): ReadonlyMap<string, PortListing> {
  const rpc = useRpc<typeof triageSidebarRpcContract>();
  const targets = useMemo(() => portTargets(threads), [threads]);
  // The effect restarts only when the set of directories changes, not on
  // every thread update that leaves them alone.
  const targetsKey = JSON.stringify(targets);
  const [byDirectory, setByDirectory] = useState<ReadonlyMap<string, PortListing>>(NO_PORTS);

  useEffect(() => {
    const request = JSON.parse(targetsKey) as typeof targets;
    if (request.length === 0) {
      setByDirectory(NO_PORTS);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const result = await rpc.call("listPorts", { targets: request });
        if (cancelled) return;
        const next = new Map<string, PortListing>();
        for (const entry of result.ports) {
          if (entry.listing.ports.length > 0) {
            next.set(`${entry.hostId}\n${entry.directory}`, entry.listing);
          }
        }
        setByDirectory(next.size === 0 ? NO_PORTS : next);
      } catch {
        // Keep the last ports; the next tick asks again.
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), PORTS_POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [rpc, targetsKey]);

  return useMemo(() => {
    if (byDirectory.size === 0) return NO_PORTS;
    const byThread = new Map<string, PortListing>();
    for (const thread of threads) {
      const hostId = thread.host?.id;
      const path = thread.environment?.path?.trim();
      if (!hostId || !path) continue;
      const ports = byDirectory.get(`${hostId}\n${path}`);
      if (ports !== undefined) byThread.set(thread.id, ports);
    }
    return byThread;
  }, [byDirectory, threads]);
}
