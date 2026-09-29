# Triage Sidebar

An inbox-style replacement for bb's sidebar thread list, built around triage:
the threads that need you rise to the top, and the ones you are done with
fade out on their own. Each card also shows the ports its worktree is serving
and runs the commands you saved for its project.

<img src="https://github.com/user-attachments/assets/6906f1b5-7469-46b0-bfeb-977d813be030" alt="The Triage Sidebar inbox, with a hovered card showing Snooze and Settle" width="560">

It needs bb 0.43.4 or later, and is built against plugin SDK 0.5.9. Install it
from the Community marketplace on bb's Plugins page, or from a local checkout:

```sh
bb plugin install . --yes
```

Turn it on in **Settings > Appearance > Sidebar**. bb's own list stays the
default, and comes back the moment you switch away or disable this plugin.

The plugin replaces the scrolling list only. bb's New-thread button, its
search (the quick palette), plugin nav rows, and footer stay exactly where they
are. The list has no search of its own, and filters nothing by text.

## Where this came from

This is a fork of [T3 Sidebar](https://github.com/SawyerHood/bb-plugin-t3sidebar)
by Sawyer Hood, MIT licensed, which started as an example in the BB
repository. The original's design goal is a list that never re-orders. This
fork deliberately takes the opposite position on that point, and diverges
further from there.

## What this fork changes

- **Attention floats up.** Threads that failed, raised a hand, or just finished
  a turn move to the top instead of holding their creation-time place, and a
  thread with a question already on screen outranks all of them.
- **More color.** Status is readable at a glance from across the room: blue is
  the machine working, green a finished turn, red a failure, amber the one
  state waiting on you. Everything else stays neutral, so the four hues that
  mean something keep meaning it.
- **Settled decays into archived.** A settled thread that stays untouched long
  enough is archived automatically, so the shelf does not grow forever. Both
  the switch and the number of days are settings.
- **Pinning.** Threads you pinned in bb sit in their own shelf at the top, and
  stay there whatever the attention sort says.
- **A square per project.** Each card opens with a small coloured chip, so the
  eye can group the column into projects before it reads a word of it.
- **Ports on the card.** A plug icon counts the ports a thread's worktree is
  serving; its card opens each one in bb's browser or yours, or stops it.
- **Project commands.** Commands you save per project — a dev server, a test
  run — start and stop from the thread's row or header, in a bb terminal.

## The idea

The list re-orders itself. Threads sort by the most recent thing that needed
you, so what you should look at next is what is on top, and a thread waiting
for an answer beats every timestamp. Status still lives inside each card as
well: the position says what to look at, the card says why.

Movement that the user cannot follow would be worse than no ranking at all, so
two rules govern it. The list freezes its order while your pointer is over it,
a row holds keyboard focus, or a menu opened from a row is still open — no row
may slide out from under a cursor on its way to a click. During a freeze a row
that leaves the shelf — settled or archived, by you, another window or the
sweep — leaves at once and the rows below close the gap, and a thread that
arrives (a snooze that woke, a new thread) waits at the end of its shelf. When the freeze lifts, a
moment after the pointer leaves, each row that changed rank slides once, over
150ms, from where it was to where it now belongs, so you see a thread travel
instead of a different list. Data arriving never slides anything: not the
first load, not a snapshot being replaced by live data, not a project switch.
A reduced-motion preference makes every move instant; the ordering is
unchanged.

Three shelves:

- **Inbox** — three-line cards: the project's avatar and name, then the
  status slot, on the first line; title on the second; then branch (or the
  machine, when a thread has no worktree), activity counts, the pull-request
  number, and the agent's glyph. Pinned threads sit above.

  The status slot is one fixed width on every row, with a glyph column and a
  time column, so both line up down the list. **The time is always shown;
  nothing ever takes its place.** While the agent is inside a turn — bb's
  status says it is starting, active or stopping — it counts that turn's
  seconds. Otherwise it is the idle age: how long since the last turn ended.
  Background work is not a turn: a thread whose dev server, workflow, plan or
  goal is still running keeps its idle age, with that work's glyph beside it.
  A thread that has never finished a turn shows the time since bb last saw
  activity on it, dimmed and never amber, because it is not a cache clock. A
  turn counts from the moment this window saw it start until the server has
  read its logged start from bb, then steps forward to that; the logged time is
  never later.

  While you hold the command key, bb's jump key for the row sits just left of
  the slot. On hover or keyboard focus, the row's actions take the slot's
  place at the right edge: a card that can be parked shows **Snooze**, which
  opens a menu of presets, and **Settle**. A phone or tablet, which has no
  hover, never draws them, nor a parked row's restore button: the slot's glyph
  and time stay, and long-press opens the row menu instead.

  The glyphs are bb's own, so the two lists speak one language: the red
  circle-x for a failure or a message that failed to send, the amber
  circle-question for a raised hand, the spinner for a running turn (or a
  running child), a clock for a message queued behind the turn, and a green
  dot for a result you have not read. Background work shimmers in its own
  glyph: a terminal, an added agent, a workflow, a checklist for plan mode, a
  target for a goal. A pencil marks an unsent draft, drawn in the working
  colour when something is running. A status another plugin set on the row
  shows too, by bb's rule: over anything except a running turn, a failure or
  a question.

- **Snoozed** — hidden until a wake time you chose: in an hour, this evening
  (6pm, offered until 5pm), tomorrow at 9am, or next Monday at 9am.
  A snoozed thread comes back early if it starts working or asks you
  something. Its one-line row keeps the card's glyph and time, with the wake
  countdown beside them.
- **Settled** — work you are done with, collapsed to one line each. See
  below for what settling stops.

Right-click (or long-press, on touch) any row for the same park actions and
bb's own: open in split, mark read, pin, archive, delete. Delete goes through
bb's confirmation. On a phone this menu is the only place to settle, snooze or
wake a thread. As in bb's own list, a held finger may drift a little without
losing the press.

## First paint

The sidebar's first frame is the list you last saw, not a list that re-sorts
a second later. The parking rows of threads still in the list (up to 500), the
project avatars and the cache thresholds are kept in this browser's
localStorage, saved a second after they change and when the page is hidden,
and read before the first render; the server's answer replaces them a moment
later and only what really changed moves, without sliding. Every saved field
is checked before it is used, and a snapshot with one bad row, or from a
build with a different row shape, is ignored. On a first launch there is no
snapshot, and the list shows a still placeholder until the store answers —
never the threads unshelved. Avatar images in the snapshot are capped at
about 512 KB, smallest first; if storage is full, the snapshot is dropped
rather than left stale.

If the store cannot be read at all, the list says why and offers Retry. If a
later refresh fails, the list stays and one line says the shelves may be out
of date.

## Cache window

The idle age is not trivia about when you last spoke to a thread. An agent's
prompt cache lapses on a timer, so the age is what says whether your next
message resumes a cached conversation or pays to rebuild one. It is therefore
read from bb's own event log: the idle age runs from the newest
`turn/completed`, which lands in the same millisecond as the turn's last API
response, and a running turn's timer from the newest `turn/started`. The
server reads them when a thread goes active, idle or failed, and once more for
every live thread shortly after it loads, so an event missed while the plugin
was stopped heals itself. bb's `updatedAt` is never used: it also moves for a
rename, a pin or a read.

Two settings mark the band. Past **Minutes before an idle thread's age turns
amber** (50 by default) the age is drawn in the same amber the raised-hand
glyph uses. Past **Minutes after which the cache window is gone** (60) it goes
quiet again: the window has already lapsed, and a warning about a decision
there is nothing left to make is noise on every stale row. The colour is only
ever on an idle age — a turn in flight is not yet a question about caching.

## Project avatars

Every card opens with a small rounded square for its project. It is not there
to repeat the project's name, which is written right beside it — it is there so
the eye can sort the column into projects before reading any of it. A rounded
square rather than a circle, because a circle is the web's shorthand for a
person and a project is a thing.

Four sources, in this order:

1. **An avatar you set** — an image, an emoji, or a monogram with a colour you
   picked, in **Settings > Project avatars**. That is the only place an avatar
   is set, and your choice always wins: a later background fetch never undoes
   it. An image given as an address is downloaded once, by the plugin's
   backend rather than by the browser, and stored — so it does not depend on
   that server answering again, or on it allowing a cross-origin read.
2. **The project's own icon**, read out of its folder on this machine —
   `favicon.svg`, `apple-touch-icon.png` and the like, from the few directories
   web frameworks actually serve static files from. This makes no network
   request of any kind.
3. **The git host's image** — the owner's avatar from github.com, gitlab.com or
   your own server. This is an outbound request from this machine, and a
   private or self-hosted host will usually refuse it. Fetched once and then
   kept: a nightly sweep only looks at projects that still have no image, a
   host that refuses is retried on a widening backoff, and **Refresh from git
   host** in Settings asks again for one project on demand.
4. **A generated monogram** — one or two letters on a colour derived from the
   project's id, not its name, so renaming a project does not repaint the
   sidebar. One fixed lightness and chroma, chosen by sweeping all 360 hues, so
   every hue stays inside sRGB and white text clears 4.5:1 on the worst of
   them.

The project's own icon outranks the git host's on purpose: a favicon identifies
the project, while a host avatar belongs to the org that owns the repository,
so every project under one organization would otherwise wear the same face.

Two settings govern the two automatic sources, and each can be turned off on
its own:

| Setting                                          | What it does                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| **Fetch project avatars from the git host**      | Allows the outbound request in step 3. Off means no such request at all.                                  |
| **Use a project's own icon from its folder**     | Allows step 2, reading a file inside a folder you already opened in bb. Turning it off forgets what it cached. |

Avatars you set yourself keep working with both switched off.

## Child threads live in the header

A flat inbox has nowhere to nest a child thread, so the list hides a child
while its parent is on screen. Two chips in the thread header carry that
relation instead:

- On a parent: a chip with one coloured disc per child. It opens the list of
  children.
- On a child: a chip that names the parent and opens it. Without it the child
  is a dead end, because it is not in the list.

Hiding the children leaves the parent's card looking idle while its subagents
work, so the card carries the relation too. A parent whose child is running
spins in its status slot — beside its own idle age, because a child's clock is
not the parent's and this sidebar keeps none — and its third line counts the
children that are running and the ones that are waiting on an answer, each only
when there are any. Child work counts as the parent's own everywhere it
matters: the parent floats up the list, cannot be settled or snoozed, and the
auto-archive sweep leaves it alone.

The parent chip sits on the left of the children chip, so the header reads up
then down. A child that has children of its own shows both. Each disc takes
its colour from the thread id, so the same thread keeps one colour in the list
and in both chips.

An orphan — a child whose parent is deleted — stays in the list, and its
header shows no parent chip.

## Ports

A card whose worktree is serving something shows a plug icon with a count,
beside the agent's glyph. Hovering it opens a card with one line per port: the
port, the pid, and the process behind it with its arguments, so the app can be
told from the storybook before either is opened. The card stays open while the
pointer is inside it; a click pins it open until dismissed.

<img src="https://github.com/user-attachments/assets/e82e3696-2004-44e3-84c0-691c4746e26c" alt="The ports card for a thread serving four ports, each with Open in BB, Open in browser and stop" width="560">

- **Open in BB** opens the port in a bb browser tab on that thread, and brings
  the thread forward so its side panel shows the tab.
- **Open in browser** opens it in your default browser. A plain click on the
  port does the first, a ⌘- or Ctrl-click the second.
- **Stop** asks once, and kills on a second click within three seconds.

A port belongs to a thread by the process's working directory: a server
started in a worktree works in that worktree. One `lsof` pass on the machine
holding the worktree lists every listener, and each is credited to the deepest
thread directory it sits under, so a worktree nested in a project checkout
keeps its own ports. The list refreshes every 10 seconds while the sidebar is
on screen. `lsof` makes this macOS and Linux only; a machine that does not
answer within 10 seconds is left out of that refresh.

Stopping never trusts the pid on screen, which may be seconds old. The server
looks the thread's machine and directory up in bb, and that machine scans
again and signals only if the same pid is still listening on the same port
under the same directory. It sends SIGTERM, then SIGKILL after three seconds.
Anything that changed refreshes the card instead.

## Project commands

Each project can keep up to 12 commands — `pnpm dev`, `npm test`, a seed
script — edited in **Settings > Project commands**. One can be marked the dev
server.

<img src="https://github.com/user-attachments/assets/74f92121-237e-4853-9ee2-7c5195b5ecd9" alt="The project commands menu on a thread row, with a saved dev command" width="560">

- **On the row**, a terminal icon beside the plug opens a menu to run or stop
  each command, and to edit the project's list. It shows on hover or keyboard
  focus, and stays visible, with a dot, while one of the project's commands
  runs in that thread. It is drawn for a project with no commands too, so the
  first can be added from there.
- **In the thread header**, the dev server is a play button, with the other
  commands in a menu beside it. A project with no commands shows nothing.

A command runs in a bb terminal on the thread, titled with the command's name,
and a running command offers Stop instead of Run, so one click never starts a
second copy. The frontend never sends a shell string: it sends a thread and a
command id, and the server reads the project from bb and the command from its
own table. The only way to make the plugin run a string is to save it in
Settings. Renaming a command while it runs loses track of its terminal, which
can still be closed from bb's terminal panel.

## What it demonstrates

| Plugin API                                               | Used for                                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `experimental_threadList`                                | the sidebar's scrolling list (bb keeps New thread, search, nav rows, footer)     |
| `experimental_threadHeaderAction`                        | the header chips: children, the way back to a parent, and the Run button         |
| `experimental_useSidebarThreads`                         | live threads and projects, from the host's own cache                             |
| `experimental_useSidebarThreadActions`                   | open, open-in-split, read, pin, archive, delete                                  |
| `useSidebarThreadDraft`, `…RowStatus`, `…Shortcut`       | the draft pencil, other plugins' row statuses, and the jump-key pill             |
| `experimental_useSidebarThreadSplit`                     | dragging a card out to a split pane                                              |
| `experimental_useSidebarThreadPullRequest`               | the `#412` badge, coloured by bb's attention state                               |
| `experimental_ProviderIcon`, `experimental_useProviders` | the agent's glyph and name, from bb's provider directory                         |
| host-shimmed Radix menus, vendored from bb's registry    | the right-click menu, the snooze presets, and the children menu                  |
| `settingsSection`                                        | the avatar editor, the project commands editor, and the auto-archive report      |
| `bb.settings.define`                                     | auto-archive, reaping, the cache window, and each automatic avatar source        |
| `bb.background.schedule`                                 | the auto-archive pass (hourly ticker, user-set interval) and the avatar sweep    |
| `bb.sdk.threads.events.list`                             | turn timing from bb's event log                                                  |
| `experimental_defineHostEntry`                           | scanning ports, stopping a port's process, and reaping a settled worktree        |
| `sdk.experimental_desktopBrowsers`                       | opening a port in a bb browser tab owned by its thread                           |
| `bb.sdk.terminals`                                       | running, finding and stopping a project command's terminal                       |
| `bb.storage.database()` + `bb.rpc` + `bb.realtime`       | the parking store, pushed to every window as numbered row changes                |

The plugin API ships **no components**. Status glyphs and the menus are this
plugin's own: `indicator` arrives as data, and every menu item is one call on
`experimental_useSidebarThreadActions`. The menus are bb's own shadcn source
(context-menu and dropdown-menu from bb's registry, trimmed), over the Radix
packages the host shims, portaled with the plugin's style scope so they flip
at screen edges, close on Escape and move by keyboard. Deletion routes through
`requestDelete`, so bb shows its confirmation rather than a plugin deleting a
subtree silently.

## Where the lifecycle lives

Settled and snoozed state is in **this plugin's** SQLite database, never on
bb's thread. Putting it on the thread would mean a schema change, a wire
change, and a `HOST_DAEMON_PROTOCOL_VERSION` bump for a concept only this
sidebar understands. Uninstalling the plugin takes its state with it. Parking
applies on screen at once; if the server refuses, it is taken back and a toast
says why.

One rule matters more than the rest: **a thread that is working can never be
parked.** bb has more kinds of live work than a running turn — workflows,
background agents, plan mode, goals — and every one of them, on the thread or
on any thread below it, blocks parking and wakes a parked thread. Hiding
running work is the one failure this feature cannot afford. See `canPark` in
`src/lifecycle.ts`.

Background commands are the exception. A dev server or watcher the agent left
running after its turn is exactly what settling stops, so it never blocks
Settle or Snooze and never pulls a parked thread back; the terminal glyph
stays beside the time.

When settling's cleanup stops that command, Claude Code answers with a turn
of its own. The thread shows in the inbox while that turn runs, and goes back
to its shelf when it ends, whatever the agent wrote or did along the way, as
long as the turn leaves nothing running: no background command (a restarted
dev server brings the thread back, since nothing would stop it again), no
background agent, workflow, plan or goal, and no question for you. Only a
command that ended during the cleanup, or within 10 seconds after it, counts
as stopped by it. A command that finishes by itself later, and the agent
reporting on it, brings the thread back.

The auto-archive sweep is stricter: it leaves a settled thread whose command
still runs where it is, and archives it once the command is gone.

## What settling stops

Settling says the work is done, so by default (**Stop leftover terminals and
processes when a thread settles**) the processes it started stop too. The
settle is answered at once; the cleanup runs after it, and the window that
settled gets a toast naming what it stopped or left running. In short:

- **Archive-tree scope.** It covers what bb's archive would take: the thread,
  its children, threads whose lifetime it owns, and hidden threads spun off
  from it, deepest first. It closes their live terminals.
- **Worktree-only sweep.** Leftover processes are killed only under a
  worktree. A project checkout is where you work too, so it gets its
  terminals closed and nothing else.
- **Live-turn guard.** A worktree where any thread is mid-turn is left alone,
  judged from a fresh read of bb just before the kill.
- **Per-machine cleanup.** The kill runs on the machine that holds the
  worktree, through the plugin's host entry, which refuses the filesystem
  root, your home folder, or anything above it. An unreachable machine is
  reported, and nothing is queued for later.

Undoing a settle stops the cleanup before its next step. The auto-archive
sweep reaps by the same rules and checks for live work again right before it
archives. The full rules and their trade-offs are in
[SPEC-reap-on-settle.md](SPEC-reap-on-settle.md).

## Known limitation

On launch bb may briefly show its own thread list before it loads your
sidebar choice, then swap to this one. That is bb reading the preference late,
not this plugin; once this list mounts, its first frame is the real list.
