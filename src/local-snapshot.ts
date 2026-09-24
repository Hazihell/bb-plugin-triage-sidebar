/**
 * The last state this client saw, kept in localStorage so the next launch can
 * paint it on its first frame.
 *
 * Without it the sidebar's first frame is wrong in a way the user can see:
 * the host's threads arrive at once, but the parking store and the avatars
 * are a round trip away, so settled threads sit in the inbox and avatars are
 * monograms until they land, and then everything jumps. A snapshot makes the
 * first frame the list the user last saw; the live read replaces it a moment
 * later, and only what really changed meanwhile moves.
 *
 * A snapshot is a cache, never a source of truth, and it shares one small
 * quota with bb itself:
 * - Every row is checked field by field against the schema the first frame
 *   reads. One bad row discards the whole snapshot: a half-trusted list is
 *   worse than the skeleton.
 * - The key carries a fingerprint of that schema, so a build whose rows have a
 *   different shape never reads an older build's, and a write clears the
 *   older keys it replaces.
 * - Writes are coalesced to one per second, plus one when the page is hidden,
 *   because the stores change on every turn of every thread.
 * - A write that fails (quota, private mode) removes the key rather than
 *   leaving an older snapshot behind, so the next launch shows the skeleton
 *   instead of a list from further back.
 */
const PREFIX = "bb-plugin:triage-sidebar:";
const WRITE_DELAY_MS = 1_000;

/**
 * The type of one field, as the first frame reads it. A trailing "?" admits
 * null, and so does an array, which is an enum of strings.
 */
export type FieldKind =
  | "string"
  | "number"
  | "number?"
  | "string?"
  | readonly string[];
export type RowSchema = Readonly<Record<string, FieldKind>>;

export interface SnapshotStore<Row extends object> {
  /** The snapshot, or null when there is none or any row fails the schema. */
  read(): Row[] | null;
  /**
   * Save what `rows` returns, at most once a second and once more when the
   * page is hidden. `rows` is called when the write happens, so it always
   * saves the latest state; returning null skips the write.
   */
  schedule(rows: () => readonly Row[] | null): void;
}

/** Where a snapshot of this name and row shape lives. */
export function snapshotKey(name: string, schema: RowSchema): string {
  return `${PREFIX}${name}:${fingerprint(schema)}`;
}

export function createSnapshotStore<Row extends object>(
  name: string,
  schema: RowSchema,
): SnapshotStore<Row> {
  const key = snapshotKey(name, schema);
  let pending: (() => readonly Row[] | null) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const rows = pending?.();
    pending = null;
    if (rows == null) return;
    const storage = storageOrNull();
    if (storage === null) return;
    try {
      storage.setItem(key, JSON.stringify(rows.map((row) => pick(row, schema))));
      removeOlderKeys(storage, name, key);
    } catch {
      try {
        storage.removeItem(key);
      } catch {
        // Storage unusable altogether: the next launch reads the store.
      }
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flush);
  }

  return {
    read: () => {
      try {
        const raw = storageOrNull()?.getItem(key);
        if (raw == null) return null;
        return parseRows<Row>(JSON.parse(raw), schema);
      } catch {
        return null;
      }
    },
    schedule: (rows) => {
      pending = rows;
      timer ??= setTimeout(flush, WRITE_DELAY_MS);
    },
  };
}

/** Every row checked against `schema`; null if any row is off. */
export function parseRows<Row>(value: unknown, schema: RowSchema): Row[] | null {
  if (!Array.isArray(value)) return null;
  const rows: Row[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) return null;
    const record = candidate as Record<string, unknown>;
    for (const [field, kind] of Object.entries(schema)) {
      if (!fits(record[field], kind)) return null;
    }
    rows.push(pick(record, schema) as Row);
  }
  return rows;
}

function fits(value: unknown, kind: FieldKind): boolean {
  if (kind === "string") return typeof value === "string";
  if (kind === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (value === null) return true;
  if (kind === "number?") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (kind === "string?") return typeof value === "string";
  return typeof value === "string" && kind.includes(value);
}

/** Only the schema's fields: nothing the first frame does not read is kept. */
function pick(row: object, schema: RowSchema): Record<string, unknown> {
  const record = row as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of Object.keys(schema)) picked[field] = record[field] ?? null;
  return picked;
}

function fingerprint(schema: RowSchema): string {
  const text = JSON.stringify(
    Object.entries(schema).sort(([left], [right]) => left.localeCompare(right)),
  );
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function removeOlderKeys(storage: Storage, name: string, current: string): void {
  const family = `${PREFIX}${name}:`;
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key !== null && key.startsWith(family) && key !== current) {
      storage.removeItem(key);
    }
  }
}

function storageOrNull(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
