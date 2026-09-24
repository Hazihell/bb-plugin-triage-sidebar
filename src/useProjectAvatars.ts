import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  CustomProjectAvatar,
  StoredAvatarRow,
  triageSidebarRpcContract,
} from "./server";
import { isRecord, readSnapshot, writeSnapshot } from "./local-snapshot";

export interface ProjectAvatarsApi {
  /**
   * What is stored per project id. A project with no entry has never been
   * customized and has no cached image — which is not a missing value, it is
   * the monogram, so callers pass `undefined` straight to `ProjectAvatar`.
   */
  rows: ReadonlyMap<string, StoredAvatarRow>;
  /** Record the user's choice. Rejects with the backend's message. */
  set(projectId: string, custom: CustomProjectAvatar): Promise<void>;
  /**
   * Store an image the user named by address. The download happens on the
   * server, not here: an image host that sends no permissive CORS header is
   * perfectly readable in a browser tab and unreadable to `fetch` in this
   * window, and the user cannot tell those two apart or do anything about it.
   * Rejects with the backend's own sentence about the address or the image.
   */
  setFromUrl(projectId: string, url: string): Promise<void>;
  /**
   * Drop the choice and fall back to the project's own icon, then the remote
   * image, then the monogram.
   */
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
  // Seeded from the last session, so the first frame has the real avatars
  // rather than monograms that turn into images a moment later.
  const [rows, setRows] = useState<ReadonlyMap<string, StoredAvatarRow>>(
    () => readAvatarSnapshot() ?? new Map(),
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
    writeAvatarSnapshot(result.rows);
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
      setFromUrl: async (projectId, url) => {
        await rpc.call("setProjectAvatarFromUrl", { projectId, url });
      },
      refresh: async (projectId) => {
        const result = await rpc.call("refreshProjectAvatar", { projectId });
        return result.ok;
      },
    }),
    [rows, rpc],
  );
}

const SNAPSHOT_KEY = "avatars:v1";

/**
 * The most image data the snapshot may hold. localStorage is one small quota
 * shared with bb itself, and an avatar image may be up to 256 KB, so the
 * snapshot keeps the smallest images first and drops the rest: those
 * projects paint a monogram for a moment on launch, as before.
 */
const IMAGE_BUDGET_CHARS = 512 * 1024;
const IMAGE_FIELDS = ["customImage", "faviconImage", "remoteImage"] as const;

function imageChars(row: StoredAvatarRow): number {
  return IMAGE_FIELDS.reduce((sum, field) => sum + (row[field]?.length ?? 0), 0);
}

function writeAvatarSnapshot(rows: readonly StoredAvatarRow[]): void {
  let budget = IMAGE_BUDGET_CHARS;
  const kept = [...rows]
    .sort((left, right) => imageChars(left) - imageChars(right))
    .map((row) => {
      const size = imageChars(row);
      if (size <= budget) {
        budget -= size;
        return row;
      }
      return { ...row, customImage: null, faviconImage: null, remoteImage: null };
    });
  writeSnapshot(SNAPSHOT_KEY, kept);
}

function readAvatarSnapshot(): Map<string, StoredAvatarRow> | null {
  return readSnapshot(SNAPSHOT_KEY, (value) => {
    if (!Array.isArray(value)) return null;
    const rows = new Map<string, StoredAvatarRow>();
    for (const row of value) {
      if (!isRecord(row) || typeof row.projectId !== "string") return null;
      rows.set(row.projectId, row as unknown as StoredAvatarRow);
    }
    return rows;
  });
}
