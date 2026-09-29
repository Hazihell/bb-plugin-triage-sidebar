/**
 * The server's side of the port card: route the sidebar's directories to the
 * machines that hold them, one host call per machine.
 *
 * The sidebar already knows each thread's machine and checkout path, so it
 * sends them rather than having the server list every thread on each poll.
 * The server only groups, fans out and bounds; the host does the scan.
 *
 * Stopping a port is the one call that does not trust the sidebar's paths.
 * The sidebar names a thread, a port and a pid; the server looks the thread's
 * machine and directory up in bb, and the host checks the pid against a fresh
 * scan before it signals anything.
 */
import { z } from "zod";
import {
  portListingSchema,
  portStopReportSchema,
  type PortListing,
  type PortStopReport,
} from "./host-contract";

/** How long one machine's scan may take before its ports are left out. */
const PORT_SCAN_TIMEOUT_MS = 10_000;

/** A re-scan plus SIGTERM's grace and SIGKILL's wait, with room to spare. */
const PORT_STOP_TIMEOUT_MS = 15_000;

export const portsRpcContract = {
  listPorts: {
    input: z.object({
      targets: z
        .array(
          z.object({
            hostId: z.string().min(1),
            directories: z.array(z.string().min(1)).max(500),
          }),
        )
        .max(50),
    }),
    output: z.object({
      /** False when the setting is off: nothing was scanned. */
      enabled: z.boolean(),
      /** One entry per directory a reachable machine answered for. */
      ports: z.array(
        z.object({
          hostId: z.string(),
          directory: z.string(),
          listing: portListingSchema,
        }),
      ),
    }),
  },
  stopPort: {
    input: z.object({
      threadId: z.string().trim().min(1),
      port: z.number().int().min(1).max(65535),
      pid: z.number().int().positive(),
    }),
    output: portStopReportSchema,
  },
};

type ListPortsInput = z.infer<(typeof portsRpcContract)["listPorts"]["input"]>;
type ListPortsOutput = z.infer<(typeof portsRpcContract)["listPorts"]["output"]>;
type StopPortInput = z.infer<(typeof portsRpcContract)["stopPort"]["input"]>;

export interface PortRpcDeps {
  readEnabled: () => Promise<boolean>;
  scanHost: (
    hostId: string,
    directories: string[],
    options: { timeoutMs: number },
  ) => Promise<{ ports: Record<string, PortListing> }>;
  /** The thread's machine and checkout as bb records them, or null. */
  resolveThread: (threadId: string) => Promise<{ hostId: string; directory: string } | null>;
  stopOnHost: (
    hostId: string,
    input: { directory: string; port: number; pid: number },
    options: { timeoutMs: number },
  ) => Promise<PortStopReport>;
  log: { warn: (message: string) => void };
}

export function createPortHandlers(deps: PortRpcDeps) {
  return {
    async listPorts({ targets }: ListPortsInput): Promise<ListPortsOutput> {
      if (!(await deps.readEnabled())) return { enabled: false, ports: [] };
      // Merged per machine, so a sidebar that sent one machine twice still
      // costs it one scan.
      const byHost = new Map<string, Set<string>>();
      for (const { hostId, directories } of targets) {
        const set = byHost.get(hostId) ?? new Set<string>();
        for (const directory of directories) set.add(directory);
        byHost.set(hostId, set);
      }
      const answers = await Promise.all(
        [...byHost].map(async ([hostId, directories]) => {
          if (directories.size === 0) return [];
          try {
            const { ports } = await deps.scanHost(hostId, [...directories], {
              timeoutMs: PORT_SCAN_TIMEOUT_MS,
            });
            return Object.entries(ports).map(([directory, listing]) => ({
              hostId,
              directory,
              listing,
            }));
          } catch (error) {
            // An unreachable machine shows no ports; the next poll asks again.
            deps.log.warn(`ports: could not scan host ${hostId} (${String(error)})`);
            return [];
          }
        }),
      );
      return { enabled: true, ports: answers.flat() };
    },
    async stopPort({ threadId, port, pid }: StopPortInput): Promise<PortStopReport> {
      if (!(await deps.readEnabled())) {
        return { result: "refused", message: "Listening ports are turned off" };
      }
      let target: { hostId: string; directory: string } | null;
      try {
        target = await deps.resolveThread(threadId);
      } catch (error) {
        deps.log.warn(`ports: could not look up ${threadId} (${String(error)})`);
        return { result: "failed", message: "Could not look up the thread" };
      }
      if (target === null) {
        return { result: "refused", message: "The thread has no directory on record" };
      }
      try {
        return await deps.stopOnHost(
          target.hostId,
          { directory: target.directory, port, pid },
          { timeoutMs: PORT_STOP_TIMEOUT_MS },
        );
      } catch (error) {
        deps.log.warn(
          `ports: could not stop pid ${pid} on host ${target.hostId} (${String(error)})`,
        );
        return { result: "failed", message: "Could not reach the machine" };
      }
    },
  };
}
