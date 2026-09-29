// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const openUrl = vi.fn((_url: string) => true);
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useBbNavigate: () => ({ openUrl }),
}));

const { PortPills, PORT_PILL_TITLE } = await import("./PortPills");

const windowOpen = vi.fn();
beforeEach(() => {
  openUrl.mockClear();
  openUrl.mockReturnValue(true);
  windowOpen.mockClear();
  vi.stubGlobal("open", windowOpen);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A stand-in for the row's full-bleed link, which must not see the click. */
function Row({ ports, onRow }: { ports: number[]; onRow: () => void }) {
  return (
    <div onClick={onRow}>
      <PortPills ports={ports} />
    </div>
  );
}

describe("PortPills", () => {
  it("renders nothing when nothing listens", () => {
    const { container } = render(<PortPills ports={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows three pills and folds the rest behind +N", () => {
    render(<PortPills ports={[3000, 5173, 8080, 9000, 1234]} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      ":3000",
      ":5173",
      ":8080",
    ]);
    expect(screen.getByText("+2").getAttribute("title")).toBe(":9000 :1234");
    expect(screen.getByText(":3000").getAttribute("title")).toBe(PORT_PILL_TITLE);
  });

  it("opens a plain click in bb's browser, without selecting the row", () => {
    const onRow = vi.fn();
    render(<Row ports={[3000]} onRow={onRow} />);
    const event = fireEvent.click(screen.getByText(":3000"));
    expect(event).toBe(false); // default prevented
    expect(openUrl).toHaveBeenCalledWith("http://localhost:3000");
    expect(windowOpen).not.toHaveBeenCalled();
    expect(onRow).not.toHaveBeenCalled();
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])(
    "opens a modified click (%o) in the default browser",
    (modifier) => {
      const onRow = vi.fn();
      render(<Row ports={[5173]} onRow={onRow} />);
      fireEvent.click(screen.getByText(":5173"), modifier);
      expect(windowOpen).toHaveBeenCalledWith(
        "http://localhost:5173",
        "_blank",
        "noopener,noreferrer",
      );
      expect(openUrl).not.toHaveBeenCalled();
      expect(onRow).not.toHaveBeenCalled();
    },
  );

  it("falls back to the default browser when bb declines the URL", () => {
    openUrl.mockReturnValue(false);
    render(<PortPills ports={[3000]} />);
    fireEvent.click(screen.getByText(":3000"));
    expect(windowOpen).toHaveBeenCalledWith(
      "http://localhost:3000",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
