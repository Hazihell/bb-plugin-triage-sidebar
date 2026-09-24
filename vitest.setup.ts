import { afterEach } from "vitest";

// The sidebar keeps last session's state in localStorage so its first frame
// is the real list. jsdom's storage lives as long as the test file, so one
// test's snapshot would seed the next test's first frame; every test starts
// from a first launch instead.
afterEach(() => {
  if (typeof localStorage !== "undefined") localStorage.clear();
});
