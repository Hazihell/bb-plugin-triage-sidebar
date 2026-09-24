import type {
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk";

/**
 * One sidebar row as the host would report it, with every field a test does
 * not care about at rest. `displayTitle` follows `title` the way the host
 * resolves it, so a test that sets only a title still sees it rendered.
 */
export function sidebarThread(
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  const id = overrides.id ?? "thr_1";
  const projectId = overrides.projectId ?? "proj_1";
  const title = overrides.title === undefined ? "A thread" : overrides.title;
  const titleFallback = overrides.titleFallback ?? null;
  return {
    id,
    projectId,
    title,
    titleFallback,
    displayTitle: title ?? titleFallback ?? id,
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    href: `/projects/${projectId}/threads/${id}`,
    isHidden: false,
    environment: null,
    host: null,
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  };
}

export function sidebarProject(id: string, name: string): PluginSidebarProject {
  return {
    id,
    name,
    isPersonal: false,
    href: `/projects/${id}`,
    settingsHref: `/projects/${id}/settings`,
  };
}
