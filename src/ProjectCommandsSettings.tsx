import { useEffect, useState } from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { triageSidebarRpcContract } from "./server";
import type { ProjectCommand } from "./project-commands";
import {
  MAX_COMMAND_LENGTH,
  MAX_COMMAND_NAME_LENGTH,
  MAX_COMMANDS_PER_PROJECT,
} from "./project-command-limits";
import { Icon } from "./components/Icon";
import { cn } from "./lib/utils";

/**
 * Where a project's commands are written: the list a thread header's Run
 * control offers, and which of them is the dev server.
 *
 * One project at a time, edited as a draft and saved whole. The server checks
 * every rule again and its refusal is shown as it words it, so the checks
 * here only keep the Save button honest.
 */

/** A row being edited. `key` is local; `id` is absent until first saved. */
interface DraftRow {
  key: string;
  id?: string;
  name: string;
  command: string;
  isDevServer: boolean;
}

let nextKey = 0;
const toDraft = (command: ProjectCommand): DraftRow => ({ key: command.id, ...command });
const emptyRow = (): DraftRow => ({
  key: `new-${nextKey++}`,
  name: "",
  command: "",
  isDevServer: false,
});

export function ProjectCommandsSettings() {
  const { status, projects } = useSidebarThreads();
  const [projectId, setProjectId] = useState<string | null>(null);

  if (status === "loading") return null;
  if (status === "error") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Could not load projects.
      </p>
    );
  }
  if (projects.length === 0) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        No projects yet.
      </p>
    );
  }

  const selected = projects.find((project) => project.id === projectId) ?? projects[0]!;

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-2xs text-muted-foreground">
        Project
        <select
          value={selected.id}
          onChange={(event) => setProjectId(event.target.value)}
          className={cn(INPUT_CLASS, "w-64")}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      {/* Keyed by project, so switching projects discards the other draft. */}
      <CommandEditor key={selected.id} projectId={selected.id} projectName={selected.name} />
    </div>
  );
}

function CommandEditor({ projectId, projectName }: { projectId: string; projectName: string }) {
  const rpc = useRpc<typeof triageSidebarRpcContract>();
  const [rows, setRows] = useState<DraftRow[] | null>(null);
  const [saved, setSaved] = useState<string>("[]");
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [isBusy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    rpc
      .call("listProjectCommands", { projectId })
      .then(({ commands }) => {
        if (cancelled) return;
        setRows(commands.map(toDraft));
        setSaved(JSON.stringify(commands.map(toDraft)));
      })
      .catch((error: unknown) => {
        if (!cancelled) setMessage({ error: true, text: errorText(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, projectId]);

  if (rows === null) {
    return message ? <Message message={message} /> : null;
  }

  const update = (key: string, patch: Partial<DraftRow>) => {
    setMessage(null);
    setRows((current) =>
      (current ?? []).map((row) => {
        if (row.key === key) return { ...row, ...patch };
        // Marking one row the dev server unmarks the others.
        if (patch.isDevServer === true) return { ...row, isDevServer: false };
        return row;
      }),
    );
  };
  const move = (index: number, by: -1 | 1) => {
    setMessage(null);
    setRows((current) => {
      const next = [...(current ?? [])];
      const [row] = next.splice(index, 1);
      next.splice(index + by, 0, row!);
      return next;
    });
  };
  const remove = (key: string) => {
    setMessage(null);
    setRows((current) => (current ?? []).filter((row) => row.key !== key));
  };

  const clearDevServer = () => {
    setMessage(null);
    setRows((current) => (current ?? []).map((row) => ({ ...row, isDevServer: false })));
  };

  const incomplete = rows.some((row) => row.name.trim() === "" || row.command.trim() === "");
  const dirty = JSON.stringify(rows) !== saved;

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { commands } = await rpc.call("saveProjectCommands", {
        projectId,
        commands: rows.map(({ id, name, command, isDevServer }) => ({
          ...(id === undefined ? {} : { id }),
          name,
          command,
          isDevServer,
        })),
      });
      const next = commands.map(toDraft);
      setRows(next);
      setSaved(JSON.stringify(next));
      setMessage({ error: false, text: "Saved." });
    } catch (error) {
      setMessage({ error: true, text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No commands for {projectName}. Add one to get a Run control in its threads' header.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((row, index) => (
            <li key={row.key} className="flex flex-wrap items-center gap-2">
              <input
                value={row.name}
                aria-label={`Name of command ${index + 1}`}
                placeholder="Name"
                maxLength={MAX_COMMAND_NAME_LENGTH}
                onChange={(event) => update(row.key, { name: event.target.value })}
                className={cn(INPUT_CLASS, "w-36")}
              />
              <input
                value={row.command}
                aria-label={`Shell command ${index + 1}`}
                placeholder="pnpm dev"
                maxLength={MAX_COMMAND_LENGTH}
                onChange={(event) => update(row.key, { command: event.target.value })}
                className={cn(INPUT_CLASS, "w-72 font-mono")}
              />
              <label className="flex items-center gap-1 text-2xs text-muted-foreground">
                <input
                  type="radio"
                  name={`dev-server-${projectId}`}
                  checked={row.isDevServer}
                  onChange={() => update(row.key, { isDevServer: true })}
                />
                Dev server
              </label>
              <IconButton label={`Move command ${index + 1} up`} icon="ChevronUp" disabled={index === 0} onClick={() => move(index, -1)} />
              <IconButton
                label={`Move command ${index + 1} down`}
                icon="ChevronDown"
                disabled={index === rows.length - 1}
                onClick={() => move(index, 1)}
              />
              <IconButton label={`Delete command ${index + 1}`} icon="Delete" onClick={() => remove(row.key)} />
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <RowButton
          disabled={rows.length >= MAX_COMMANDS_PER_PROJECT}
          onClick={() => {
            setMessage(null);
            setRows([...rows, emptyRow()]);
          }}
        >
          <Icon name="Add" className="size-3" aria-hidden />
          Add command
        </RowButton>
        {rows.some((row) => row.isDevServer) ? (
          <RowButton onClick={clearDevServer}>No dev server</RowButton>
        ) : null}
        <RowButton disabled={isBusy || incomplete || !dirty} onClick={() => void save()}>
          Save
        </RowButton>
        {rows.length >= MAX_COMMANDS_PER_PROJECT ? (
          <span className="text-2xs text-muted-foreground">
            {MAX_COMMANDS_PER_PROJECT} is the most a project can have.
          </span>
        ) : null}
        {message ? <Message message={message} /> : null}
      </div>
    </div>
  );
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Message({ message }: { message: { error: boolean; text: string } }) {
  return (
    <span role="status" className={cn("text-2xs", message.error ? "text-destructive" : "text-muted-foreground")}>
      {message.text}
    </span>
  );
}

const INPUT_CLASS =
  "h-7 rounded-md border border-input bg-transparent px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring";

function IconButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: "ChevronUp" | "ChevronDown" | "Delete";
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Icon name={icon} className="size-3.5" aria-hidden />
    </button>
  );
}

function RowButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-input px-2 py-1 text-2xs text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}
