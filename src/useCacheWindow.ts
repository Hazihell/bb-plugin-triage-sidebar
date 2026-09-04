import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { triageSidebarRpcContract } from "./server";
import {
  cacheWindowFromMinutes,
  DEFAULT_CACHE_WINDOW,
  type CacheWindow,
} from "./cache-window";

/**
 * The two cache thresholds, read from the backend once.
 *
 * bb keeps a plugin's settings on the server and renders their form itself, so
 * a component has no way to read one except by asking. Once, and not on a
 * timer: these are numbers a user types every few months, and the sidebar
 * reloads with the window whenever it mounts.
 *
 * A failed read leaves the defaults in place rather than taking the slot down.
 * The worst case is an age that turns amber ten minutes early or late.
 */
export function useCacheWindow(): CacheWindow {
  const rpc = useRpc<typeof triageSidebarRpcContract>();
  const [window, setWindow] = useState<CacheWindow>(DEFAULT_CACHE_WINDOW);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const values = await rpc.call("getSettings", {});
        if (cancelled) return;
        setWindow(
          cacheWindowFromMinutes(
            values.cacheWarnAfterMinutes,
            values.cacheColdAfterMinutes,
          ),
        );
      } catch {
        // Keep the defaults.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  return window;
}
