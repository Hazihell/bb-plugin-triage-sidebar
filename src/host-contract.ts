/**
 * The contract between the plugin's server and its host entry — the part of
 * the plugin that runs on the machine holding a worktree.
 *
 * Its own module because both sides import it, and the host bundle must not
 * pull in the server (or anything it imports) to get at one schema.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const reapedProcessSchema = z.object({
  pid: z.number(),
  command: z.string(),
});

/** The longest process summary one port row carries. */
export const MAX_PORT_COMMAND_LENGTH = 120;

/** One listening port and the process that owns it. */
export const listeningPortSchema = z
  .object({
    port: z.number(),
    pid: z.number(),
    /**
     * `node · vite --port 3000`: the owning process's command line, paths cut
     * to their last segment and bounded. Empty when `ps` could not say.
     */
    command: z.string().max(MAX_PORT_COMMAND_LENGTH),
  })
  .strict();

/** What one directory serves: the ports worth showing, then how many more. */
export const portListingSchema = z
  .object({
    ports: z.array(listeningPortSchema),
    /** Listeners past the per-directory cap, counted but not sent. */
    more: z.number(),
  })
  .strict();

/**
 * What stopping one port's process came to. `changed` means the pid is no
 * longer the one listening on that port under that directory, so nothing was
 * signalled and the card should look again.
 */
export const portStopReportSchema = z
  .object({
    result: z.enum(["killed", "already-gone", "changed", "refused", "failed"]),
    /** A short line for the card, when there is something to say. */
    message: z.string().nullable(),
  })
  .strict();

export type ListeningPort = z.infer<typeof listeningPortSchema>;
export type PortStopReport = z.infer<typeof portStopReportSchema>;
export type PortListing = z.infer<typeof portListingSchema>;

export const hostContract = defineRpcContract({
  /**
   * Stop every process whose working directory is the directory or under it.
   * The server resolves which directory from bb; the host only kills.
   */
  reapDirectory: {
    input: z.object({ directory: z.string().min(1) }).strict(),
    output: z
      .object({
        killed: z.array(reapedProcessSchema),
        /** Signalled but still alive afterwards — never claimed as killed. */
        failed: z.number(),
        /** Set when the host refused the directory; nothing was signalled. */
        refused: z.string().nullable(),
      })
      .strict(),
  },
  /**
   * The TCP ports listening under each directory, with the process behind
   * each, from one scan of the machine. Read-only: nothing is signalled.
   * Every directory asked about has an entry, empty when nothing listens there.
   */
  listPorts: {
    input: z
      .object({ directories: z.array(z.string().min(1)).max(500) })
      .strict(),
    output: z
      .object({ ports: z.record(z.string(), portListingSchema) })
      .strict(),
  },
  /**
   * Stop the process listening on one port under a directory: SIGTERM, then
   * SIGKILL after a grace period. The host scans again first and signals only
   * if that pid still listens on that port with its working directory under
   * the directory; otherwise it answers `changed` and signals nothing.
   */
  stopPort: {
    input: z
      .object({
        directory: z.string().min(1),
        port: z.number().int().min(1).max(65535),
        pid: z.number().int().positive(),
      })
      .strict(),
    output: portStopReportSchema,
  },
});
