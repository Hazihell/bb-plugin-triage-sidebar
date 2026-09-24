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
  /** Set on a thread whose lifetime another thread owns; bb archives it along. */
  lifecycleOwnerThreadId: string | null;
  /** The thread this one was forked or spun off from. */
  sourceThreadId: string | null;
  visibility: string;
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
  /**
   * Every thread bb's archive of this one takes with it, one level down: its
   * children, the threads whose lifetime it owns, and the hidden threads spun
   * off from it. The same three lists bb's own archive walks.
   */
  dependentsOf(threadId: string): readonly IndexedThread[];
}

export function buildThreadIndex(threads: readonly IndexedThread[]): ThreadIndex {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const dependents = new Map<string, IndexedThread[]>();
  const add = (ownerId: string | null, thread: IndexedThread) => {
    if (ownerId === null || ownerId === thread.id) return;
    const list = dependents.get(ownerId) ?? [];
    if (!list.includes(thread)) list.push(thread);
    dependents.set(ownerId, list);
  };
  for (const thread of threads) {
    add(thread.parentThreadId, thread);
    add(thread.lifecycleOwnerThreadId, thread);
    if (thread.visibility === "hidden") add(thread.sourceThreadId, thread);
  }
  return {
    get: (threadId) => byId.get(threadId),
    dependentsOf: (threadId) => dependents.get(threadId) ?? [],
  };
}

/**
 * The tree bb's archive of `rootThreadId` takes, deepest first, root last.
 *
 * Deepest first so a reap closes a child's terminals before its parent's.
 * The visited set and depth bound are guards: a cycle or a runaway tree costs
 * a bounded walk, never a hang.
 */
export function archiveTreeOf(
  index: ThreadIndex,
  rootThreadId: string,
  maxDepth = 20,
): string[] {
  const seen = new Set<string>([rootThreadId]);
  const walk = (threadId: string, depth: number): string[] => {
    const order: string[] = [];
    if (depth < maxDepth) {
      for (const dependent of index.dependentsOf(threadId)) {
        if (seen.has(dependent.id)) continue;
        seen.add(dependent.id);
        order.push(...walk(dependent.id, depth + 1));
      }
    }
    order.push(threadId);
    return order;
  };
  return walk(rootThreadId, 0);
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
