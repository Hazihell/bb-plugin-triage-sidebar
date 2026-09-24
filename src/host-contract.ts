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
});
