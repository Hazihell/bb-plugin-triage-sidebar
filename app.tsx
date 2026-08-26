// bb-plugin-triage-sidebar — an inbox-style replacement for bb's sidebar thread
// list, and the reference example for `app.slots.experimental_threadList`.
//
// The idea it is built around: the list ranks by attention. A thread rises
// when something on it needed you — a question, a finished turn, a failure —
// and threads blocked on you come first, ahead of everything else. Pinned
// threads sit above all of it and never leave the top. Each card still carries
// its own status, so position tells you what to look at and the card tells you
// why.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ThreadInbox } from "./src/ThreadInbox";
import { ParentChip } from "./src/ParentChip";
import { SubagentsChip } from "./src/SubagentsChip";
import { ProjectAvatarSettings } from "./src/ProjectAvatarSettings";

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "inbox",
    title: "Triage Sidebar",
    description:
      "Cards ranked by what needed you last — blocked threads first, pinned on top.",
    component: ThreadInbox,
  });

  // Registered first, so it renders on the left of the children chip: the
  // header then reads up (parent) then down (children).
  //
  // The hidden child is otherwise a dead end — it is not in the list, so this
  // chip is its only route back to the parent.
  app.slots.experimental_threadHeaderAction({
    id: "parent",
    title: "Parent thread",
    component: ParentChip,
  });

  // A flat inbox has nowhere to nest child threads, so the list hides them
  // and this chip gives them a home on their parent's header.
  app.slots.experimental_threadHeaderAction({
    id: "children",
    title: "Child threads",
    component: SubagentsChip,
  });

  // Editing an avatar belongs here and nowhere else: it is per project, while
  // every entry in the sidebar's right-click menu is per thread, and it is a
  // decision made once rather than during triage.
  app.slots.settingsSection({
    id: "project-avatars",
    title: "Project avatars",
    description:
      "One square per project, so the eye can group the list before it reads it. Set one yourself, or leave it to the project's own icon, the git host's image, and a generated monogram.",
    component: ProjectAvatarSettings,
  });
});
