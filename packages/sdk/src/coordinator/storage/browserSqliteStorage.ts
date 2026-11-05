import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

import {
  CoordinatorStorageSnapshot,
  InMemoryCoordinatorStorage,
} from "./inMemoryStorage.js";

const SQLITE_DB_NAME = ":localStorage:";
const SNAPSHOT_KEY = "cordn:v1:coordinator-snapshot";
const FALLBACK_STORAGE_KEY = "cordn:v1:coordinator-snapshot:fallback";
const DELETED_GROUPS_STORAGE_PREFIX = "cordn:v1:deleted-groups:";
const KVVFS_LOCAL_PREFIX = "kvvfs-local-";

type SqliteModule = Awaited<ReturnType<typeof sqlite3InitModule>>;
type SqliteDatabase = InstanceType<SqliteModule["oo1"]["DB"]>;

interface SnapshotPersistence {
  load(): CoordinatorStorageSnapshot | null;
  save(snapshot: CoordinatorStorageSnapshot): void;
  clear(): void;
  close(): void;
}

class LocalStorageSnapshotPersistence implements SnapshotPersistence {
  load(): CoordinatorStorageSnapshot | null {
    const raw = localStorage.getItem(FALLBACK_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CoordinatorStorageSnapshot) : null;
  }

  save(snapshot: CoordinatorStorageSnapshot): void {
    localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(snapshot));
  }

  clear(): void {
    localStorage.removeItem(FALLBACK_STORAGE_KEY);
  }

  close(): void {}
}

class VolatileSnapshotPersistence implements SnapshotPersistence {
  load(): CoordinatorStorageSnapshot | null {
    return null;
  }

  save(): void {}

  /* v8 ignore next -- clearPersistedCoordinatorState returns early without localStorage, the only case that builds this class */
  clear(): void {}

  close(): void {}
}

class SqliteSnapshotPersistence implements SnapshotPersistence {
  constructor(private readonly db: SqliteDatabase) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cordn_snapshot (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  load(): CoordinatorStorageSnapshot | null {
    const rows = this.db.exec({
      sql: "SELECT value FROM cordn_snapshot WHERE key = $key",
      bind: { $key: SNAPSHOT_KEY },
      returnValue: "resultRows",
      rowMode: "object",
    });
    const value = rows[0]?.value;
    return typeof value === "string" ? (JSON.parse(value) as CoordinatorStorageSnapshot) : null;
  }

  save(snapshot: CoordinatorStorageSnapshot): void {
    this.db.exec({
      sql: `
        INSERT INTO cordn_snapshot (key, value)
        VALUES ($key, $value)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
      bind: { $key: SNAPSHOT_KEY, $value: JSON.stringify(snapshot) },
    });
  }

  clear(): void {
    this.db.exec({
      sql: "DELETE FROM cordn_snapshot WHERE key = $key",
      bind: { $key: SNAPSHOT_KEY },
    });
  }

  close(): void {
    this.db.close();
  }
}

async function createSnapshotPersistence(): Promise<SnapshotPersistence> {
  if (!("localStorage" in globalThis)) {
    return new VolatileSnapshotPersistence();
  }

  let db: SqliteDatabase | undefined;
  try {
    const sqlite3 = await sqlite3InitModule();
    db = new sqlite3.oo1.DB(SQLITE_DB_NAME, "c");
    return new SqliteSnapshotPersistence(db);
  } catch {
    try {
      db?.close();
    } catch {
      // The database is already unusable; the fallback does not depend on it.
    }
    return new LocalStorageSnapshotPersistence();
  }
}

function deletedGroupsStorageKey(coordinatorPubkey: string): string {
  return `${DELETED_GROUPS_STORAGE_PREFIX}${coordinatorPubkey.toLowerCase()}`;
}

function loadDeletedGroups(coordinatorPubkey: string): string[] {
  if (!("localStorage" in globalThis)) {
    return [];
  }

  try {
    const raw = localStorage.getItem(deletedGroupsStorageKey(coordinatorPubkey));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((groupId): groupId is string => typeof groupId === "string")
      : [];
  } catch {
    return [];
  }
}

function saveDeletedGroups(coordinatorPubkey: string, groupIds: string[]): void {
  if (!("localStorage" in globalThis)) {
    return;
  }

  const key = deletedGroupsStorageKey(coordinatorPubkey);
  if (groupIds.length === 0) {
    localStorage.removeItem(key);
    return;
  }

  localStorage.setItem(key, JSON.stringify([...new Set(groupIds)].sort()));
}

function mergeDeletedGroups(
  snapshot: CoordinatorStorageSnapshot | null,
  deletedGroups: string[],
): CoordinatorStorageSnapshot | null {
  // The registry is authoritative here because it is scoped to the current
  // coordinator pubkey. The full snapshot predates identity scoping and may
  // belong to a different coordinator after a local identity change.
  const mergedDeletedGroups = [...new Set(deletedGroups)].sort();
  if (!snapshot && mergedDeletedGroups.length === 0) {
    return null;
  }

  return {
    version: 1,
    keyPackages: [],
    welcomes: [],
    joinRequests: [],
    groups: [],
    ...snapshot,
    deletedGroups: mergedDeletedGroups,
  };
}

export async function createBrowserCoordinatorStorage(
  persistent: boolean,
  coordinatorPubkey: string,
): Promise<InMemoryCoordinatorStorage> {
  const persistence = persistent ? await createSnapshotPersistence() : null;
  let storage: InMemoryCoordinatorStorage;
  try {
    const snapshot = mergeDeletedGroups(
      persistence?.load() ?? null,
      loadDeletedGroups(coordinatorPubkey),
    );
    if (snapshot?.deletedGroups) {
      saveDeletedGroups(coordinatorPubkey, snapshot.deletedGroups);
    }

    storage = new InMemoryCoordinatorStorage(snapshot, (nextSnapshot) => {
      saveDeletedGroups(coordinatorPubkey, nextSnapshot.deletedGroups!);
      persistence?.save(nextSnapshot);
    });
  } catch (error) {
    // A snapshot that cannot be restored must not leave the database open.
    persistence?.close();
    throw error;
  }

  const closeStorage = storage.close.bind(storage);
  storage.close = () => {
    closeStorage();
    persistence?.close();
  };

  return storage;
}

export async function clearPersistedCoordinatorState(): Promise<void> {
  if (!("localStorage" in globalThis)) {
    return;
  }

  localStorage.removeItem(FALLBACK_STORAGE_KEY);
  const persistence = await createSnapshotPersistence();
  persistence.clear();
  persistence.close();
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (
      key?.startsWith(KVVFS_LOCAL_PREFIX) ||
      key?.startsWith(DELETED_GROUPS_STORAGE_PREFIX)
    ) {
      localStorage.removeItem(key);
    }
  }
}
