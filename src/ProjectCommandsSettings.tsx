import { useState } from "react";
import { experimental_useSidebarThreads as useSidebarThreads } from "@get-bb/plugin-sdk/app";
import { INPUT_CLASS, ProjectCommandEditor } from "./ProjectCommandEditor";
import { cn } from "./lib/utils";

/**
 * Where a project's commands are written: the list a thread header's Run
 * control and a thread row's commands popover offer, and which of them is
 * the dev server. One project at a time, in the editor the rows share.
 */

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
      <ProjectCommandEditor key={selected.id} projectId={selected.id} projectName={selected.name} />
    </div>
  );
}
