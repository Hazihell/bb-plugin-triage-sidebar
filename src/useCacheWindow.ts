import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { triageSidebarRpcContract } from "./server";
import {
  cacheWindowFromMinutes,
  DEFAULT_CACHE_WINDOW,
  type CacheWindow,
} from "./cache-window";
import { isRecord, readSnapshot, writeSnapshot } from "./local-snapshot";

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
  // Last session's thresholds first, so an age that was amber when the
  // sidebar closed is amber on its first frame too.
  const [window, setWindow] = useState<CacheWindow>(
    () => readSnapshot(SNAPSHOT_KEY, parseWindow) ?? DEFAULT_CACHE_WINDOW,
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const values = await rpc.call("getSettings", {});
        if (cancelled) return;
        const next = cacheWindowFromMinutes(
          values.cacheWarnAfterMinutes,
          values.cacheColdAfterMinutes,
        );
        setWindow(next);
        writeSnapshot(SNAPSHOT_KEY, next);
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

const SNAPSHOT_KEY = "cache-window:v1";

function parseWindow(value: unknown): CacheWindow | null {
  if (!isRecord(value)) return null;
  const { warnAfterMs, coldAfterMs } = value;
  if (typeof warnAfterMs !== "number" || typeof coldAfterMs !== "number") {
    return null;
  }
  return { warnAfterMs, coldAfterMs };
}
