import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { KeyPackage, Welcome } from "ts-mls";

const sqlite = vi.hoisted(() => {
  const SNAPSHOT_ROWS = new Map<string, unknown>();
  const state = {
    /** Durable like kvvfs: rows outlive any one database handle. */
    rows: SNAPSHOT_ROWS,
    opened: [] as Array<[string, string]>,
    closed: 0,
    failNextExecContaining: null as string | null,
    failClose: false,
  };

  class FakeDB {
    constructor(name: string, mode: string) {
      state.opened.push([name, mode]);
    }

    exec(
      statement:
        | string
        | { sql: string; bind?: Record<string, unknown>; returnValue?: string; rowMode?: string },
    ): Array<Record<string, unknown>> {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (state.failNextExecContaining && sql.includes(state.failNextExecContaining)) {
        state.failNextExecContaining = null;
        throw new Error("sqlite exec failed");
      }
      if (typeof statement === "string" || sql.includes("CREATE TABLE")) {
        return [];
      }
      const key = String(statement.bind?.$key);
      if (sql.includes("SELECT")) {
        return state.rows.has(key) ? [{ value: state.rows.get(key) }] : [];
      }
      if (sql.includes("INSERT")) {
        state.rows.set(key, statement.bind?.$value);
      } else if (sql.includes("DELETE")) {
        state.rows.delete(key);
      }
      return [];
    }

    close(): void {
      state.closed += 1;
      if (state.failClose) throw new Error("close failed");
    }
  }

  return { state, FakeDB, init: vi.fn() };
});

vi.mock("@sqlite.org/sqlite-wasm", () => ({ default: sqlite.init }));

import {
  addMember,
  createKeyPackage,
  createRoomState,
} from "../src/client/protocol.js";
import {
  clearPersistedCoordinatorState,
  createBrowserCoordinatorStorage,
} from "../src/coordinator/storage/browserSqliteStorage.js";
import { Coordinator } from "../src/coordinator/coordinator.js";
import type { InMemoryCoordinatorStorage } from "../src/coordinator/storage/inMemoryStorage.js";
import { decodeWelcome, encodeKeyPackage, encodeWelcome } from "../src/mls/mlsCodec.js";
import { decodeBase64 } from "../src/server/base64.js";

const SNAPSHOT_KEY = "cordn:v1:coordinator-snapshot";
const FALLBACK_KEY = "cordn:v1:coordinator-snapshot:fallback";
const COORDINATOR_A = "aa".repeat(32);
const COORDINATOR_B = "bb".repeat(32);
const registryKey = (pubkey: string) => `cordn:v1:deleted-groups:${pubkey}`;

let keyPackage: KeyPackage;
let welcome: Welcome;

beforeAll(async () => {
  const host = await createKeyPackage("12".repeat(32));
  const guest = await createKeyPackage("34".repeat(32));
  keyPackage = guest.keyPackage;
  const state = await createRoomState(host.keyPackage, host.privateKeyPackage);
  const { welcomeBase64 } = await addMember(state, guest.stored.publicBase64);
  welcome = decodeWelcome(decodeBase64(welcomeBase64));
});

function useWorkingSqlite(): void {
  sqlite.init.mockResolvedValue({ oo1: { DB: sqlite.FakeDB } });
}

function useMissingSqlite(): void {
  sqlite.init.mockRejectedValue(new Error("sqlite unavailable"));
}

function append(storage: InMemoryCoordinatorStorage, groupId: string, bytes: Uint8Array, epoch = 0n) {
  return storage.appendGroupMessage({
    groupId,
    latestHandshakeEpoch: epoch,
    epoch,
    ephemeralSenderPubkey: "sender",
    opaqueMessage: bytes,
    createdAt: 1,
  });
}

function seedAllRecordTypes(storage: InMemoryCoordinatorStorage, epoch: bigint, bytes: Uint8Array) {
  storage.publishKeyPackage({
    stablePubkey: "guest",
    keyPackage,
    keyPackageRef: "kp",
    isLastResort: false,
    publishedAt: 1,
    publicationEvent: { id: "event" } as never,
  });
  storage.storeWelcome({
    targetStablePubkey: "guest",
    keyPackageReference: "kp",
    welcome,
    createdAt: 2,
    readAt: null,
    joinAfterCursor: 6,
  });
  storage.storeJoinRequest({
    groupId: "room",
    requesterStablePubkey: "guest",
    keyPackageRef: "kp",
    inviteToken: "token",
    createdAt: 3,
    readAt: null,
  });
  append(storage, "room", bytes, epoch);
}

