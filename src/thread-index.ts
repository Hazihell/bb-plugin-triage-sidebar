/**
 * Every live thread from one read of bb's thread list, indexed for the
 * questions the sweep and the reap ask.
 *
 * bb's list rows already carry what used to take a round trip per thread:
 * whether a question is waiting on the user, every kind of activity, the
 * parent link and the environment's machine, path and kind. Reading the list
 * once and answering from memory replaces a `threads.get`, an
 * `interactions.list`, an `environments.get` and a child listing per thread.
 */

/** The fields of one bb thread list row this plugin reads. */
export interface IndexedThread {
  id: string;
  status: string;
  runtime?: { displayStatus?: string };
  parentThreadId: string | null;
  environmentId: string | null;
  environmentHostId: string | null;
  environmentPath: string | null;
  environmentIsWorktree: boolean | null;
  hasPendingInteraction: boolean;
  latestAttentionAt: number;
  lastReadAt: number | null;
  title: string | null;
  titleFallback: string | null;
  activity: {
    activeBackgroundAgentCount: number;
    activeBackgroundCommandCount: number;
    activeGoalCount: number;
    activePlanModeCount: number;
    activeWorkflowCount: number;
  };
}

export interface ThreadIndex {
  get(threadId: string): IndexedThread | undefined;
  childrenOf(threadId: string): readonly IndexedThread[];
}

export function buildThreadIndex(threads: readonly IndexedThread[]): ThreadIndex {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const children = new Map<string, IndexedThread[]>();
  for (const thread of threads) {
    if (thread.parentThreadId === null) continue;
    const siblings = children.get(thread.parentThreadId) ?? [];
    siblings.push(thread);
    children.set(thread.parentThreadId, siblings);
  }
  return {
    get: (threadId) => byId.get(threadId),
    childrenOf: (threadId) => children.get(threadId) ?? [],
  };
}

const RUNNING_STATUSES = new Set(["active", "starting", "stopping", "provisioning"]);

/**
 * Whether a turn is in flight: bb's status or its runtime says the agent is
 * running, or a background agent is. This is the reap's test for "another
 * thread is mid-turn in this worktree".
 */
export function isTurnLive(thread: IndexedThread): boolean {
  if (thread.activity.activeBackgroundAgentCount > 0) return true;
  return [thread.status, thread.runtime?.displayStatus].some(
    (status) => status !== undefined && RUNNING_STATUSES.has(status),
  );
}

/**
 * Whether bb's record shows any live work: a turn, or any of the activity
 * kinds the sidebar counts as work (workflows, background commands, plan
 * mode, goals).
 *
 * The mirror of the sidebar's `isWorking`, read from the list row instead of
 * the sidebar's projection, so the sweep and the sidebar agree about which
 * threads may be parked. Deliberately generous: archiving a thread that is
 * still working is the one failure the sweep cannot afford.
 */
export function isThreadWorking(thread: IndexedThread): boolean {
  const { activity } = thread;
  return (
    isTurnLive(thread) ||
    activity.activeWorkflowCount > 0 ||
    activity.activeBackgroundCommandCount > 0 ||
    activity.activePlanModeCount > 0 ||
    activity.activeGoalCount > 0
  );
}
