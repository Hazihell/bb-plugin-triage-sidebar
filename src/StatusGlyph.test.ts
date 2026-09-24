import { describe, expect, it } from "vitest";
import { composeIndicator } from "./StatusGlyph";

describe("composeIndicator", () => {
  it("passes the host's indicator through without a draft", () => {
    expect(composeIndicator("unread-success", false, false)).toBe(
      "unread-success",
    );
    expect(composeIndicator("none", false, false)).toBe("none");
  });

  it("keeps attention ahead of a draft", () => {
    expect(composeIndicator("unread-error", true, true)).toBe("unread-error");
    expect(composeIndicator("waiting-for-input", true, true)).toBe(
      "waiting-for-input",
    );
  });

  it("turns live work with a draft into the working draft", () => {
    expect(composeIndicator("runtime", true, true)).toBe("working-draft");
    expect(composeIndicator("plan-mode", true, true)).toBe("working-draft");
  });

  // bb ranks a plain draft last: an unread result or a queued message says
  // more about the thread than the fact that you started typing.
  it("shows a quiet draft only when nothing else is reported", () => {
    expect(composeIndicator("none", true, false)).toBe("draft");
    expect(composeIndicator("unread-success", true, false)).toBe(
      "unread-success",
    );
    expect(composeIndicator("queued-waiting", true, false)).toBe(
      "queued-waiting",
    );
    expect(composeIndicator("queued-failed", true, false)).toBe(
      "queued-failed",
    );
  });
});