function expectAllRecordTypesRestored(
  storage: InMemoryCoordinatorStorage,
  epoch: bigint,
  bytes: Uint8Array,
) {
  const [message] = storage.fetchGroupMessages({ groupId: "room" });
  expect(message?.epoch).toBe(epoch);
  expect(message?.opaqueMessage).toBeInstanceOf(Uint8Array);
  expect(message?.opaqueMessage).toEqual(bytes);
  expect(storage.getGroupRouting("room")?.latestHandshakeEpoch).toBe(epoch);
  expect(encodeKeyPackage(storage.getKeyPackage("kp")!.keyPackage)).toEqual(
    encodeKeyPackage(keyPackage),
  );
  const [restoredWelcome] = storage.fetchPendingWelcomes("guest", 9);
  expect(restoredWelcome?.joinAfterCursor).toBe(6);
  expect(encodeWelcome(restoredWelcome!.welcome)).toEqual(encodeWelcome(welcome));
  expect(storage.fetchPendingJoinRequests("room", 9)).toMatchObject([{ inviteToken: "token" }]);
}

beforeEach(() => {
  localStorage.clear();
  sqlite.state.rows.clear();
  sqlite.state.opened.length = 0;
  sqlite.state.closed = 0;
  sqlite.state.failNextExecContaining = null;
  sqlite.state.failClose = false;
  sqlite.init.mockReset();
  useWorkingSqlite();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SQLite persistence", () => {
  test("opens the kvvfs database and starts empty when nothing was saved", async () => {
    const storage = await createBrowserCoordinatorStorage(true, COORDINATOR_A);

    expect(sqlite.state.opened).toEqual([[":localStorage:", "c"]]);
    expect(storage.toSnapshot()).toMatchObject({ keyPackages: [], groups: [] });
    expect(sqlite.state.rows.size).toBe(0);

    storage.close();
  });

  test("restores every record type across a restart, with bigints and bytes intact", async () => {
    const epoch = 2n ** 60n + 3n;
    const bytes = Uint8Array.from([0, 128, 255]);
    const first = await createBrowserCoordinatorStorage(true, COORDINATOR_A);
    seedAllRecordTypes(first, epoch, bytes);
    first.close();

    const restarted = await createBrowserCoordinatorStorage(true, COORDINATOR_A);

    expectAllRecordTypesRestored(restarted, epoch, bytes);
    expect(append(restarted, "room", Uint8Array.of(1), epoch).cursor).toBe(2);
    restarted.close();
  });

  test("overwrites the single snapshot row on each change", async () => {
    const storage = await createBrowserCoordinatorStorage(true, COORDINATOR_A);

    append(storage, "room", Uint8Array.of(1));
    append(storage, "room", Uint8Array.of(2));

    expect([...sqlite.state.rows.keys()]).toEqual([SNAPSHOT_KEY]);
    const saved = JSON.parse(String(sqlite.state.rows.get(SNAPSHOT_KEY))) as {
      groups: Array<{ messages: unknown[] }>;
    };
    expect(saved.groups[0]?.messages).toHaveLength(2);
    expect(localStorage.getItem(FALLBACK_KEY)).toBeNull();
    storage.close();
  });

  test("closes the database once with the storage, including through a Coordinator", async () => {
    const storage = await createBrowserCoordinatorStorage(true, COORDINATOR_A);
    new Coordinator({ storage, welcomeCleanupIntervalMs: 0 }).close();

    expect(sqlite.state.closed).toBe(1);
  });

  test("never touches SQLite when persistence is off", async () => {
    const storage = await createBrowserCoordinatorStorage(false, COORDINATOR_A);
    append(storage, "room", Uint8Array.of(1));
    storage.close();

    expect(sqlite.init).not.toHaveBeenCalled();

    const restarted = await createBrowserCoordinatorStorage(false, COORDINATOR_A);
    expect(restarted.getGroupRouting("room")).toBeNull();
    restarted.close();
  });

  test("treats a row without a text value as no snapshot", async () => {
    sqlite.state.rows.set(SNAPSHOT_KEY, 42);

    const storage = await createBrowserCoordinatorStorage(true, COORDINATOR_A);

    expect(storage.toSnapshot().groups).toEqual([]);
    storage.close();
  });

  test("fills in the sections a partial snapshot leaves out", async () => {
    sqlite.state.rows.set(SNAPSHOT_KEY, JSON.stringify({ version: 1 }));

    const storage = await createBrowserCoordinatorStorage(true, COORDINATOR_A);

    expect(storage.toSnapshot()).toMatchObject({
      keyPackages: [],
      welcomes: [],
      joinRequests: [],
      groups: [],
    });
    storage.close();
  });

  test.each([
    ["invalid JSON", "{not json", SyntaxError],
    ["an unsupported version", JSON.stringify({ version: 9 }), /Unsupported coordinator/],
    ["undecodable records", JSON.stringify({ version: 1, keyPackages: [{ keyPackage64: "!" }] }), /Invalid base64/],
  ])("rejects %s and releases the database", async (_label, raw, expected) => {
    sqlite.state.rows.set(SNAPSHOT_KEY, raw);

    await expect(createBrowserCoordinatorStorage(true, COORDINATOR_A)).rejects.toThrow(expected);

    expect(sqlite.state.closed).toBe(1);
  });

  test("surfaces a failed save to the mutating caller", async () => {
    const storage = await createBrowserCoordinatorStorage(true, COORDINATOR_A);
    sqlite.state.failNextExecContaining = "INSERT";

    expect(() => append(storage, "room", Uint8Array.of(1))).toThrow("sqlite exec failed");
    storage.close();
  });
});

