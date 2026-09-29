/**
 * Per-project commands — `pnpm dev`, `npm test`, a seed script — that a thread
 * of that project can run in a BB terminal from its header.
 *
 * The frontend never sends a shell command to run. It sends a thread and a
 * command id; the server reads the thread's project from bb and the command
 * from its own table. So the only way to make this plugin run a string is to
 * save it in Settings, and that path is validated here too.
 *
 * A command's terminal is found again by its title, which is the command's
 * name. That is why names are unique within a project: two commands with one
 * name would share one "is it running?" answer.
 */
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  MAX_COMMAND_LENGTH,
  MAX_COMMAND_NAME_LENGTH,
  MAX_COMMANDS_PER_PROJECT,
  MAX_STATUS_THREADS,
} from "./project-command-limits";

export { MAX_COMMAND_LENGTH, MAX_COMMAND_NAME_LENGTH, MAX_COMMANDS_PER_PROJECT };

/** The size a new terminal opens at; the panel resizes it when shown. */
const TERMINAL_COLS = 120;
const TERMINAL_ROWS = 32;

const idSchema = z.string().trim().min(1).max(200);
const commandIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "Command ids are letters, digits, - and _");

export const projectCommandSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  isDevServer: z.boolean(),
});
export type ProjectCommand = z.infer<typeof projectCommandSchema>;

/**
 * One command as the settings page sends it. A missing id is a new command;
 * an existing one keeps its id across edits and reorders. Renaming a command
 * while it runs loses track of that terminal, since terminals are matched by
 * title; the user can still close it from bb's terminal panel.
 */
const commandDraftSchema = z.object({
  id: commandIdSchema.optional(),
  name: z
    .string()
    .trim()
    .min(1, "Every command needs a name")
    .max(MAX_COMMAND_NAME_LENGTH, `Names are at most ${MAX_COMMAND_NAME_LENGTH} characters`)
    // A newline in a terminal title is nothing a user could read back.
    .refine((name) => !/[\r\n]/.test(name), "Names are one line"),
  command: z
    .string()
    .trim()
    .min(1, "Every command needs a shell command")
    .max(MAX_COMMAND_LENGTH, `Commands are at most ${MAX_COMMAND_LENGTH} characters`),
  isDevServer: z.boolean(),
});
export type ProjectCommandDraft = z.infer<typeof commandDraftSchema>;

export const commandListSchema = z
  .array(commandDraftSchema)
  .max(MAX_COMMANDS_PER_PROJECT, `At most ${MAX_COMMANDS_PER_PROJECT} commands per project`)
  .superRefine((commands, context) => {
    if (commands.filter((command) => command.isDevServer).length > 1) {
      context.addIssue({ code: "custom", message: "Only one command can be the dev server" });
    }
    const names = new Set<string>();
    const ids = new Set<string>();
    for (const command of commands) {
      const name = command.name.toLowerCase();
      if (names.has(name)) {
        context.addIssue({ code: "custom", message: `Two commands are named "${command.name}"` });
      }
      names.add(name);
      if (command.id !== undefined) {
        if (ids.has(command.id)) {
          context.addIssue({ code: "custom", message: "Two commands share one id" });
        }
        ids.add(command.id);
      }
    }
  });

/** Where a command stands on one thread: its live terminal, or none. */
const commandStatusSchema = projectCommandSchema.extend({
  terminalId: z.string().nullable(),
});
export type ProjectCommandStatus = z.infer<typeof commandStatusSchema>;

/**
 * The commands half of this plugin's RPC surface, spread into the one
 * contract in `server.ts` for the same reason the avatar half is.
 */
export const projectCommandsRpcContract = {
  listProjectCommands: {
    input: z.object({ projectId: idSchema }),
    output: z.object({ commands: z.array(projectCommandSchema) }),
  },
  /**
   * Replace a project's whole list, in the order given. Add, edit, delete and
   * reorder are all this one call: the settings page edits a draft and saves
   * it, so there is no half-saved list to reason about.
   */
  saveProjectCommands: {
    // Deliberately loose here: bb answers a schema failure at the boundary
    // with a generic message, and the settings page needs to say which rule
    // a list broke. The store parses it and throws that rule's message.
    input: z.object({ projectId: idSchema, commands: z.unknown() }),
    output: z.object({ commands: z.array(projectCommandSchema) }),
  },
  /** The thread's project's commands, each with its live terminal if any. */
  threadCommandStatus: {
    input: z.object({ threadId: idSchema }),
    output: z.object({ commands: z.array(commandStatusSchema) }),
  },
  /**
   * The same answer for many threads in one call: what the thread list asks
   * on each tick for the rows on screen. A thread whose status cannot be read
   * is left out rather than failing the rest.
   */
  threadsCommandStatus: {
    input: z.object({ threadIds: z.array(idSchema).max(MAX_STATUS_THREADS) }),
    output: z.object({
      statuses: z.array(
        z.object({ threadId: z.string(), commands: z.array(commandStatusSchema) }),
      ),
    }),
  },
  runProjectCommand: {
    input: z.object({ threadId: idSchema, commandId: idSchema }),
    output: z.object({
      /** "already-running" started nothing: a live terminal had its title. */
      outcome: z.enum(["started", "already-running"]),
      terminalId: z.string(),
    }),
  },
  stopProjectCommand: {
    input: z.object({ threadId: idSchema, commandId: idSchema }),
    output: z.object({ outcome: z.enum(["stopped", "not-running"]) }),
  },
};

export type ProjectCommandsRpcHandlers = {
  [K in keyof typeof projectCommandsRpcContract]: (
    input: z.infer<(typeof projectCommandsRpcContract)[K]["input"]>,
  ) => Promise<z.infer<(typeof projectCommandsRpcContract)[K]["output"]>>;
};

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

