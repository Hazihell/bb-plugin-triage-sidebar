# Reap on settle

## Why
Settling a thread means its work is done. Today the processes that work started
outlive it: agent-launched dev servers detach from their shell, get reparented
to launchd, and belong to no terminal and no thread. Five orphaned Vite servers
under one worktree held ~375% CPU for four hours with nothing watching them.
bb's own bookkeeping reported zero background commands for all five, so neither
archiving nor closing a pane would ever have reached them.

## The rule
When a thread settles, it reaps its subtree:

1. Walk the subtree deepest-first, reusing `collectSubtreeDeepestFirst`. A
   parent never reaps before its children are quiet.
2. Close every terminal bb still reports as live for those threads — deepest
   first — via `bb.terminals.list` filtered by `threadId`, then `close`. An
   already-exited session is skipped: there is nothing to close, and counting
   it would credit the reap with a death it did not cause.
3. Only once every terminal in the subtree is closed, sweep the worktrees those
   threads belong to. Two phases rather than close-then-sweep per thread: a
   subtree usually shares one worktree, and sweeping it while a parent's
   terminal is still open would kill that terminal's processes from underneath
   it. Deepest-first still governs the closing.
4. A process belongs to the worktree when its working directory is inside it.
   Argv is the fallback for a process whose directory the system will not
   report — a detached dev server runs out of `node_modules` inside the
   worktree and so carries the path in argv. Both tests are boundary-safe, so a
   sibling worktree whose path merely starts the same way is never matched.

Reaping is best-effort per thread. A subtree bb will not enumerate falls back to
reaping the one thread that was settled; a terminal that will not close, or a
process that will not die, is reported and skipped. The settle is the user's
decision and must not fail because cleanup did.

## What it deliberately does not do
No sibling guard. A worktree shared with an unsettled sibling loses that
sibling's dev server too, because an orphan offers nothing to distinguish it by.
This is a chosen trade: a guard on unsettled siblings would have spared every
one of the five processes that caused the problem. Restarting a dev server is
cheap; a machine at load 8 for four hours is not.

## Surfaces
- Setting `reapOnSettle`, default on. Off restores today's behaviour exactly.
- The settle result names what it closed and killed, the same way the
  auto-archive sweep names what it archived. Failures stay counts: what failed
  is in the log, and a user can do nothing with the identity of a terminal bb
  could not close.
- The auto-archive sweep reaps too, on the same rule: a settle that ages into
  an archive should not leave behind what an interactive settle would have
  taken.

## Boundaries
- `bb.terminals` is the host's; the plugin only lists and closes.
- Process discovery and killing is the plugin's own, in a module with no
  knowledge of shelves or settle — it takes a worktree path and returns what it
  killed. Testable without a daemon.
- It spares only the reaper's own process tree. Sparing terminal-owned
  processes was considered and dropped: bb's terminal sessions carry no pid, so
  there is no honest way to name them, and a process still running under a
  terminal that failed to close is exactly what this feature exists to stop.
- Lifecycle rules stay in `lifecycle.ts` as pure functions. Reaping is an
  effect the server performs after the shelf decision, never a new shelf.
