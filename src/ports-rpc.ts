/**
 * The server's side of port pills: route the sidebar's directories to the
 * machines that hold them, one host call per machine.
 *
 * The sidebar already knows each thread's machine and checkout path, so it
 * sends them rather than having the server list every thread on each poll.
 * The server only groups, fans out and bounds; the host does the scan.
 */
import { z } from "zod";

/** How long one machine's scan may take before its pills are left out. */
const PORT_SCAN_TIMEOUT_MS = 10_000;

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
          ports: z.array(z.number()),
        }),
      ),
    }),
  },
};

type ListPortsInput = z.infer<(typeof portsRpcContract)["listPorts"]["input"]>;
type ListPortsOutput = z.infer<(typeof portsRpcContract)["listPorts"]["output"]>;

export interface PortRpcDeps {
  readEnabled: () => Promise<boolean>;
  scanHost: (
    hostId: string,
    directories: string[],
    options: { timeoutMs: number },
  ) => Promise<{ ports: Record<string, number[]> }>;
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
            return Object.entries(ports).map(([directory, list]) => ({
              hostId,
              directory,
              ports: list,
            }));
          } catch (error) {
            // An unreachable machine shows no pills; the next poll asks again.
            deps.log.warn(`ports: could not scan host ${hostId} (${String(error)})`);
            return [];
          }
        }),
      );
      return { enabled: true, ports: answers.flat() };
    },
  };
}
