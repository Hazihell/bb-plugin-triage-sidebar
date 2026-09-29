// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PortListing } from "./host-contract";

const openUrl = vi.fn((_url: string) => true);
const toThread = vi.fn((_threadId: string) => {});
const listHosts = vi.fn(async () => [{ id: "host_mac", status: "connected" }]);
const listInstances = vi.fn(async (_input: { hostId: string }) => ({
  instances: [{ hostId: "host_mac", instanceId: "win_1", generation: "gen_1" }],
}));
const createTab = vi.fn(async (_input: Record<string, unknown>) => ({ tab: { tabId: "tab_1" } }));
const revealTab = vi.fn(async (_input: Record<string, unknown>) => ({ ok: true }));
const rpcCall = vi.fn(
  async (_method: string, _input: Record<string, unknown>): Promise<unknown> => ({
    result: "killed",
    message: null,
  }),
);
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useBbNavigate: () => ({ openUrl, toThread }),
  useRpc: () => ({ call: rpcCall }),
  useSdk: () => ({
    hosts: { list: listHosts },
    experimental_desktopBrowsers: { listInstances, createTab, revealTab },
  }),
}));

const { PortsMenu, PORTS_CLOSE_DELAY_MS, PORT_ROW_TITLE, STOP_CONFIRM_MS } = await import(
  "./PortsMenu"
);
const { PortsRefreshContext } = await import("./usePorts");
const refreshPorts = vi.fn(() => {});

const LISTING: PortListing = {
  ports: [
    { port: 3000, pid: 4101, command: "node · vite --port 3000" },
    { port: 6006, pid: 4102, command: "node · storybook dev" },
  ],
  more: 3,
};

