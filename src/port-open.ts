/**
 * Where a port opens: bb's own browser, or the operating system's.
 *
 * `openUrl` cannot choose. It follows bb's link preference, and only a thread
 * view carries an in-app browser to route to — from the sidebar it always
 * lands in the default browser. So "in bb" goes through the desktop-browser
 * API instead: a tab created in the one bb window, owned by the thread whose
 * worktree is serving the port, and revealed there. bb shows a thread's tabs
 * in that thread's side panel, so the thread is brought forward first.
 */
import type { BbNavigate, PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

export type PortOpenTarget = "bb" | "system";

export function portUrl(port: number): string {
  return `http://localhost:${port}`;
}

/** A plain click opens in bb; ⌘- or Ctrl-click in the default browser. */
export function clickTarget(event: { metaKey: boolean; ctrlKey: boolean }): PortOpenTarget {
  return event.metaKey || event.ctrlKey ? "system" : "bb";
}

/**
 * The operating system's default browser. From the sidebar `openUrl` has no
 * in-app browser to use, so bb hands the URL to the OS; a surface where it
 * declines the URL falls back to a plain new window.
 */
export function openInSystemBrowser(navigate: Pick<BbNavigate, "openUrl">, url: string): void {
  if (!navigate.openUrl(url)) window.open(url, "_blank", "noopener,noreferrer");
}

export interface OpenInBbArgs {
  sdk: Pick<PluginBrowserBbSdk, "hosts" | "experimental_desktopBrowsers">;
  navigate: Pick<BbNavigate, "openUrl" | "toThread">;
  threadId: string;
  url: string;
  warn?: (message: string) => void;
}

/**
 * A new tab in bb's browser, owned by `threadId`. Where it went: "bb", or
 * "system" when there is no single bb window to put it in — a web client
 * has none, and with several there is no telling which one the user is
 * looking at — or the desktop refused.
 */
export async function openInBb({
  sdk,
  navigate,
  threadId,
  url,
  warn = console.warn,
}: OpenInBbArgs): Promise<PortOpenTarget> {
  const browsers = sdk.experimental_desktopBrowsers;
  try {
    const hosts = await sdk.hosts.list();
    const windows = (
      await Promise.all(
        hosts
          .filter((host) => host.status === "connected")
          .map((host) =>
            browsers.listInstances({ hostId: host.id }).then(
              ({ instances }) => instances,
              () => [],
            ),
          ),
      )
    ).flat();
    if (windows.length === 1) {
      const { hostId, instanceId, generation } = windows[0]!;
      // The desktop reveals a tab only in the thread on screen.
      navigate.toThread(threadId);
      const scope = { hostId, instanceId, generation, threadId };
      const { tab } = await browsers.createTab({ ...scope, url, presentation: "reveal" });
      // Again once the new tab exists, in case the navigation landed after
      // the desktop checked which thread was on screen.
      await browsers.revealTab({ ...scope, tabId: tab.tabId }).catch(() => undefined);
      return "bb";
    }
    warn(`ports: ${windows.length} bb windows, opening ${url} in the default browser`);
  } catch (error) {
    warn(`ports: could not open ${url} in bb (${String(error)})`);
  }
  openInSystemBrowser(navigate, url);
  return "system";
}
