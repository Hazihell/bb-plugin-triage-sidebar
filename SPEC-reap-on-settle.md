# Reap on settle

## Why
Settling a thread means its work is done. Today the processes that work started
outlive it: agent-launched dev servers detach from their shell, get reparented
to launchd, and belong to no terminal and no thread. Five orphaned Vite servers
under one worktree held ~375% CPU for four hours with nothing watching them.
bb's own bookkeeping reported zero background commands for all five, so neither
archiving nor closing a pane would ever have reached them.

## The rule
When a thread settles, the settle is written and answered at once. The reap
then runs on its own and reports on the lifecycle channel:

1. Read bb's thread list fresh and walk the tree bb's archive would take —
   children, threads whose lifetime this one owns, and hidden threads spun off
   from it — deepest first. A parent never reaps before its children are
   quiet. A list that cannot be read stops nothing: without it there is no
   knowing which thread is running now.
2. Close every terminal bb still reports as live for those threads — deepest
   first — via `bb.terminals.list` filtered by `threadId`, then `close`. An
   already-exited session is skipped: there is nothing to close, and counting
   it would credit the reap with a death it did not cause. A thread in the
   tree that is running again (resumed after the settle) keeps its terminals.
3. Only once every terminal in the subtree is closed, sweep the worktrees those
   threads belong to. Two phases rather than close-then-sweep per thread: a
   subtree usually shares one worktree, and sweeping it while a parent's
   terminal is still open would kill that terminal's processes from underneath
   it. Deepest-first still governs the closing.
4. Only worktrees are swept (`environment.isWorktree`). A project checkout
   gets its terminals closed and nothing else: it is where the user works too,
   and their shells, editor and own dev server cannot be told apart from what
   an agent left behind.
5. A worktree where any thread is mid-turn — the settled tree's own threads
   included — is skipped and reported as in use. Mid-turn means bb's thread
   is active, starting, stopping or provisioning, or has background agents
   running. Killing under a live agent breaks work the user has not finished
   with, and the server decides this from a fresh read just before the kill,
   whatever the sidebar thought when it allowed the settle.
6. The sweep runs on the machine that holds the worktree: the server calls the
   plugin's host entry with `hostId` taken from the environment. A worktree
   with no machine on record is reported unreachable. A call that runs past
   60s is abandoned and reported as timed out — not "nothing stopped", since
   the kill may already have run. The host
   entry uses bb's `experimental_killProcessesWithCwdUnder`, which matches a
   process by its working directory, resolves a symlinked parent, and is
   boundary-safe, so a sibling worktree whose path merely starts the same way
   is never matched. SIGTERM first, SIGKILL for what survives a 2s grace.
7. The host refuses a directory that is the filesystem root, the user's home,
   or anything above it, whatever the server sends.

Reaping is best-effort per thread. A subtree bb will not enumerate falls back to
reaping the one thread that was settled; a terminal that will not close, or a
process that will not die, is reported and skipped. The settle is the user's
decision and must not fail because cleanup did. An undone settle stops the
reap before its next destructive step, including right before the host call;
unloading the plugin aborts a reap in flight, host call included.

The auto-archive sweep judges each candidate twice: once from the list it
starts with, and again from a fresh read after the reap and immediately before
the archive. Work anywhere in the archive tree blocks it.

## What it deliberately does not do
No guard for an idle sibling. A worktree shared with an unsettled thread that
is not mid-turn loses that thread's dev server too, because an orphan offers
nothing to distinguish it by. This is a chosen trade: a guard on unsettled
siblings would have spared every one of the five processes that caused the
problem. Restarting a dev server is cheap; a machine at load 8 for four hours
is not.

No deferred retry for an unreachable machine. The reap reports "machine
unreachable, nothing stopped" and moves on: by the time the machine is back,
the worktree may hold new work, and a kill queued now would land on it.

No command-line matching. A process whose working directory cannot be read
belongs to another user and could not be killed anyway.

## Surfaces
- Setting `reapOnSettle`, default on. Off leaves every process running.
- The `reaped` message on the lifecycle channel names what was closed and
  killed, and which worktrees were skipped and why. Failures stay counts:
  what failed is in the log, and a user can do nothing with the identity of a
  terminal bb could not close. Process names come from the host's process
  table, read just before the kill.
- The auto-archive sweep reaps too, on the same rule, and folds the result
  into its own report.

## Boundaries
- `bb.terminals` is the host's; the plugin only lists and closes.
- The server decides what to sweep and where; the host entry only kills under
  the directory it is handed, after refusing one too wide to be a worktree.
- The rules are pure functions in `src/reap.ts`, testable without a daemon;
  `src/host.ts` wires them to the machine.
- Lifecycle rules stay in `lifecycle.ts` as pure functions. Reaping is an
  effect the server performs after the shelf decision, never a new shelf.
