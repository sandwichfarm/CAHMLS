import { z } from "zod";

import {
  type CoordinatorSnapshotLifecycle,
  type CoordinatorStorageSnapshot,
  InMemoryCoordinatorStorage,
} from "./inMemoryStorage";

const DATABASE_NAME = "cordn-coordinator-snapshots";
const STORE_NAME = "snapshots";
const SCHEMA_VERSION = 1;

export type CoordinatorStorageFailureKind =
  | "unavailable"
  | "denied"
  | "corrupt"
  | "quota"
  | "write"
  | "flush";

/** A safe category only — browser errors and stored bytes never leave this boundary. */
export class CoordinatorStorageFailure extends Error {
  constructor(readonly kind: CoordinatorStorageFailureKind) {
    super(kind);
    this.name = "CoordinatorStorageFailure";
  }
}

const nostrEventSchema = z.object({
  id: z.string(),
  pubkey: z.string(),
  created_at: z.number().finite(),
  kind: z.number().finite(),
  tags: z.array(z.array(z.string())),
  content: z.string(),
  sig: z.string(),
});

const snapshotSchema = z.object({
  version: z.literal(1),
  deletedGroups: z.array(z.string()).optional(),
  keyPackages: z.array(z.object({
    stablePubkey: z.string(), keyPackageRef: z.string(), isLastResort: z.boolean(),
    publishedAt: z.number().finite(), publicationEvent: nostrEventSchema, keyPackage64: z.string(),
  })),
  welcomes: z.array(z.object({
    targetStablePubkey: z.string(), keyPackageReference: z.string(), welcome64: z.string(),
    createdAt: z.number().finite(), readAt: z.number().finite().nullable(),
    joinAfterCursor: z.number().finite().optional(), afterCursor: z.number().finite().optional(),
  })),
  joinRequests: z.array(z.object({
    groupId: z.string(), requesterStablePubkey: z.string(), keyPackageRef: z.string(),
    inviteToken: z.string().optional(), createdAt: z.number().finite(), readAt: z.number().finite().nullable(),
  })),
  groups: z.array(z.object({
    groupId: z.string(), nextCursor: z.number().int().positive(),
    routing: z.object({ groupId: z.string(), latestHandshakeEpoch: z.string(), lastMessageCursor: z.number().int().nonnegative() }),
    messages: z.array(z.object({
      cursor: z.number().int().positive(), groupId: z.string(), epoch: z.string(),
      ephemeralSenderPubkey: z.string(), opaqueMessage64: z.string(), createdAt: z.number().finite(),
    })),
  })),
});

const recordSchema = z.object({
  key: z.string().regex(/^[0-9a-f]{64}$/),
  version: z.literal(SCHEMA_VERSION),
  updatedAt: z.number().finite(),
  snapshot: snapshotSchema,
});

type StoredSnapshotRecord = z.infer<typeof recordSchema>;

export interface BrowserCoordinatorStorage extends InMemoryCoordinatorStorage {
  deletePersistedSnapshot(): Promise<void>;
  readonly storageFailure: CoordinatorStorageFailure | null;
}

export function normalizeCoordinatorStorageKey(value: string): string {
  const key = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new CoordinatorStorageFailure("unavailable");
  return key;
}

function failureFor(error: unknown, fallback: CoordinatorStorageFailureKind): CoordinatorStorageFailure {
  if (error instanceof CoordinatorStorageFailure) return error;
  const name = error instanceof DOMException ? error.name : "";
  if (name === "QuotaExceededError") return new CoordinatorStorageFailure("quota");
  if (name === "SecurityError" || name === "NotAllowedError") return new CoordinatorStorageFailure("denied");
  return new CoordinatorStorageFailure(fallback);
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, SCHEMA_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(request.error);
  });
}

class IndexedDbSnapshotOwner implements CoordinatorSnapshotLifecycle {
  private tail: Promise<void> = Promise.resolve();
  private pendingFailure: CoordinatorStorageFailure | null = null;
  private closed = false;

  constructor(
    private readonly database: IDBDatabase,
    private readonly key: string,
    private readonly now: () => number,
  ) {}

