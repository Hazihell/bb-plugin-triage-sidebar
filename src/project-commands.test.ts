import { describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type CreateFakePluginHostOptions,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import {
  MAX_COMMAND_LENGTH,
  MAX_COMMANDS_PER_PROJECT,
  type ProjectCommand,
  type ProjectCommandDraft,
} from "./project-commands";

/** The real plugin on the fake host, so the migrations and contract are real. */
function load(options: CreateFakePluginHostOptions = {}): FakePluginHost {
  const host = createFakePluginHost({ pluginId: "triage-sidebar", ...options });
  plugin(host.bb);
  return host;
}

const call = <T>(host: FakePluginHost, method: string, input: unknown) =>
  host.harness.behavior.callRpc(method, input) as Promise<T>;

const save = (host: FakePluginHost, projectId: string, commands: unknown) =>
  call<{ commands: ProjectCommand[] }>(host, "saveProjectCommands", { projectId, commands });

const draft = (overrides: Partial<ProjectCommandDraft> = {}): ProjectCommandDraft => ({
  name: "dev",
  command: "pnpm dev",
  isDevServer: false,
  ...overrides,
});

describe("project command store", () => {
  it("adds, edits, reorders and deletes through one save", async () => {
    const host = load();
    const first = await save(host, "prj_1", [
      draft({ name: "dev", isDevServer: true }),
      draft({ name: "test", command: "pnpm test" }),
    ]);
    expect(first.commands.map((c) => c.name)).toEqual(["dev", "test"]);
    const [dev, test] = first.commands as [ProjectCommand, ProjectCommand];

    // Reorder and edit, keeping ids; drop nothing yet.
    const second = await save(host, "prj_1", [
      { ...test, command: "pnpm vitest" },
      dev,
    ]);
    expect(second.commands).toEqual([
      { ...test, command: "pnpm vitest" },
      dev,
    ]);

    // Delete by leaving it out.
    await save(host, "prj_1", [dev]);
    expect(
      (await call<{ commands: ProjectCommand[] }>(host, "listProjectCommands", { projectId: "prj_1" }))
        .commands,
    ).toEqual([dev]);
  });

  it("keeps each project's list to itself", async () => {
    const host = load();
    await save(host, "prj_1", [draft()]);
    await save(host, "prj_2", [draft({ name: "build" })]);
    const list = await call<{ commands: ProjectCommand[] }>(host, "listProjectCommands", {
      projectId: "prj_1",
    });
    expect(list.commands.map((c) => c.name)).toEqual(["dev"]);
  });

  it("refuses a second dev server", async () => {
    const host = load();
    await expect(
      save(host, "prj_1", [
        draft({ name: "a", isDevServer: true }),
        draft({ name: "b", isDevServer: true }),
      ]),
    ).rejects.toThrow(/one command can be the dev server/);
  });

  it("holds the dev-server rule in the table too", () => {
    const host = load();
    const db = host.bb.storage.database();
    const insert = db.prepare(
      `INSERT INTO project_command (project_id, id, name, command, sort_order, is_dev_server)
         VALUES ('prj_1', ?, ?, 'x', 0, 1)`,
    );
    insert.run("a", "a");
    expect(() => insert.run("b", "b")).toThrow(/UNIQUE/);
  });

  it(`refuses more than ${MAX_COMMANDS_PER_PROJECT} commands`, async () => {
    const host = load();
    const many = Array.from({ length: MAX_COMMANDS_PER_PROJECT + 1 }, (_, i) =>
      draft({ name: `c${i}` }),
    );
    await expect(save(host, "prj_1", many)).rejects.toThrow(/At most 12/);
    await expect(save(host, "prj_1", many.slice(0, MAX_COMMANDS_PER_PROJECT))).resolves.toBeDefined();
  });

  it("leaves the stored list untouched when a save is refused", async () => {
    const host = load();
    await save(host, "prj_1", [draft()]);
    await expect(save(host, "prj_1", [draft({ name: "" })])).rejects.toThrow();
    const list = await call<{ commands: ProjectCommand[] }>(host, "listProjectCommands", {
      projectId: "prj_1",
    });
    expect(list.commands.map((c) => c.name)).toEqual(["dev"]);
  });
});

describe("saveProjectCommands validation", () => {
  it.each([
    ["an empty name", [draft({ name: "   " })], /needs a name/],
    ["an empty command", [draft({ command: "" })], /needs a shell command/],
    ["an overlong name", [draft({ name: "x".repeat(61) })], /at most 60/],
    ["an overlong command", [draft({ command: "x".repeat(MAX_COMMAND_LENGTH + 1) })], /at most 2000/],
    ["a multi-line name", [draft({ name: "a\nb" })], /one line/],
    ["duplicate names", [draft({ name: "Dev" }), draft({ name: "dev" })], /named/],
    ["a malformed id", [{ ...draft(), id: "../../x" }], /ids are/],
    ["a non-boolean dev-server flag", [{ ...draft(), isDevServer: "yes" }], /./],
    ["a list that is not a list", { dev: "pnpm dev" }, /./],
  ])("refuses %s", async (_label, commands, message) => {
    const host = load();
    await expect(save(host, "prj_1", commands)).rejects.toThrow(message);
  });

  it("stores trimmed values", async () => {
    const host = load();
    const { commands } = await save(host, "prj_1", [draft({ name: "  dev ", command: " pnpm dev\n" })]);
    expect(commands[0]).toMatchObject({ name: "dev", command: "pnpm dev" });
  });
});

describe("running a command in a thread's terminal", () => {
  type Session = { id: string; title: string; status: string };

  async function setup(sessions: Session[] = []) {
    const create = vi.fn(() => ({ id: "term_new", title: "dev", status: "starting" }));
    const close = vi.fn(() => ({ id: "term_live", status: "exited" }));
    const host = load({
      sdk: {
        threads: {
          get: ({ threadId }: { threadId: string }) =>
            makeThreadResponse({ id: threadId, projectId: "prj_1" }),
        },
        terminals: { list: () => ({ sessions }), create, close },
      } as CreateFakePluginHostOptions["sdk"],
    });
    const { commands } = await save(host, "prj_1", [
      draft({ name: "dev", command: "pnpm dev", isDevServer: true }),
      draft({ name: "test", command: "pnpm test" }),
    ]);
    const [dev, test] = commands as [ProjectCommand, ProjectCommand];
    return { host, create, close, dev, test };
  }

  it("starts the command in a terminal on the thread, titled with its name", async () => {
    const { host, create, dev } = await setup();
    const result = await call(host, "runProjectCommand", { threadId: "thr_1", commandId: dev.id });
    expect(result).toEqual({ outcome: "started", terminalId: "term_new" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: "thread", threadId: "thr_1" },
        start: { mode: "command", command: "pnpm dev" },
        title: "dev",
      }),
    );
  });

  it("does not start a duplicate when a live terminal has the title", async () => {
    const { host, create, dev } = await setup([
      { id: "term_live", title: "dev", status: "running" },
    ]);
    const result = await call(host, "runProjectCommand", { threadId: "thr_1", commandId: dev.id });
    expect(result).toEqual({ outcome: "already-running", terminalId: "term_live" });
    expect(create).not.toHaveBeenCalled();
  });

  it("starts again when the terminal with the title has exited", async () => {
    const { host, create, dev } = await setup([
      { id: "term_old", title: "dev", status: "exited" },
    ]);
    await call(host, "runProjectCommand", { threadId: "thr_1", commandId: dev.id });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("stops the live terminal, and reports when there is none", async () => {
    const running = await setup([{ id: "term_live", title: "dev", status: "running" }]);
    expect(
      await call(running.host, "stopProjectCommand", { threadId: "thr_1", commandId: running.dev.id }),
    ).toEqual({ outcome: "stopped" });
    expect(running.close).toHaveBeenCalledWith({ terminalId: "term_live", mode: "force" });

    const idle = await setup();
    expect(
      await call(idle.host, "stopProjectCommand", { threadId: "thr_1", commandId: idle.dev.id }),
    ).toEqual({ outcome: "not-running" });
    expect(idle.close).not.toHaveBeenCalled();
  });

  it("reports each command's live terminal", async () => {
    const { host, dev, test } = await setup([
      { id: "term_live", title: "dev", status: "running" },
      { id: "term_shell", title: "zsh", status: "running" },
    ]);
    const status = await call<{ commands: Array<{ id: string; terminalId: string | null }> }>(
      host,
      "threadCommandStatus",
      { threadId: "thr_1" },
    );
    expect(status.commands.map((c) => [c.id, c.terminalId])).toEqual([
      [dev.id, "term_live"],
      [test.id, null],
    ]);
  });

  it("refuses a command id from another project", async () => {
    const { host, create } = await setup();
    const other = await save(host, "prj_2", [draft({ name: "evil", command: "rm -rf ~" })]);
    await expect(
      call(host, "runProjectCommand", { threadId: "thr_1", commandId: other.commands[0]!.id }),
    ).rejects.toThrow(/not set up/);
    expect(create).not.toHaveBeenCalled();
  });
});
