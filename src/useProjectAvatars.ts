import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  CustomProjectAvatar,
  StoredAvatarRow,
  triageSidebarRpcContract,
} from "./server";

export interface ProjectAvatarsApi {
  /**
   * What is stored per project id. A project with no entry has never been
   * customized and has no cached image — which is not a missing value, it is
   * the monogram, so callers pass `undefined` straight to `ProjectAvatar`.
   */
  rows: ReadonlyMap<string, StoredAvatarRow>;
  /** Record the user's choice. Rejects with the backend's message. */
  set(projectId: string, custom: CustomProjectAvatar): Promise<void>;
  /** Drop the choice and fall back to the remote image, then the monogram. */
  clear(projectId: string): Promise<void>;
  /**
   * Ask the git host again for one project, now, ignoring the backoff.
   * Resolves false when the host gave us nothing — the caller asked for this
   * fetch by hand, so it deserves to hear that it failed rather than watch
   * nothing change.
   */
  refresh(projectId: string): Promise<boolean>;
}

/**
 * Reads the plugin's own project-avatar store and keeps it live.
 *
 * Built the same way as `useLifecycle`: one read on mount, one more on every
 * realtime signal, a sequence guard so a slow response cannot overwrite a
 * newer one, and no read after a mutation — the write publishes on the
 * channel, and that subscription already refreshes every client, including
 * the sidebar sitting next to the settings page.
 *
 * The signal carries a project id, but this re-reads the whole store rather
 * than patching one row. The store is one small row per project that has an
 * avatar, so a full read costs less than the bookkeeping a patch would need.
 */
export function useProjectAvatars(): ProjectAvatarsApi {
  const rpc = useRpc<typeof triageSidebarRpcContract>();
  const [rows, setRows] = useState<ReadonlyMap<string, StoredAvatarRow>>(
    () => new Map(),
  );

  // Responses can land out of order (a mutation's signal racing another
  // client's), and an older list would silently restore an avatar the user
  // just changed. Only the newest request may write.
  const requestSeq = useRef(0);
  const reload = useCallback(async () => {
    const seq = ++requestSeq.current;
    let result: { rows: StoredAvatarRow[] };
    try {
      result = await rpc.call("listProjectAvatars", {});
    } catch {
      // Unlike the mutations below, a failed read is not reported: every
      // project without a row already renders as a monogram, so an
      // unreachable store degrades to the design's own fallback. Throwing
      // here would take the sidebar down over a decoration.
      return;
    }
    if (seq !== requestSeq.current) return;
    setRows(new Map(result.rows.map((row) => [row.projectId, row])));
  }, [rpc]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useRealtime("project-avatars", () => {
    void reload();
  });

  return useMemo<ProjectAvatarsApi>(
    () => ({
      rows,
      // These reject on purpose, where `useLifecycle`'s mutations return void:
      // parking cannot fail in a way the user could act on, and setting an
      // avatar can — an image of the wrong type or past the size cap comes
      // back as a sentence the settings page has to show.
      set: async (projectId, custom) => {
        await rpc.call("setProjectAvatar", { projectId, custom });
      },
      clear: async (projectId) => {
        await rpc.call("setProjectAvatar", {
          projectId,
          custom: { kind: "clear" },
        });
      },
      refresh: async (projectId) => {
        const result = await rpc.call("refreshProjectAvatar", { projectId });
        return result.ok;
      },
    }),
    [rows, rpc],
  );
}
