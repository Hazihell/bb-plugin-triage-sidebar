# Triage Sidebar

An inbox-style replacement for bb's sidebar thread list, built around triage:
the threads that need you rise to the top, and the ones you are done with
fade out on their own.

Install it from a local checkout:

```sh
bb plugin install . --yes
```

Turn it on in **Settings > Appearance > Sidebar**. bb's own list stays the
default, and comes back the moment you switch away or disable this plugin.

The plugin replaces the scrolling list only. bb's New-thread button, search
field, plugin nav rows, and footer stay exactly where they are.

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

## The idea

The list re-orders itself. Threads sort by the most recent thing that needed
you, so what you should look at next is what is on top, and a thread waiting
for an answer beats every timestamp. Status still lives inside each card as
well: the position says what to look at, the card says why.

Movement that the user cannot follow would be worse than no ranking at all, so
two rules govern it. The list freezes its order while your pointer is over it
or a row inside it holds keyboard focus — no row may slide out from under a
cursor on its way to a click, and none may move a focused row somewhere else.
Threads that arrive during a freeze are slotted into the order you are looking
at rather than re-sorting it. And when the list does re-sort, each moved row is
animated from where it was to where it now belongs, so you see a thread travel
instead of a different list. A reduced-motion preference turns the animation
off; the ordering is unchanged.

Three shelves:

- **Inbox** — three-line cards: the project's avatar and name, then one
  fixed-width status slot, on the first line; title on the second; then branch
  (or the machine, when a thread has no worktree), activity counts, the
  pull-request number, and the agent glyph. Pinned threads sit above.

  One slot, one width, so the whole column lines up. The slot shows the status
  glyph while a thread has something to say, and the age ("now", "7m") once it
  does not — with one exception: a running thread shows its spinner and a live
  seconds timer side by side, because "how long has this been going" is the
  question a glyph alone cannot answer. The slot is wide enough for that pair,
  which is why it is wider than any single label. Hovering a card that can be
  parked replaces the status with a snooze and a settle button; only the status
  yields, so the project name never shifts.

  The glyphs are bb's own: the red circle-x for a failure, the circle-question
  for a raised hand, the spinner for live work, and a blue notification dot for
  a thread that finished while you were not looking. Both lists sit in the same
  window, so they speak one language.

- **Snoozed** — hidden until a wake time you chose. A snoozed thread comes
  back early if it starts working or asks you something.
- **Settled** — work you are done with, collapsed to one line each.

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

The parent chip sits on the left of the children chip, so the header reads up
then down. A child that has children of its own shows both. Each disc takes
its colour from the thread id, so the same thread keeps one colour in the list
and in both chips.

An orphan — a child whose parent is deleted — stays in the list, and its
header shows no parent chip.

## What it demonstrates

| Plugin API                                         | Used for                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `experimental_threadList`                          | the sidebar's scrolling list (bb keeps the New-thread button, search, nav rows, and footer) |
| `experimental_threadHeaderAction`                  | the two header chips: children on a parent, and the way back on a child                     |
| `experimental_useSidebarThreads`                   | live threads and projects, from the host's own cache                                        |
| `experimental_useSidebarThreadActions`             | open, open-in-split, new thread                                                             |
| `experimental_useSidebarThreadSplit`               | dragging a card out to a split pane                                                         |
| `experimental_useSidebarThreadPullRequest`         | the `#412` badge, coloured by bb's attention state                                          |
| `@radix-ui/react-context-menu` (shimmed)           | this plugin's own right-click menu, built on the action hook                                |
| `settingsSection`                                  | the per-project avatar editor (the only place an avatar is set)                             |
| `bb.settings.define`                               | auto-archive, and the switch behind each automatic avatar source                            |
| `bb.background.schedule`                           | the auto-archive pass (hourly ticker, user-set interval) and the avatar sweep                                           |
| `bb.storage.database()` + `bb.rpc` + `bb.realtime` | the settled/snoozed store, and the project-avatar store behind it                            |

The plugin API ships **no components**. Status glyphs and the right-click menu
are both this plugin's own: `indicator` arrives as data, and every menu item is
one call on `experimental_useSidebarThreadActions`. Choosing them is the point
of a replaced sidebar. Deletion still routes through `requestDelete`, so BB
shows its confirmation dialog rather than a plugin deleting a subtree silently.
The small icon and select components also live in this example. The example
does not import BB's private shared UI package.

## Where the lifecycle lives

Settled and snoozed state is in **this plugin's** SQLite database, never on
bb's thread. Putting it on the thread would mean a schema change, a wire
change, and a `HOST_DAEMON_PROTOCOL_VERSION` bump for a concept only this
sidebar understands. Uninstalling the plugin takes its state with it.

One rule matters more than the rest: **a thread that is working can never be
parked.** bb has more kinds of live work than a session status — workflows,
background agents, background commands, plan mode, goals — and every one of
them blocks parking and wakes a parked thread. Hiding running work is the one
failure this feature cannot afford. See `canPark` in `src/lifecycle.ts`.