describe("localStorage fallback", () => {
  test("is used when the SQLite module cannot load, and survives a restart", async () => {
    useMissingSqlite();
    const epoch = 2n ** 55n;
    const bytes = Uint8Array.from([9, 8, 7, 255]);
    const first = await createBrowserCoordinatorStorage(true, COORDINATOR_A);
    seedAllRecordTypes(first, epoch, bytes);
    first.close();

    expect(localStorage.getItem(FALLBACK_KEY)).toContain('"keyPackage64"');
    expect(sqlite.state.rows.size).toBe(0);

    const restarted = await createBrowserCoordinatorStorage(true, COORDINATOR_A);
    expectAllRecordTypesRestored(restarted, epoch, bytes);
    restarted.close();
  });

  test("is used when the database cannot be opened", async () => {
    sqlite.init.mockResolvedValue({
      oo1: {
        DB: class {
          constructor() {
            throw new Error("cannot open");
          }
        },
      },
    });

    const storage = await createBrowserCoordinatorStorage(true, COORDINATOR_A);
    append(storage, "room", Uint8Array.of(1));

    expect(localStorage.getItem(FALLBACK_KEY)).toContain('"room"');
    storage.close();
  });

  test.each([
    ["ok", false],
    ["failing", true],
  ])(
    "is used when the schema cannot be created, releasing the database (%s close)",
    async (_label, failClose) => {
      sqlite.state.failNextExecContaining = "CREATE TABLE";
      sqlite.state.failClose = failClose;

      const storage = await createBrowserCoordinatorStorage(true, COORDINATOR_A);
      append(storage, "room", Uint8Array.of(1));

      expect(sqlite.state.closed).toBe(1);
      expect(localStorage.getItem(FALLBACK_KEY)).toContain('"room"');
      storage.close();
    },
  );

  test("starts empty with nothing saved, and rejects malformed JSON", async () => {
    useMissingSqlite();

    const fresh = await createBrowserCoordinatorStorage(true, COORDINATOR_A);
    expect(fresh.toSnapshot().groups).toEqual([]);
    fresh.close();

    localStorage.setItem(FALLBACK_KEY, "{not json");
    await expect(createBrowserCoordinatorStorage(true, COORDINATOR_A)).rejects.toThrow(SyntaxError);
  });
});

describe("without localStorage", () => {
  let descriptor: PropertyDescriptor;

  beforeEach(() => {
    descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", descriptor);
  });

  test("runs volatile: mutations work and tombstones last for the session only", async () => {
    const storage = await createBrowserCoordinatorStorage(true, COORDINATOR_A);

    expect(sqlite.init).not.toHaveBeenCalled();
    append(storage, "room", Uint8Array.of(1));
    storage.deleteGroup("doomed");
    expect(storage.isGroupDeleted("doomed")).toBe(true);
    expect(() => storage.close()).not.toThrow();

    const restarted = await createBrowserCoordinatorStorage(true, COORDINATOR_A);
    expect(restarted.getGroupRouting("room")).toBeNull();
    expect(restarted.isGroupDeleted("doomed")).toBe(false);
    restarted.close();
  });

  test("clearing persisted state is a no-op", async () => {
    await expect(clearPersistedCoordinatorState()).resolves.toBeUndefined();
    expect(sqlite.init).not.toHaveBeenCalled();
  });
});