beforeEach(() => {
  for (const mock of [openUrl, toThread, listHosts, listInstances, createTab, revealTab]) {
    mock.mockClear();
  }
  rpcCall.mockClear();
  refreshPorts.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A stand-in for the row's full-bleed link, which must not see the click. */
function Row({ onRow, listing = LISTING }: { onRow?: () => void; listing?: PortListing }) {
  return (
    <PortsRefreshContext.Provider value={refreshPorts}>
      <div onClick={onRow}>
        <PortsMenu threadId="thr_1" listing={listing} />
      </div>
    </PortsRefreshContext.Provider>
  );
}

const plug = () => screen.getByRole("button", { name: "5 listening ports" });
const card = () => screen.queryByRole("dialog");
const hover = (element: Element) => fireEvent.pointerOver(element, { pointerType: "mouse" });
const unhover = (element: Element) => fireEvent.pointerOut(element, { pointerType: "mouse" });

describe("PortsMenu", () => {
  it("renders nothing when nothing listens", () => {
    const { container } = render(
      <PortsMenu threadId="thr_1" listing={{ ports: [], more: 0 }} />,
    );
    expect(container.innerHTML).toBe("");
    render(<PortsMenu threadId="thr_1" listing={undefined} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is one plug icon counting every port, the capped ones included", () => {
    render(<Row />);
    expect(plug().textContent).toBe("5");
    expect(plug().querySelector('[data-icon="Plug"]')).not.toBeNull();
    expect(card()).toBeNull();
  });

  it("lists each port with its process and pid on hover, and the rest as plain text", async () => {
    render(<Row />);
    hover(plug());
    await waitFor(() => expect(card()).not.toBeNull());
    const text = card()!.textContent!;
    expect(text).toContain(":3000");
    expect(text).toContain("pid 4101");
    expect(text).toContain("node · vite --port 3000");
    expect(text).toContain(":6006");
    expect(text).toContain("node · storybook dev");
    expect(screen.getByText("+3 more").tagName).toBe("P");
    expect(screen.getByRole("button", { name: "Open localhost:3000" }).getAttribute("title")).toBe(
      PORT_ROW_TITLE,
    );
  });

  it("stays open while the pointer moves into the card, and closes after it leaves", async () => {
    render(<Row />);
    hover(plug());
    await waitFor(() => expect(card()).not.toBeNull());
    vi.useFakeTimers();
    unhover(plug());
    hover(card()!);
    act(() => vi.advanceTimersByTime(PORTS_CLOSE_DELAY_MS * 2));
    expect(card()).not.toBeNull();
    unhover(card()!);
    act(() => vi.advanceTimersByTime(PORTS_CLOSE_DELAY_MS * 2));
    expect(card()).toBeNull();
  });

  it("opens pinned on a click, without selecting the row", async () => {
    const onRow = vi.fn();
    render(<Row onRow={onRow} />);
    fireEvent.click(plug());
    await waitFor(() => expect(card()).not.toBeNull());
    expect(onRow).not.toHaveBeenCalled();
    vi.useFakeTimers();
    unhover(plug());
    act(() => vi.advanceTimersByTime(PORTS_CLOSE_DELAY_MS * 2));
    expect(card()).not.toBeNull();
    // Clicks inside the portalled card do not bubble to the row either.
    fireEvent.click(screen.getByText("+3 more"));
    expect(onRow).not.toHaveBeenCalled();
  });

  it("opens a row's plain click in a bb browser tab owned by the thread", async () => {
    render(<Row />);
    fireEvent.click(plug());
    await waitFor(() => expect(card()).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open localhost:3000" }));
    await waitFor(() => expect(createTab).toHaveBeenCalled());
    expect(toThread).toHaveBeenCalledWith("thr_1");
    expect(createTab).toHaveBeenCalledWith({
      hostId: "host_mac",
      instanceId: "win_1",
      generation: "gen_1",
      threadId: "thr_1",
      url: "http://localhost:3000",
      presentation: "reveal",
    });
    expect(openUrl).not.toHaveBeenCalled();
    expect(card()).toBeNull();
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])(
    "opens a row's modifier click (%o) in the default browser",
    async (modifier) => {
      render(<Row />);
      fireEvent.click(plug());
      await waitFor(() => expect(card()).not.toBeNull());
      fireEvent.click(screen.getByRole("button", { name: "Open localhost:6006" }), modifier);
      expect(openUrl).toHaveBeenCalledWith("http://localhost:6006");
      expect(listHosts).not.toHaveBeenCalled();
      expect(toThread).not.toHaveBeenCalled();
    },
  );

  it("has explicit actions for each target", async () => {
    render(<Row />);
    fireEvent.click(plug());
    await waitFor(() => expect(card()).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open localhost:6006 in browser" }));
    expect(openUrl).toHaveBeenCalledWith("http://localhost:6006");
    expect(createTab).not.toHaveBeenCalled();

    fireEvent.click(plug());
    await waitFor(() => expect(card()).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open localhost:3000 in BB" }));
    await waitFor(() =>
      expect(createTab).toHaveBeenCalledWith(
        expect.objectContaining({ url: "http://localhost:3000", threadId: "thr_1" }),
      ),
    );
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  describe("stop", () => {
    const stopButton = (port = 3000) =>
      screen.getByRole("button", { name: `Stop the process on localhost:${port}` });
    const confirmButton = (port = 3000, pid = 4101) =>
      screen.getByRole("button", { name: `Confirm stopping pid ${pid} on localhost:${port}` });

    async function openCard(onRow?: () => void) {
      render(<Row onRow={onRow} />);
      hover(plug());
      await waitFor(() => expect(card()).not.toBeNull());
    }

    it("asks first, keeps the command in view, and kills on the second click", async () => {
      const onRow = vi.fn();
      await openCard(onRow);
      fireEvent.click(stopButton());
      expect(rpcCall).not.toHaveBeenCalled();
      expect(confirmButton().textContent).toBe("Confirm stop?");
      expect(confirmButton().getAttribute("title")).toBe("node · vite --port 3000");
      expect(card()!.textContent).toContain("node · vite --port 3000");

      fireEvent.click(confirmButton());
      expect(
        screen.getByRole("button", { name: "Stopping the process on localhost:3000" }).textContent,
      ).toBe("Stopping…");
      await waitFor(() => expect(refreshPorts).toHaveBeenCalledTimes(1));
      expect(rpcCall).toHaveBeenCalledWith("stopPort", {
        threadId: "thr_1",
        port: 3000,
        pid: 4101,
      });
      expect(onRow).not.toHaveBeenCalled();
      expect(card()).not.toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("stands down when the second click does not come in time", async () => {
      await openCard();
      vi.useFakeTimers();
      fireEvent.click(stopButton());
      act(() => vi.advanceTimersByTime(STOP_CONFIRM_MS + 10));
      expect(stopButton()).not.toBeNull();
      fireEvent.click(stopButton());
      expect(rpcCall).not.toHaveBeenCalled();
    });

    it("keeps a card opened by hover open once a stop starts", async () => {
      await openCard();
      vi.useFakeTimers();
      fireEvent.click(stopButton());
      unhover(card()!);
      act(() => vi.advanceTimersByTime(PORTS_CLOSE_DELAY_MS * 2));
      expect(card()).not.toBeNull();
    });

    it("refreshes and says so when the port changed underneath", async () => {
      rpcCall.mockResolvedValueOnce({ result: "changed", message: null });
      await openCard();
      fireEvent.click(stopButton());
      fireEvent.click(confirmButton());
      await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/changed/));
      expect(refreshPorts).toHaveBeenCalledTimes(1);
      expect(stopButton()).not.toBeNull();
    });

    it("shows a refusal inline, and does not refresh for it", async () => {
      rpcCall.mockResolvedValueOnce({
        result: "refused",
        message: "Refused: the home directory or one above it",
      });
      await openCard();
      fireEvent.click(stopButton());
      fireEvent.click(confirmButton());
      await waitFor(() =>
        expect(screen.getByRole("status").textContent).toBe(
          "Refused: the home directory or one above it",
        ),
      );
      expect(refreshPorts).not.toHaveBeenCalled();
    });

    it("shows a failed call inline", async () => {
      rpcCall.mockRejectedValueOnce(new Error("offline"));
      await openCard();
      fireEvent.click(stopButton());
      fireEvent.click(confirmButton());
      await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/reach/));
    });
  });
});