interface CommandDbRow {
  id: string;
  name: string;
  command: string;
  is_dev_server: number;
}

/** The table's reads and writes, and nothing about threads or terminals. */
export function createProjectCommandStore(db: Database) {
  const list = (projectId: string): ProjectCommand[] =>
    (
      db
        .prepare(
          `SELECT id, name, command, is_dev_server FROM project_command
             WHERE project_id = ? ORDER BY sort_order`,
        )
        .all(projectId) as CommandDbRow[]
    ).map((row) => ({
      id: row.id,
      name: row.name,
      command: row.command,
      isDevServer: row.is_dev_server === 1,
    }));

  const remove = db.prepare(`DELETE FROM project_command WHERE project_id = ?`);
  const insert = db.prepare(
    `INSERT INTO project_command (project_id, id, name, command, sort_order, is_dev_server)
       VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const replaceAll = db.transaction((projectId: string, commands: ProjectCommandDraft[]) => {
    remove.run(projectId);
    commands.forEach((command, index) => {
      insert.run(
        projectId,
        command.id ?? randomUUID(),
        command.name,
        command.command,
        index,
        command.isDevServer ? 1 : 0,
      );
    });
  });

  return {
    list,
    /**
     * Validated here as well as at the RPC boundary: the store is the last
     * thing between a caller and the table, and the single-dev-server rule is
     * also a unique index, which would otherwise surface as a SQLite error.
     */
    replace(projectId: string, commands: unknown): ProjectCommand[] {
      const result = commandListSchema.safeParse(commands);
      if (!result.success) {
        throw new Error(result.error.issues[0]?.message ?? "Invalid command list");
      }
      const parsed = result.data;
      replaceAll(projectId, parsed);
      return list(projectId);
    },
  };
}
export type ProjectCommandStore = ReturnType<typeof createProjectCommandStore>;

/** A terminal that can still take input; any other is gone or going. */
const isAlive = (status: string) => status === "running" || status === "starting";

interface TerminalsApi {
  list(args: {
    scope: { kind: "thread"; threadId: string };
  }): Promise<{ sessions: Array<{ id: string; title: string; status: string }> }>;
  create(args: {
    cols: number;
    rows: number;
    scope: { kind: "thread"; threadId: string };
    start: { mode: "command"; command: string };
    title: string;
  }): Promise<{ id: string }>;
  close(args: { terminalId: string; mode: "force" | "if-clean" }): Promise<unknown>;
}

export interface ProjectCommandDeps {
  store: ProjectCommandStore;
  /** The thread's project, read from bb rather than taken from the caller. */
  projectOf(threadId: string): Promise<string | null>;
  terminals: TerminalsApi;
}

export function createProjectCommandHandlers(
  deps: ProjectCommandDeps,
): ProjectCommandsRpcHandlers {
  const { store, terminals } = deps;

  const liveByTitle = async (threadId: string): Promise<Map<string, string>> => {
    const { sessions } = await terminals.list({ scope: { kind: "thread", threadId } });
    const byTitle = new Map<string, string>();
    for (const session of sessions) {
      if (isAlive(session.status)) byTitle.set(session.title, session.id);
    }
    return byTitle;
  };

  const commandFor = async (threadId: string, commandId: string): Promise<ProjectCommand> => {
    const projectId = await deps.projectOf(threadId);
    const command =
      projectId === null
        ? undefined
        : store.list(projectId).find((candidate) => candidate.id === commandId);
    // One message for both: a caller learns nothing about other projects.
    if (command === undefined) throw new Error("That command is not set up for this thread's project");
    return command;
  };

  const statusOf = async (threadId: string): Promise<ProjectCommandStatus[]> => {
    const projectId = await deps.projectOf(threadId);
    const commands = projectId === null ? [] : store.list(projectId);
    // No commands, no terminal lookup: most threads pay nothing.
    if (commands.length === 0) return [];
    const live = await liveByTitle(threadId);
    return commands.map((command) => ({
      ...command,
      terminalId: live.get(command.name) ?? null,
    }));
  };

  return {
    async listProjectCommands({ projectId }) {
      return { commands: store.list(projectId) };
    },
    async saveProjectCommands({ projectId, commands }) {
      return { commands: store.replace(projectId, commands) };
    },
    async threadCommandStatus({ threadId }) {
      return { commands: await statusOf(threadId) };
    },
    async threadsCommandStatus({ threadIds }) {
      const answers = await Promise.all(
        [...new Set(threadIds)].map(async (threadId) => {
          try {
            return { threadId, commands: await statusOf(threadId) };
          } catch {
            return null;
          }
        }),
      );
      return { statuses: answers.filter((answer) => answer !== null) };
    },
    async runProjectCommand({ threadId, commandId }) {
      const command = await commandFor(threadId, commandId);
      const running = (await liveByTitle(threadId)).get(command.name);
      if (running !== undefined) return { outcome: "already-running", terminalId: running };
      const created = await terminals.create({
        cols: TERMINAL_COLS,
        rows: TERMINAL_ROWS,
        scope: { kind: "thread", threadId },
        start: { mode: "command", command: command.command },
        title: command.name,
      });
      return { outcome: "started", terminalId: created.id };
    },
    async stopProjectCommand({ threadId, commandId }) {
      const command = await commandFor(threadId, commandId);
      // Resolved by title again rather than trusting a terminal id from the
      // caller, so stop can only ever close this thread's own command.
      const running = (await liveByTitle(threadId)).get(command.name);
      if (running === undefined) return { outcome: "not-running" };
      await terminals.close({ terminalId: running, mode: "force" });
      return { outcome: "stopped" };
    },
  };
}