describe("deleted-group registry", () => {
  test("scopes tombstones to the coordinator, case-insensitively", async () => {
    const first = await createBrowserCoordinatorStorage(false, COORDINATOR_A.toUpperCase());
    first.deleteGroup("doomed");
    first.close();

    expect(localStorage.getItem(registryKey(COORDINATOR_A))).toBe('["doomed"]');

    const sameCoordinator = await createBrowserCoordinatorStorage(false, COORDINATOR_A);
    const otherCoordinator = await createBrowserCoordinatorStorage(false, COORDINATOR_B);
    expect(sameCoordinator.isGroupDeleted("doomed")).toBe(true);
    expect(otherCoordinator.isGroupDeleted("doomed")).toBe(false);
    sameCoordinator.close();
    otherCoordinator.close();
  });

  test("keeps deleted rooms rejected across persistent restarts", async () => {
    const first = await createBrowserCoordinatorStorage(true, COORDINATOR_A);
    append(first, "doomed", Uint8Array.of(1));
    first.deleteGroup("doomed");
    first.close();

    const restarted = await createBrowserCoordinatorStorage(true, COORDINATOR_A);

    expect(restarted.getGroupRouting("doomed")).toBeNull();
    expect(() => append(restarted, "doomed", Uint8Array.of(2))).toThrow("Room deleted by host");
    restarted.close();
  });

  test("the registry, not the unscoped snapshot, decides what this coordinator deleted", async () => {
    const other = await createBrowserCoordinatorStorage(true, COORDINATOR_A);
    other.deleteGroup("deleted-by-a");
    other.close();

    const storage = await createBrowserCoordinatorStorage(true, COORDINATOR_B);

    expect(storage.isGroupDeleted("deleted-by-a")).toBe(false);
    storage.close();
  });

  test("normalizes a stored registry on load, ignoring entries that are not ids", async () => {
    localStorage.setItem(
      registryKey(COORDINATOR_A),
      JSON.stringify(["z-room", 5, "a-room", null, "z-room"]),
    );

    const storage = await createBrowserCoordinatorStorage(false, COORDINATOR_A);

    expect(storage.toSnapshot().deletedGroups).toEqual(["a-room", "z-room"]);
    expect(localStorage.getItem(registryKey(COORDINATOR_A))).toBe('["a-room","z-room"]');
    storage.close();
  });

  test.each([
    ["invalid JSON", "{not json"],
    ["a non-array", '{"doomed":true}'],
    ["an array without ids", "[1,2]"],
  ])("treats %s as an empty registry and clears it on the next change", async (_label, raw) => {
    localStorage.setItem(registryKey(COORDINATOR_A), raw);

    const storage = await createBrowserCoordinatorStorage(false, COORDINATOR_A);
    expect(storage.toSnapshot().deletedGroups).toEqual([]);
    expect(localStorage.getItem(registryKey(COORDINATOR_A))).toBe(raw);

    append(storage, "room", Uint8Array.of(1));

    expect(localStorage.getItem(registryKey(COORDINATOR_A))).toBeNull();
    storage.close();
  });
});

describe("clearPersistedCoordinatorState", () => {
  test("removes the SQLite row, the fallback, kvvfs pages and tombstones, and nothing else", async () => {
    const storage = await createBrowserCoordinatorStorage(true, COORDINATOR_A);
    append(storage, "room", Uint8Array.of(1));
    storage.deleteGroup("doomed");
    storage.close();
    const closedBefore = sqlite.state.closed;
    localStorage.setItem(FALLBACK_KEY, "{}");
    localStorage.setItem("kvvfs-local-page-1", "page");
    localStorage.setItem("kvvfs-local-page-2", "page");
    localStorage.setItem("unrelated", "keep me");

    await clearPersistedCoordinatorState();

    expect(sqlite.state.rows.size).toBe(0);
    expect(sqlite.state.closed).toBe(closedBefore + 1);
    expect(localStorage.getItem("unrelated")).toBe("keep me");
    expect(localStorage.length).toBe(1);

    const restarted = await createBrowserCoordinatorStorage(true, COORDINATOR_A);
    expect(restarted.isGroupDeleted("doomed")).toBe(false);
    expect(restarted.getGroupRouting("room")).toBeNull();
    restarted.close();
  });

  test("clears the fallback when SQLite is unavailable", async () => {
    useMissingSqlite();
    const storage = await createBrowserCoordinatorStorage(true, COORDINATOR_A);
    append(storage, "room", Uint8Array.of(1));
    storage.close();
    expect(localStorage.getItem(FALLBACK_KEY)).not.toBeNull();

    await clearPersistedCoordinatorState();

    expect(localStorage.getItem(FALLBACK_KEY)).toBeNull();
    const restarted = await createBrowserCoordinatorStorage(true, COORDINATOR_A);
    expect(restarted.getGroupRouting("room")).toBeNull();
    restarted.close();
  });

  test("tolerates a storage key that disappears while it scans", async () => {
    localStorage.setItem("kvvfs-local-page", "page");
    const key = vi.spyOn(localStorage, "key").mockReturnValueOnce(null);

    await expect(clearPersistedCoordinatorState()).resolves.toBeUndefined();

    expect(key).toHaveBeenCalled();
  });
});