  static async open(key: string, factory: IDBFactory, now: () => number): Promise<{ owner: IndexedDbSnapshotOwner; snapshot: CoordinatorStorageSnapshot | null }> {
    let database: IDBDatabase;
    try {
      database = await openDatabase(factory);
    } catch (error) {
      throw failureFor(error, "unavailable");
    }
    const owner = new IndexedDbSnapshotOwner(database, key, now);
    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const stored = await requestResult(transaction.objectStore(STORE_NAME).get(key));
      await transactionComplete(transaction);
      if (stored === undefined) return { owner, snapshot: null };
      const parsed = recordSchema.safeParse(stored);
      if (!parsed.success || parsed.data.key !== key) throw new CoordinatorStorageFailure("corrupt");
      return { owner, snapshot: parsed.data.snapshot as CoordinatorStorageSnapshot };
    } catch (error) {
      database.close();
      throw failureFor(error, error instanceof CoordinatorStorageFailure ? error.kind : "corrupt");
    }
  }

  queueSnapshot(snapshot: CoordinatorStorageSnapshot): void {
    if (this.closed) return;
    const immutable = structuredClone(snapshot);
    this.tail = this.tail.catch(() => undefined).then(async () => {
      try {
        const record: StoredSnapshotRecord = { key: this.key, version: SCHEMA_VERSION, updatedAt: this.now(), snapshot: immutable };
        const transaction = this.database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put(record);
        await transactionComplete(transaction);
        this.pendingFailure = null;
      } catch (error) {
        const failure = failureFor(error, "write");
        this.pendingFailure ??= failure;
        throw failure;
      }
    });
  }

  async flush(): Promise<void> {
    try {
      await this.tail;
    } catch (error) {
      throw failureFor(error, "flush");
    }
    if (this.pendingFailure) throw this.pendingFailure;
  }

  async delete(): Promise<void> {
    try {
      const transaction = this.database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(this.key);
      await transactionComplete(transaction);
      this.pendingFailure = null;
    } catch (error) {
      throw failureFor(error, "write");
    }
  }

  async close(): Promise<void> {
    try { await this.flush(); } finally { this.closed = true; this.database.close(); }
  }
}

/**
 * Create a synchronous Cordn storage facade backed by an asynchronous,
 * exact-identity IndexedDB writer. `flush()` is the lifecycle join point.
 */
export async function createBrowserCoordinatorStorage(
  persistent: boolean,
  coordinatorPubkey: string,
  dependencies: { indexedDB?: IDBFactory; now?: () => number } = {},
): Promise<BrowserCoordinatorStorage> {
  if (!persistent) {
    const storage = new InMemoryCoordinatorStorage() as BrowserCoordinatorStorage;
    Object.defineProperties(storage, {
      deletePersistedSnapshot: { value: async () => {}, enumerable: false },
      storageFailure: { value: null, enumerable: false },
    });
    return storage;
  }
  const key = normalizeCoordinatorStorageKey(coordinatorPubkey);
  const factory = dependencies.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new CoordinatorStorageFailure("unavailable");
  const opened = await IndexedDbSnapshotOwner.open(key, factory, dependencies.now ?? Date.now);
  const storage = new InMemoryCoordinatorStorage(opened.snapshot, undefined, opened.owner) as BrowserCoordinatorStorage;
  Object.defineProperties(storage, {
    deletePersistedSnapshot: { value: () => opened.owner.delete(), enumerable: false },
    storageFailure: { get: () => null, enumerable: false },
  });
  return storage;
}

/** Global cleanup is reserved for existing confirmed identity destruction flows. */
export async function clearPersistedCoordinatorState(): Promise<void> {
  const factory = globalThis.indexedDB;
  if (!factory) return;
  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new CoordinatorStorageFailure("write"));
    request.onblocked = () => reject(new CoordinatorStorageFailure("write"));
  });
}

/** Remove only the active identity record after a contextual confirmation. */
export async function removePersistedCoordinatorSnapshot(coordinatorPubkey: string): Promise<void> {
  const key = normalizeCoordinatorStorageKey(coordinatorPubkey);
  const factory = globalThis.indexedDB;
  if (!factory) throw new CoordinatorStorageFailure("unavailable");
  let database: IDBDatabase | undefined;
  try {
    database = await openDatabase(factory);
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(key);
    await transactionComplete(transaction);
  } catch (error) {
    throw failureFor(error, "write");
  } finally {
    database?.close();
  }
}
