import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";

import { LocalHostCoordinatorClient } from "../src/client/local-coordinator-client.js";
import { configureRoomEnvironment, createMemoryRoomStorage } from "../src/client/room-environment.js";
import { listRooms, ROOMS_CHANGED_EVENT, saveRoom, type StoredRoom } from "../src/client/room-store.js";
import {
  clearPersistedCoordinatorState,
  createBrowserCoordinatorStorage,
} from "../src/coordinator/storage/browserSqliteStorage.js";
import type { CoordinatorStorage } from "../src/coordinator/storage/storage.js";
import { KeyManager } from "../src/crypto/key-manager.js";
import { KeyStorage, WrongPassphraseError, type CoordinatorKeyBackup } from "../src/crypto/key-storage.js";
import { transportFactory, type RunningTransport, type TransportDiagnostics } from "../src/server/transport.js";
import {
  CoordinatorRuntime,
  defaultCoordinatorRuntimeDeps,
  ROOM_RECOVERY_POLICY,
  type CoordinatorRuntimeDeps,
} from "../src/runtime/coordinator-runtime.js";
import { INSTANCE_RUNNING_MESSAGE, type InstanceLease } from "../src/runtime/single-instance-guard.js";
import type { HostedRoomRecoveryTarget } from "../src/runtime/types.js";
import { createFakeTransport, createRuntimeDeps, createTestConfig } from "./support/runtime-harness.js";

vi.mock("../src/coordinator/storage/browserSqliteStorage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/coordinator/storage/browserSqliteStorage.js")>()),
  clearPersistedCoordinatorState: vi.fn(async () => undefined),
  createBrowserCoordinatorStorage: vi.fn(),
}));

const clearPersisted = vi.mocked(clearPersistedCoordinatorState);
const browserStorage = vi.mocked(createBrowserCoordinatorStorage);

function memoryKeyStorage(): KeyStorage {
  const values = new Map<string, string>();
  return new KeyStorage({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

const targetA: HostedRoomRecoveryTarget = {
  coordinatorPubkey: "a".repeat(64),
  roomId: "alpha",
  roomName: "Alpha",
  roomIdentityKey: `${"a".repeat(64)}:alpha`,
};
const targetB: HostedRoomRecoveryTarget = {
  coordinatorPubkey: "b".repeat(64),
  roomId: "bravo",
  roomName: "Bravo",
  roomIdentityKey: `${"b".repeat(64)}:bravo`,
};

type MockedDeps = { [K in keyof Omit<CoordinatorRuntimeDeps, "createStorage">]: Mock<CoordinatorRuntimeDeps[K]> };

const liveRuntimes: CoordinatorRuntime[] = [];

function setup(input: {
  deps?: Partial<CoordinatorRuntimeDeps>;
  config?: Parameters<typeof createTestConfig>[0];
  keyStorage?: KeyStorage;
  onDestroy?: () => void;
} = {}) {
  const harness = createRuntimeDeps(input.deps);
  const config = createTestConfig(input.config);
  const keyStorage = input.keyStorage ?? memoryKeyStorage();
  const runtime = new CoordinatorRuntime({ config, deps: harness.deps, keyStorage, onDestroy: input.onDestroy });
  liveRuntimes.push(runtime);
  return { runtime, config, keyStorage, leases: harness.leases, transports: harness.transports, deps: harness.deps as unknown as MockedDeps };
}

function messages(runtime: CoordinatorRuntime): string[] {
  return runtime.debugLog.map((entry) => entry.message);
}

function logEntry(runtime: CoordinatorRuntime, message: string) {
  return runtime.debugLog.find((entry) => entry.message === message);
}

let restoreRoomEnvironment: () => void;

beforeEach(() => {
  clearPersisted.mockReset();
  clearPersisted.mockResolvedValue(undefined);
  browserStorage.mockReset();
  restoreRoomEnvironment = configureRoomEnvironment({ storage: createMemoryRoomStorage() });
});

afterEach(async () => {
  // Unregisters each runtime's pagehide listener so it cannot react to a later test's event.
  await Promise.allSettled(liveRuntimes.splice(0).map((runtime) => runtime.stopSync()));
  restoreRoomEnvironment();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("construction", () => {
  test("generates a ready identity when nothing is persisted", () => {
    const { runtime } = setup();

    expect(runtime.loadState).toBe("ready");
    expect(runtime.persistenceEnabled).toBe(false);
    expect(runtime.keyManager).toBeInstanceOf(KeyManager);
    expect(runtime.identity.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(runtime.status).toBe("idle");
    expect(runtime.locked).toBe(false);
    expect(runtime.startupProgress).toMatchObject({ phase: "idle", percent: 0, label: "Ready to start" });
  });

  test("prompts when a key is persisted, with no identity available yet", async () => {
    const keyStorage = memoryKeyStorage();
    await keyStorage.save(KeyManager.generate().getSecretKeyBytes(), "pass");

    const { runtime } = setup({ keyStorage });

    expect(runtime.loadState).toBe("prompting");
    expect(runtime.persistenceEnabled).toBe(true);
    expect(runtime.keyManager).toBeNull();
    expect(() => runtime.identity).toThrow("Coordinator key is not loaded");
  });

  test("defaults to production dependencies and global key storage", () => {
    const runtime = new CoordinatorRuntime({ config: createTestConfig() });

    expect(runtime.loadState).toBe("ready");
    expect(runtime.createHostedRoomClient({ coordinatorPubkey: runtime.identity.publicKeyHex, relayUrls: [] })).toBeNull();
  });
});

describe("subscribe and getSnapshot", () => {
  test("publishes a new immutable snapshot and calls listeners synchronously on change", () => {
    const { runtime } = setup();
    const before = runtime.getSnapshot();
    const seen: string[] = [];
    runtime.subscribe(() => seen.push(runtime.getSnapshot().passphraseError ?? "none"));
    expect(runtime.getSnapshot()).toBe(before);

    runtime.generateFreshKey();

    expect(seen.length).toBeGreaterThan(0);
    const after = runtime.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.keyManager).not.toBe(before.keyManager);
    expect(before.debugLog).toEqual([]);
    expect(after.debugLog).toHaveLength(1);
  });

  test("reading never changes snapshot identity", () => {
    const { runtime } = setup();
    const snapshot = runtime.getSnapshot();

    void runtime.status;
    void runtime.identity;
    void runtime.restartRequired;
    void runtime.exhaustedRoomRecoveryTarget;

    expect(runtime.getSnapshot()).toBe(snapshot);
  });

  test.each([
    ["dismissError", (runtime: CoordinatorRuntime) => runtime.dismissError()],
    ["clearPersistenceError", (runtime: CoordinatorRuntime) => runtime.clearPersistenceError()],
    ["clearDebugLog", (runtime: CoordinatorRuntime) => runtime.clearDebugLog()],
  ])("%s with nothing to clear keeps the snapshot and notifies nobody", (_name, act) => {
    const { runtime } = setup();
    const listener = vi.fn();
    runtime.subscribe(listener);
    const snapshot = runtime.getSnapshot();

    act(runtime);

    expect(runtime.getSnapshot()).toBe(snapshot);
    expect(listener).not.toHaveBeenCalled();
  });

  test("clearing real state does notify", async () => {
    const { runtime } = setup();
    await runtime.enablePersistence("", "");
    runtime.generateFreshKey();
    const listener = vi.fn();
    runtime.subscribe(listener);

    runtime.clearPersistenceError();
    runtime.clearDebugLog();

    expect(runtime.persistenceError).toBeNull();
    expect(runtime.debugLog).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("unsubscribe stops notifications and leaves other listeners alone", () => {
    const { runtime } = setup();
    const removed = vi.fn();
    const kept = vi.fn();
    const unsubscribe = runtime.subscribe(removed);
    runtime.subscribe(kept);

    unsubscribe();
    unsubscribe();
    runtime.generateFreshKey();

    expect(removed).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalled();
  });

  test("a listener may unsubscribe itself while being notified", () => {
    const { runtime } = setup();
    const second = vi.fn();
    const unsubscribe = runtime.subscribe(() => unsubscribe());
    runtime.subscribe(second);

    runtime.generateFreshKey();

    expect(second).toHaveBeenCalled();
  });
});

describe("unlocking a persisted identity", () => {
  async function persisted() {
    const keyStorage = memoryKeyStorage();
    const manager = KeyManager.generate();
    await keyStorage.save(manager.getSecretKeyBytes(), "correct horse");
    return { keyStorage, manager };
  }

  test("the right passphrase restores the identity, wipes the loaded bytes and logs only public data", async () => {
    const { keyStorage, manager } = await persisted();
    const load = vi.spyOn(keyStorage, "load");
    const { runtime } = setup({ keyStorage });

    await runtime.loadFromPassphrase("correct horse");

    expect(runtime.loadState).toBe("ready");
    expect(runtime.persistenceEnabled).toBe(true);
    expect(runtime.passphraseError).toBeNull();
    expect(runtime.identity.publicKeyHex).toBe(manager.identity.publicKeyHex);
    expect(logEntry(runtime, "persisted identity unlocked")?.details).toBe(manager.identity.npub);
    const loaded = await load.mock.results[0]!.value as Uint8Array;
    expect(loaded.every((byte) => byte === 0)).toBe(true);
    const log = JSON.stringify(runtime.debugLog);
    expect(log).not.toContain("correct horse");
    expect(log).not.toContain(manager.getSecretKeyHex());
  });

  test("the wrong passphrase stays locked with a retryable error", async () => {
    const { keyStorage } = await persisted();
    const { runtime } = setup({ keyStorage });

    await runtime.loadFromPassphrase("wrong");

    expect(runtime.loadState).toBe("prompting");
    expect(runtime.keyManager).toBeNull();
    expect(runtime.passphraseError).toBe("Wrong passphrase");
    expect(logEntry(runtime, "persisted identity unlock failed")).toMatchObject({ level: "warn", details: "Wrong passphrase" });

    await runtime.loadFromPassphrase("correct horse");
    expect(runtime.passphraseError).toBeNull();
    expect(runtime.loadState).toBe("ready");
  });

  test("an unexpected failure does not expose its reason", async () => {
    const keyStorage = memoryKeyStorage();
    vi.spyOn(keyStorage, "hasPersisted").mockReturnValue(true);
    vi.spyOn(keyStorage, "load").mockRejectedValue(new Error("storage secret detail"));
    const { runtime } = setup({ keyStorage });

    await runtime.loadFromPassphrase("x");

    expect(runtime.passphraseError).toBe("Could not unlock persisted key");
    expect(JSON.stringify(runtime.debugLog)).not.toContain("storage secret detail");
  });

  test("generateFreshKey abandons the persisted key and leaves prompt mode", async () => {
    const { keyStorage } = await persisted();
    const { runtime } = setup({ keyStorage });
    await runtime.loadFromPassphrase("wrong");

    runtime.generateFreshKey();

    expect(keyStorage.hasPersisted()).toBe(false);
    expect(runtime.loadState).toBe("ready");
    expect(runtime.persistenceEnabled).toBe(false);
    expect(runtime.passphraseError).toBeNull();
    expect(logEntry(runtime, "fresh identity generated")?.details).toBe(runtime.identity.npub);
  });
});

describe("persistence", () => {
  test("rejects an empty passphrase", async () => {
    const { runtime, keyStorage } = setup();

    await expect(runtime.enablePersistence("", "")).resolves.toBe(false);

    expect(runtime.persistenceError).toBe("Passphrase is required");
    expect(keyStorage.hasPersisted()).toBe(false);
  });

  test("rejects mismatched passphrases", async () => {
    const { runtime, keyStorage } = setup();

    await expect(runtime.enablePersistence("one", "two")).resolves.toBe(false);

    expect(runtime.persistenceError).toBe("Passphrases do not match");
    expect(keyStorage.hasPersisted()).toBe(false);
  });

  test("saves the key, clears a previous error and wipes the temporary key copy", async () => {
    const { runtime, keyStorage } = setup();
    await runtime.enablePersistence("", "");
    const save = vi.spyOn(keyStorage, "save");

    await expect(runtime.enablePersistence("pass", "pass")).resolves.toBe(true);

    expect(runtime.persistenceError).toBeNull();
    expect(runtime.persistenceEnabled).toBe(true);
    expect(keyStorage.hasPersisted()).toBe(true);
    expect(save.mock.calls[0]![0].every((byte) => byte === 0)).toBe(true);
    expect(messages(runtime)).toContain("encrypted persistence enabled");
    expect(JSON.stringify(runtime.debugLog)).not.toContain("pass\"");
  });

  test("a failed save reports an error and wipes the temporary key copy", async () => {
    const { runtime, keyStorage } = setup();
    const save = vi.spyOn(keyStorage, "save").mockRejectedValue(new DOMException("full", "QuotaExceededError"));

    await expect(runtime.enablePersistence("pass", "pass")).resolves.toBe(false);

    expect(runtime.persistenceEnabled).toBe(false);
    expect(runtime.persistenceError).toBe("Could not save persisted key");
    expect(save.mock.calls[0]![0].every((byte) => byte === 0)).toBe(true);
  });

  test("cannot enable persistence without a loaded key", async () => {
    const keyStorage = memoryKeyStorage();
    vi.spyOn(keyStorage, "hasPersisted").mockReturnValue(true);
    const { runtime } = setup({ keyStorage });

    await expect(runtime.enablePersistence("pass", "pass")).rejects.toThrow("Coordinator key is not loaded");
  });

  test("disabling removes the key and persisted coordinator state", async () => {
    const { runtime, keyStorage } = setup();
    await runtime.enablePersistence("pass", "pass");
    await runtime.enablePersistence("", "");

    await runtime.disablePersistence();

    expect(keyStorage.hasPersisted()).toBe(false);
    expect(clearPersisted).toHaveBeenCalledOnce();
    expect(runtime.persistenceEnabled).toBe(false);
    expect(runtime.persistenceError).toBeNull();
    expect(messages(runtime)).toContain("encrypted persistence disabled");
  });

  test("a failed state wipe does not leave persistence reported as enabled after the key is gone", async () => {
    const { runtime, keyStorage } = setup();
    await runtime.enablePersistence("pass", "pass");
    clearPersisted.mockRejectedValueOnce(new Error("sqlite busy"));

    await expect(runtime.disablePersistence()).rejects.toThrow("sqlite busy");

    expect(keyStorage.hasPersisted()).toBe(false);
    expect(runtime.persistenceEnabled).toBe(false);
  });
});

describe("exportCoordinatorKeyBackup", () => {
  async function enabled() {
    const context = setup();
    await context.runtime.enablePersistence("pass", "pass");
    return context;
  }

  function backupFor(publicKeyHex: string): CoordinatorKeyBackup {
    return { identity: { publicKeyHex, npub: "npub" } } as CoordinatorKeyBackup;
  }

  test("requires persistence to be enabled", async () => {
    const { runtime } = setup();

    await expect(runtime.exportCoordinatorKeyBackup("pass")).resolves.toBeNull();

    expect(runtime.persistenceError).toBe("Enable persistence before exporting this coordinator");
  });

  test("requires the key to still be persisted", async () => {
    const { runtime, keyStorage } = await enabled();
    keyStorage.clear();

    await expect(runtime.exportCoordinatorKeyBackup("pass")).resolves.toBeNull();

    expect(runtime.persistenceError).toBe("Enable persistence before exporting this coordinator");
  });

  test("requires a passphrase", async () => {
    const { runtime } = await enabled();

    await expect(runtime.exportCoordinatorKeyBackup("")).resolves.toBeNull();

    expect(runtime.persistenceError).toBe("Passphrase is required");
  });

  test("returns the encrypted backup for the matching identity", async () => {
    const { runtime } = await enabled();

    const backup = await runtime.exportCoordinatorKeyBackup("pass");

    expect(backup?.identity.publicKeyHex).toBe(runtime.identity.publicKeyHex);
    expect(runtime.persistenceError).toBeNull();
    expect(messages(runtime)).toContain("encrypted coordinator backup exported");
  });

  test("reports a wrong passphrase", async () => {
    const { runtime, keyStorage } = await enabled();
    vi.spyOn(keyStorage, "exportBackup").mockRejectedValue(new WrongPassphraseError());

    await expect(runtime.exportCoordinatorKeyBackup("nope")).resolves.toBeNull();

    expect(runtime.persistenceError).toBe("Wrong passphrase");
    expect(logEntry(runtime, "encrypted coordinator export failed")).toMatchObject({ level: "warn", details: "Wrong passphrase" });
  });

  test("hides an unexpected failure", async () => {
    const { runtime, keyStorage } = await enabled();
    vi.spyOn(keyStorage, "exportBackup").mockRejectedValue(new Error("secret detail"));

    await expect(runtime.exportCoordinatorKeyBackup("pass")).resolves.toBeNull();

    expect(runtime.persistenceError).toBe("Could not export persisted key");
    expect(JSON.stringify(runtime.debugLog)).not.toContain("secret detail");
  });

  test("discards the export if persistence changed while it ran", async () => {
    const { runtime, keyStorage } = await enabled();
    vi.spyOn(keyStorage, "exportBackup").mockImplementation(async () => {
      const publicKeyHex = runtime.identity.publicKeyHex;
      runtime.generateFreshKey();
      return backupFor(publicKeyHex);
    });

    await expect(runtime.exportCoordinatorKeyBackup("pass")).resolves.toBeNull();

    expect(runtime.persistenceError).toBe("Persistence changed before the export completed");
    expect(logEntry(runtime, "encrypted coordinator export cancelled")?.level).toBe("warn");
  });

  test("discards the export if the persisted key is removed while persistence stays on", async () => {
    const { runtime, keyStorage } = await enabled();
    vi.spyOn(keyStorage, "exportBackup").mockImplementation(async () => {
      keyStorage.clear();
      return backupFor(runtime.identity.publicKeyHex);
    });

    await expect(runtime.exportCoordinatorKeyBackup("pass")).resolves.toBeNull();

    expect(runtime.persistenceError).toBe("Persistence changed before the export completed");
  });

  test("refuses a saved key belonging to a different coordinator", async () => {
    const { runtime, keyStorage } = await enabled();
    vi.spyOn(keyStorage, "exportBackup").mockResolvedValue(backupFor("f".repeat(64)));

    await expect(runtime.exportCoordinatorKeyBackup("pass")).resolves.toBeNull();

    expect(runtime.persistenceError).toBe("Saved key does not match this coordinator");
    expect(logEntry(runtime, "encrypted coordinator export rejected")?.level).toBe("warn");
  });
});

describe("profile publication", () => {
  test("setup saves locally before publishing, without touching runtime state", async () => {
    const { runtime, config, deps } = setup({ config: { isSetupComplete: false } });

    await expect(runtime.completeSetupAndPublish("  Host  ")).resolves.toEqual({ localSaved: true, published: true });

    expect(config.completeSetup).toHaveBeenCalledWith("  Host  ");
    expect(runtime.profilePublicationState).toBe("published");
    expect(deps.profilePublisher).toHaveBeenCalledWith(expect.objectContaining({
      name: config.coordinatorName,
      coordinatorPubkey: runtime.identity.publicKeyHex,
      relayUrls: config.inviteRelayUrls,
    }));
    expect(runtime.status).toBe("idle");
    expect(deps.acquireInstanceLease).not.toHaveBeenCalled();
  });

  test("the publisher receives key access, not the key", async () => {
    const { runtime, deps } = setup();

    await runtime.saveCoordinatorNameAndPublish("Host");

    const input = deps.profilePublisher.mock.calls[0]![0];
    const secret = input.getSecretKeyBytes();
    expect(secret).toEqual(runtime.keyManager!.getSecretKeyBytes());
    secret.fill(0);
    expect(input.getSecretKeyBytes().some((byte) => byte !== 0)).toBe(true);
  });

  test.each([
    ["completeSetupAndPublish", "completeSetup"],
    ["saveCoordinatorNameAndPublish", "setCoordinatorName"],
  ] as const)("%s reports a rejected save without publishing", async (method, configMethod) => {
    const { runtime, deps } = setup({ config: { [configMethod]: vi.fn(() => false) } });

    await expect(runtime[method]("bad")).resolves.toEqual({ localSaved: false, published: false });

    expect(runtime.profilePublicationState).toBe("idle");
    expect(deps.profilePublisher).not.toHaveBeenCalled();
  });

  test("a failed publication keeps the local save, is retryable and logs no failure details", async () => {
    const secretDetail = "synthetic-secret bunker://relay.example";
    const { runtime, deps } = setup();
    const identity = runtime.identity.publicKeyHex;
    deps.profilePublisher.mockRejectedValueOnce(new Error(secretDetail));

    await expect(runtime.saveCoordinatorNameAndPublish("Host")).resolves.toEqual({ localSaved: true, published: false });

    expect(runtime.profilePublicationState).toBe("failed");
    expect(logEntry(runtime, "coordinator profile publication failed")?.level).toBe("warn");
    expect(JSON.stringify(runtime.debugLog)).not.toContain(secretDetail);

    await expect(runtime.retryCoordinatorProfilePublication()).resolves.toEqual({ localSaved: true, published: true });
    expect(runtime.profilePublicationState).toBe("published");
    expect(runtime.identity.publicKeyHex).toBe(identity);
  });

  test("a synchronously throwing publisher is reported the same way", async () => {
    const { runtime, deps } = setup();
    deps.profilePublisher.mockImplementationOnce(() => { throw new Error("boom"); });

    await expect(runtime.retryCoordinatorProfilePublication()).resolves.toEqual({ localSaved: true, published: false });
  });

  test("retry refuses before setup completes", async () => {
    const { runtime, deps } = setup({ config: { isSetupComplete: false } });

    await expect(runtime.retryCoordinatorProfilePublication()).resolves.toEqual({ localSaved: false, published: false });

    expect(deps.profilePublisher).not.toHaveBeenCalled();
  });

  test("publishing requires a loaded key", async () => {
    const keyStorage = memoryKeyStorage();
    vi.spyOn(keyStorage, "hasPersisted").mockReturnValue(true);
    const { runtime } = setup({ keyStorage });

    expect(() => runtime.retryCoordinatorProfilePublication()).toThrow("Coordinator key is not loaded");
    expect(runtime.profilePublicationState).toBe("idle");
  });

  test("duplicate activation shares one publication and reports publishing meanwhile", async () => {
    const pending = deferred<unknown>();
    const { runtime, deps } = setup();
    deps.profilePublisher.mockImplementationOnce(() => pending.promise);

    const first = runtime.saveCoordinatorNameAndPublish("Host");
    const duplicate = runtime.retryCoordinatorProfilePublication();
    expect(runtime.profilePublicationState).toBe("publishing");
    pending.resolve(undefined);

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { localSaved: true, published: true },
      { localSaved: true, published: true },
    ]);
    expect(deps.profilePublisher).toHaveBeenCalledOnce();
  });

  test("a publication can run again once the previous one finished", async () => {
    const { runtime, deps } = setup();

    await runtime.retryCoordinatorProfilePublication();
    await runtime.retryCoordinatorProfilePublication();

    expect(deps.profilePublisher).toHaveBeenCalledTimes(2);
  });

  test("a rename during publication is published afterwards rather than silently dropped", async () => {
    const pending = deferred<unknown>();
    const config = createTestConfig();
    const names = { current: "First" };
    Object.defineProperty(config, "coordinatorName", { get: () => names.current });
    const { deps: rawDeps } = createRuntimeDeps();
    const deps = rawDeps as unknown as MockedDeps;
    deps.profilePublisher.mockImplementationOnce(() => pending.promise);
    const runtime = new CoordinatorRuntime({ config, deps, keyStorage: memoryKeyStorage() });

    const first = runtime.saveCoordinatorNameAndPublish("First");
    await flush();
    names.current = "Second";
    const second = runtime.saveCoordinatorNameAndPublish("Second");
    names.current = "Third";
    const third = runtime.saveCoordinatorNameAndPublish("Third");
    pending.resolve(undefined);
    await Promise.all([first, second, third]);

    expect(deps.profilePublisher.mock.calls.map((call) => call[0].name)).toEqual(["First", "Third"]);
    expect(runtime.profilePublicationState).toBe("published");
  });

  test("destroy resets publication state and ignores a publication still running for the old identity", async () => {
    const pending = deferred<unknown>();
    const { runtime, deps } = setup();
    deps.profilePublisher.mockImplementationOnce(() => pending.promise);

    const stale = runtime.retryCoordinatorProfilePublication();
    await flush();
    await runtime.destroy();
    expect(runtime.profilePublicationState).toBe("idle");

    await runtime.retryCoordinatorProfilePublication();
    expect(deps.profilePublisher).toHaveBeenCalledTimes(2);
    expect(deps.profilePublisher.mock.calls[1]![0].coordinatorPubkey).toBe(runtime.identity.publicKeyHex);
    expect(runtime.profilePublicationState).toBe("published");
    runtime.clearDebugLog();

    pending.reject(new Error("old identity failed"));
    await expect(stale).resolves.toEqual({ localSaved: true, published: false });
    expect(runtime.profilePublicationState).toBe("published");
    expect(runtime.debugLog).toEqual([]);
  });

  test("a publication for the old identity that succeeds after destroy does not report published", async () => {
    const pending = deferred<unknown>();
    const { runtime, deps } = setup();
    deps.profilePublisher.mockImplementationOnce(() => pending.promise);

    const stale = runtime.retryCoordinatorProfilePublication();
    await flush();
    await runtime.destroy();

    pending.resolve(undefined);
    await expect(stale).resolves.toEqual({ localSaved: true, published: true });
    expect(runtime.profilePublicationState).toBe("idle");
  });

  test("destroy also resets a finished publication state", async () => {
    const { runtime } = setup();
    await runtime.retryCoordinatorProfilePublication();

    await runtime.destroy();

    expect(runtime.profilePublicationState).toBe("idle");
  });
});

describe("startup", () => {
  test("refuses incomplete setup before every side effect", async () => {
    const { runtime, deps, config } = setup({ config: { isSetupComplete: false } });

    await expect(runtime.start()).rejects.toThrow("Complete coordinator setup before starting.");

    expect(runtime.status).toBe("idle");
    expect(runtime.error).toBeNull();
    expect(runtime.debugLog).toEqual([]);
    expect(runtime.relayStatuses).toEqual({});
    expect(config.lock).not.toHaveBeenCalled();
    expect(deps.acquireInstanceLease).not.toHaveBeenCalled();
  });

  test("runs through locked config, lease, transport and monitor to running", async () => {
    const { runtime, deps, config, leases, transports } = setup();
    const statuses: string[] = [];
    runtime.subscribe(() => {
      if (statuses.at(-1) !== runtime.status) statuses.push(runtime.status);
    });

    await runtime.start();

    expect(statuses).toEqual(["starting", "running"]);
    expect(config.lock).toHaveBeenCalledOnce();
    expect(deps.acquireInstanceLease).toHaveBeenCalledWith(expect.objectContaining({
      publicKeyHex: runtime.identity.publicKeyHex,
      relayUrls: config.enabledRelayUrls,
    }));
    expect(deps.createTransport).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      config.enabledRelayUrls,
      config.coordinatorOptions,
      false,
      expect.any(Object),
    );
    expect(deps.startResourceMonitor).toHaveBeenCalledWith(transports[0]);
    expect(leases[0]!.release).not.toHaveBeenCalled();
    expect(runtime.locked).toBe(true);
    expect(runtime.relayStatuses).toEqual({ "wss://relay.example": "connected" });
    expect(runtime.appliedConfigRevision).toBe(1);
    expect(logEntry(runtime, "coordinator start requested")?.details).toBe("1 enabled relays");
    expect(logEntry(runtime, "coordinator started")?.details).toBe(runtime.identity.npub);
  });

  test("the lease and transport see the same identity and the lease can read the key", async () => {
    const { runtime, deps } = setup();

    await runtime.start();

    const input = deps.acquireInstanceLease.mock.calls[0]![0];
    expect(input.getSecretKeyBytes()).toEqual(runtime.keyManager!.getSecretKeyBytes());
    input.debug?.("warn", "guard message", "guard details");
    input.debug?.("info", "guard message without details");
    expect(logEntry(runtime, "guard message")).toMatchObject({ level: "warn", details: "guard details" });
    expect(logEntry(runtime, "guard message without details")?.details).toBeUndefined();
  });

  test("concurrent start calls share one transaction", async () => {
    const { runtime, deps } = setup();

    await Promise.all([runtime.start(), runtime.start()]);

    expect(deps.acquireInstanceLease).toHaveBeenCalledOnce();
    expect(deps.createTransport).toHaveBeenCalledOnce();
  });

  test("marks every enabled relay connecting then connected", async () => {
    const urls = ["wss://one.example", "wss://two.example"];
    const pending = deferred<RunningTransport>();
    const { runtime } = setup({
      config: { enabledRelayUrls: urls },
      deps: { createTransport: vi.fn(() => pending.promise) },
    });

    const started = runtime.start();
    await flush();
    expect(runtime.relayStatuses).toEqual({ "wss://one.example": "connecting", "wss://two.example": "connecting" });

    pending.resolve(createFakeTransport());
    await started;
    expect(runtime.relayStatuses).toEqual({ "wss://one.example": "connected", "wss://two.example": "connected" });
  });

  test("starting from a persisted identity opens persistent storage", async () => {
    const { runtime, deps } = setup();
    await runtime.enablePersistence("pass", "pass");

    await runtime.start();

    expect(deps.createTransport.mock.calls[0]![3]).toBe(true);
  });

  test.each([
    ["an Error", new Error("relay refused"), "relay refused"],
    ["a non-Error", "plain", "Coordinator startup failed"],
  ])("cleans up and reports when the transport fails with %s", async (_label, thrown, message) => {
    const { runtime, deps, leases } = setup({
      deps: { createTransport: vi.fn(async () => { throw thrown; }) },
    });

    await runtime.start();

    expect(runtime.status).toBe("idle");
    expect(runtime.error).toBe(message);
    expect(runtime.startupProgress).toMatchObject({ phase: "failed", detail: message, label: "Startup interrupted" });
    expect(runtime.relayStatuses).toEqual({ "wss://relay.example": "error" });
    expect(leases[0]!.release).toHaveBeenCalledOnce();
    expect(deps.closeTransport).not.toHaveBeenCalled();
    expect(deps.stopResourceMonitor).toHaveBeenCalled();
    expect(logEntry(runtime, "coordinator startup failed")).toMatchObject({ level: "error", details: message });
    expect(runtime.locked).toBe(false);

    runtime.dismissError();
    expect(runtime.error).toBeNull();
  });

  test("an already-running instance is a warning rather than an error", async () => {
    const { runtime, deps } = setup({
      deps: { acquireInstanceLease: vi.fn(async () => { throw new Error(INSTANCE_RUNNING_MESSAGE); }) },
    });

    await runtime.start();

    expect(runtime.error).toBe(INSTANCE_RUNNING_MESSAGE);
    expect(logEntry(runtime, INSTANCE_RUNNING_MESSAGE)?.level).toBe("warn");
    expect(messages(runtime)).not.toContain("coordinator startup failed");
    expect(deps.createTransport).not.toHaveBeenCalled();
  });

  test("starting locked fails cleanly rather than leaving the coordinator stuck", async () => {
    const keyStorage = memoryKeyStorage();
    vi.spyOn(keyStorage, "hasPersisted").mockReturnValue(true);
    const { runtime } = setup({ keyStorage });

    await runtime.start();

    expect(runtime.status).toBe("idle");
    expect(runtime.error).toBe("Coordinator key is not loaded");
  });

  test("can start again after a failed start", async () => {
    const { runtime, deps } = setup();
    deps.createTransport.mockRejectedValueOnce(new Error("relay refused"));

    await runtime.start();
    await runtime.start();

    expect(runtime.status).toBe("running");
    expect(runtime.error).toBeNull();
  });

  test("a closeTransport failure during a failed startup still releases the lease and reaches idle", async () => {
    const { runtime, leases } = setup({
      deps: { closeTransport: vi.fn(() => { throw new Error("close failed"); }) },
    });
    runtime.registerHostedRoomRecovery({
      listTargets: () => { throw new Error("room list unavailable"); },
      recover: async () => undefined,
    });

    await runtime.start();

    expect(runtime.status).toBe("idle");
    expect(runtime.error).toBe("room list unavailable");
    expect(leases[0]!.release).toHaveBeenCalledOnce();
    expect(logEntry(runtime, "coordinator cleanup failed")).toMatchObject({ level: "warn", details: "close failed" });
  });

  test("a redundant start rejects without disturbing a running coordinator", async () => {
    const { runtime, deps, leases } = setup();
    await runtime.start();

    await expect(runtime.start()).rejects.toThrow("Invalid coordinator transition: running -> start");

    expect(runtime.status).toBe("running");
    expect(deps.acquireInstanceLease).toHaveBeenCalledOnce();

    // The page-unload release must still belong to the running generation.
    window.dispatchEvent(new Event("pagehide"));
    expect(leases[0]!.release).toHaveBeenCalledOnce();
    await runtime.stop();
  });

  test("start immediately followed by stop on a running coordinator stops it instead of wedging", async () => {
    const { runtime, transports } = setup();
    await runtime.start();

    const redundant = runtime.start();
    const stopped = runtime.stop();

    await expect(redundant).rejects.toThrow("Invalid coordinator transition");
    await expect(stopped).resolves.toBeUndefined();
    expect(runtime.status).toBe("idle");
    expect(transports[0]!.close).toHaveBeenCalledOnce();
    await expect(runtime.start()).resolves.toBeUndefined();
    expect(runtime.status).toBe("running");
  });

  test("a redundant start keeps exhausted recovery state available", async () => {
    const { runtime } = setup();
    runtime.registerHostedRoomRecovery({
      listTargets: () => [targetA],
      recover: async () => { throw new Error("offline"); },
    });
    await runtime.start();
    expect(runtime.exhaustedRoomRecoveryTarget).toEqual(targetA);

    await expect(runtime.start()).rejects.toThrow("Invalid coordinator transition: starting -> start");

    expect(runtime.exhaustedRoomRecoveryTarget).toEqual(targetA);
    await runtime.stop();
  });

  test("a stop right after a startup that rejected synchronously still recovers", async () => {
    const lock = vi.fn(() => { throw new Error("config locked elsewhere"); });
    const { runtime } = setup({ config: { lock } });

    const started = runtime.start();
    const stopped = runtime.stop();

    await expect(started).rejects.toThrow("config locked elsewhere");
    await expect(stopped).resolves.toBeUndefined();
    expect(runtime.status).toBe("idle");
  });
});

describe("diagnostics", () => {
  async function diagnosticsFor(context = setup()): Promise<{ diagnostics: TransportDiagnostics; runtime: CoordinatorRuntime }> {
    await context.runtime.start();
    return { diagnostics: context.deps.createTransport.mock.calls[0]![4]!, runtime: context.runtime };
  }

  const longHex = `${"1".repeat(8)}${"0".repeat(48)}${"2".repeat(8)}`;
  const shortHex = "abcd";

  test("startup phases reach progress with the correct copy", async () => {
    const seen: Array<[string, string, number]> = [];
    const { runtime } = setup({
      config: { enabledRelayUrls: ["wss://one.example", "wss://two.example"] },
      deps: {
        createTransport: vi.fn(async (_key, _relays, _options, _persistent, diagnostics) => {
          for (const phase of ["opening-storage", "preparing-runtime", "connecting-relays"] as const) {
            diagnostics!.onStartupPhase!({ phase });
            const progress = runtime.startupProgress;
            seen.push([progress.phase, progress.detail, progress.percent]);
          }
          return createFakeTransport();
        }),
      },
    });

    await runtime.start();

    expect(seen).toEqual([
      ["opening-storage", "Preparing temporary room state for this session.", 40],
      ["preparing-runtime", "Registering encrypted room coordination methods.", 60],
      ["connecting-relays", "Opening 2 configured relay paths.", 80],
    ]);
  });

  test("copy adapts to persistence and to a single relay", async () => {
    const context = setup();
    await context.runtime.enablePersistence("pass", "pass");
    const { diagnostics, runtime } = await diagnosticsFor(context);

    diagnostics.onStartupPhase!({ phase: "opening-storage" });
    expect(runtime.startupProgress.detail).toBe("Loading encrypted room state from this device.");
    diagnostics.onStartupPhase!({ phase: "connecting-relays" });
    expect(runtime.startupProgress.detail).toBe("Opening 1 configured relay path.");
  });

  test.each([
    ["onNostrEvent", (d: TransportDiagnostics) => d.onNostrEvent!({ summary: "kind=1" }), "raw nostr event received", "info", "kind=1"],
    ["onInboundMessage", (d: TransportDiagnostics) => d.onInboundMessage!({ method: "m", clientPubkey: longHex, summary: "s" }), "decoded client request", "info", "m from 11111111...22222222 s"],
    ["onNostrPublish attempt", (d: TransportDiagnostics) => d.onNostrPublish!({ phase: "attempt", summary: "s" }), "publishing nostr response event", "info", "s"],
    ["onNostrPublish accepted", (d: TransportDiagnostics) => d.onNostrPublish!({ phase: "accepted", summary: "s" }), "nostr response event accepted", "info", "s"],
    ["onOutboundMessage", (d: TransportDiagnostics) => d.onOutboundMessage!({ type: "t", summary: "s" }), "outbound coordinator response", "info", "t s"],
    ["onOutboundMessage error", (d: TransportDiagnostics) => d.onOutboundMessage!({ type: "t", summary: "s", error: "e" }), "outbound coordinator response", "warn", "t: e s"],
    ["onOutboundError", (d: TransportDiagnostics) => d.onOutboundError!(new Error("boom")), "nostr transport error", "error", "boom"],
    ["onClosed", (d: TransportDiagnostics) => d.onClosed!(), "nostr transport closed", "info", undefined],
    ["onStarted", (d: TransportDiagnostics) => d.onStarted!({ publicKeyHex: shortHex, relayUrls: ["a", "b"] }), "nostr transport subscribed", "info", "2 relays for abcd"],
  ] satisfies Array<[string, (d: TransportDiagnostics) => void, string, string, string | undefined]>)(
    "%s reaches the debug log",
    async (_name, emit, message, level, details) => {
      const { diagnostics, runtime } = await diagnosticsFor();
      runtime.clearDebugLog();

      emit(diagnostics);

      expect(runtime.debugLog).toHaveLength(1);
      expect(runtime.debugLog[0]).toMatchObject({ message, level, details });
    },
  );

  test.each([
    ["accepted", "info"],
    ["rejected", "info"],
    ["failed", "warn"],
    ["aborted", "warn"],
  ] as const)("relay publish outcome %s is logged at %s", async (outcome, level) => {
    const { diagnostics, runtime } = await diagnosticsFor();

    diagnostics.onRelayPublish!({
      relayUrl: "wss://relay.example",
      eventId: longHex,
      eventKind: 1059,
      operation: "publish",
      attempt: 2,
      elapsedMs: 15,
      outcome,
    } as never);

    expect(logEntry(runtime, `relay publish ${outcome}`)).toMatchObject({
      level,
      details: "publish relay=wss://relay.example event=11111111...22222222 kind=1059 attempt=2 elapsed=15ms",
    });
  });

  test("stale startup callbacks do not move a stopped coordinator", async () => {
    const pending = deferred<RunningTransport>();
    let diagnostics!: TransportDiagnostics;
    const { runtime } = setup({
      deps: {
        createTransport: vi.fn((_key, _relays, _options, _persistent, received) => {
          diagnostics = received!;
          return pending.promise;
        }),
      },
    });
    const started = runtime.start();
    await flush();
    const stopped = runtime.stop();
    const progress = runtime.startupProgress;

    diagnostics.onStartupPhase!({ phase: "preparing-runtime" });
    diagnostics.onStarted!({ publicKeyHex: shortHex, relayUrls: [] });

    expect(runtime.startupProgress).toBe(progress);
    expect(messages(runtime)).not.toContain("nostr transport subscribed");
    pending.resolve(createFakeTransport());
    await Promise.all([started, stopped]);
  });

  test("the debug log is capped at the 80 newest entries", async () => {
    const { diagnostics, runtime } = await diagnosticsFor();
    runtime.clearDebugLog();

    for (let index = 0; index < 85; index += 1) diagnostics.onNostrEvent!({ summary: String(index) });

    expect(runtime.debugLog).toHaveLength(80);
    expect(runtime.debugLog[0]!.details).toBe("5");
    expect(runtime.debugLog.at(-1)!.details).toBe("84");
    expect(new Set(runtime.debugLog.map((entry) => entry.id)).size).toBe(80);
  });

  test("entries have a timestamp and a 24-hour label", async () => {
    const { runtime } = setup();
    vi.useFakeTimers({ now: new Date(2026, 0, 2, 15, 4, 5).getTime() });

    runtime.generateFreshKey();

    expect(runtime.debugLog[0]).toMatchObject({ timestamp: Date.now(), timeLabel: "15:04:05" });
  });
});

describe("generation ownership", () => {
  test("stop while acquiring the lease releases the late lease and creates no transport", async () => {
    const pending = deferred<InstanceLease>();
    const { runtime, deps } = setup({ deps: { acquireInstanceLease: vi.fn(() => pending.promise) } });
    const release = vi.fn(async () => undefined);

    const started = runtime.start();
    const stopped = runtime.stop();
    pending.resolve({ release });
    await Promise.all([started, stopped]);

    expect(runtime.status).toBe("idle");
    expect(release).toHaveBeenCalledOnce();
    expect(deps.createTransport).not.toHaveBeenCalled();
    expect(deps.startResourceMonitor).not.toHaveBeenCalled();
    expect(runtime.startupProgress.phase).toBe("idle");
    expect(runtime.relayStatuses).toEqual({});
  });

  test("a lease failure after stop is not reported as an error", async () => {
    const pending = deferred<InstanceLease>();
    const { runtime } = setup({ deps: { acquireInstanceLease: vi.fn(() => pending.promise) } });

    const started = runtime.start();
    const stopped = runtime.stop();
    pending.reject(new Error("too late"));
    await Promise.all([started, stopped]);

    expect(runtime.status).toBe("idle");
    expect(runtime.error).toBeNull();
    expect(messages(runtime)).not.toContain("coordinator startup failed");
  });

  test("stop while creating the transport closes the late transport and retains nothing", async () => {
    const pending = deferred<RunningTransport>();
    const { runtime, deps, leases } = setup({ deps: { createTransport: vi.fn(() => pending.promise) } });
    const transport = createFakeTransport();

    const started = runtime.start();
    await flush();
    const stopped = runtime.stop();
    pending.resolve(transport);
    await Promise.all([started, stopped]);

    expect(deps.closeTransport).toHaveBeenCalledExactlyOnceWith(transport);
    expect(leases[0]!.release).toHaveBeenCalledOnce();
    expect(deps.startResourceMonitor).not.toHaveBeenCalled();
    expect(runtime.status).toBe("idle");
    expect(runtime.createHostedRoomClient({ coordinatorPubkey: runtime.identity.publicKeyHex, relayUrls: [] })).toBeNull();
  });

  test("a transport failure after stop is not reported as an error", async () => {
    const pending = deferred<RunningTransport>();
    const { runtime, leases } = setup({ deps: { createTransport: vi.fn(() => pending.promise) } });

    const started = runtime.start();
    await flush();
    const stopped = runtime.stop();
    pending.reject(new Error("too late"));
    await Promise.all([started, stopped]);

    expect(runtime.error).toBeNull();
    expect(leases[0]!.release).toHaveBeenCalledOnce();
  });

  test("stop while listing rooms closes the transport without attempting recovery", async () => {
    const pending = deferred<HostedRoomRecoveryTarget[]>();
    const recover = vi.fn(async () => undefined);
    const { runtime, transports, deps } = setup();
    runtime.registerHostedRoomRecovery({ listTargets: () => pending.promise, recover });

    const started = runtime.start();
    await flush();
    const stopped = runtime.stop();
    pending.resolve([targetA]);
    await Promise.all([started, stopped]);

    expect(recover).not.toHaveBeenCalled();
    expect(transports[0]!.close).toHaveBeenCalledOnce();
    expect(deps.startResourceMonitor).not.toHaveBeenCalled();
    expect(runtime.status).toBe("idle");
  });

  test("stop during the zero-room pause finishes without running", async () => {
    const pending = deferred();
    const { runtime, deps, transports } = setup({ deps: { wait: vi.fn(() => pending.promise) } });
    runtime.registerHostedRoomRecovery({ listTargets: () => [], recover: vi.fn() });

    const started = runtime.start();
    await flush();
    expect(deps.wait).toHaveBeenCalledWith(500, expect.any(AbortSignal));
    const stopped = runtime.stop();
    expect(deps.wait.mock.calls[0]![1].aborted).toBe(true);
    pending.resolve();
    await Promise.all([started, stopped]);

    expect(deps.startResourceMonitor).not.toHaveBeenCalled();
    expect(transports[0]!.close).toHaveBeenCalledOnce();
    expect(runtime.status).toBe("idle");
    expect(runtime.error).toBeNull();
  });

  test("a recovery that completes after stop is discarded", async () => {
    const pending = deferred();
    const discard = vi.fn(async () => undefined);
    const { runtime, deps } = setup();
    runtime.registerHostedRoomRecovery({ listTargets: () => [targetA], recover: () => pending.promise, discard });

    const started = runtime.start();
    await flush();
    const stopped = runtime.stop();
    pending.resolve();
    await Promise.all([started, stopped]);

    expect(discard).toHaveBeenCalledExactlyOnceWith(targetA);
    expect(deps.startResourceMonitor).not.toHaveBeenCalled();
    expect(runtime.status).toBe("idle");
  });

  test("a recovery that fails after stop is discarded and does not retry", async () => {
    const pending = deferred();
    const discard = vi.fn(async () => undefined);
    const recover = vi.fn(() => pending.promise);
    const { runtime, deps } = setup();
    runtime.registerHostedRoomRecovery({ listTargets: () => [targetA], recover, discard });

    const started = runtime.start();
    await flush();
    const stopped = runtime.stop();
    pending.reject(new Error("aborted"));
    await Promise.all([started, stopped]);

    expect(recover).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();
    expect(deps.wait).not.toHaveBeenCalled();
    expect(runtime.error).toBeNull();
  });

  test("stop during a retry delay does not start another attempt", async () => {
    const pending = deferred();
    const recover = vi.fn(async () => { throw new Error("offline"); });
    const { runtime, deps } = setup({ deps: { wait: vi.fn(() => pending.promise) } });
    runtime.registerHostedRoomRecovery({ listTargets: () => [targetA], recover });

    const started = runtime.start();
    await flush();
    const stopped = runtime.stop();
    pending.resolve();
    await Promise.all([started, stopped]);

    expect(recover).toHaveBeenCalledOnce();
    expect(deps.startResourceMonitor).not.toHaveBeenCalled();
    expect(runtime.status).toBe("idle");
  });

  test("restart awaits stale non-abortable recovery before the replacement owns resources", async () => {
    const stale = deferred();
    let recoverCalls = 0;
    const discard = vi.fn(async () => undefined);
    const { runtime, deps, transports, leases } = setup();
    runtime.registerHostedRoomRecovery({
      listTargets: () => [targetA],
      recover: async () => {
        recoverCalls += 1;
        if (recoverCalls === 1) await stale.promise;
      },
      discard,
    });

    const first = runtime.start();
    await flush();
    const restarting = runtime.restart();
    await flush();
    expect(deps.acquireInstanceLease).toHaveBeenCalledOnce();
    stale.resolve();
    await Promise.all([first, restarting]);

    expect(recoverCalls).toBe(2);
    expect(discard).toHaveBeenCalledOnce();
    expect(deps.closeTransport).toHaveBeenCalledExactlyOnceWith(transports[0]);
    expect(leases[0]!.release).toHaveBeenCalledOnce();
    expect(leases[1]!.release).not.toHaveBeenCalled();
    expect(deps.startResourceMonitor).toHaveBeenCalledExactlyOnceWith(transports[1]);
    expect(runtime.status).toBe("running");
    await runtime.stop();
  });
});

describe("stop and restart", () => {
  test("stops a running coordinator and releases everything", async () => {
    const { runtime, deps, leases, transports } = setup();
    await runtime.start();
    const statuses: string[] = [runtime.status];
    runtime.subscribe(() => {
      if (statuses.at(-1) !== runtime.status) statuses.push(runtime.status);
    });

    await runtime.stop();

    expect(statuses).toEqual(["running", "stopping", "idle"]);
    expect(deps.stopResourceMonitor).toHaveBeenCalled();
    expect(transports[0]!.close).toHaveBeenCalledOnce();
    expect(leases[0]!.release).toHaveBeenCalledOnce();
    expect(runtime.relayStatuses).toEqual({});
    expect(runtime.startupProgress.phase).toBe("idle");
    expect(messages(runtime)).toEqual(expect.arrayContaining(["coordinator stop requested", "coordinator stopped"]));
    expect(runtime.createHostedRoomClient({ coordinatorPubkey: runtime.identity.publicKeyHex, relayUrls: [] })).toBeNull();
  });

  test("concurrent stops share one shutdown; a later stop is a no-op", async () => {
    const { runtime, transports } = setup();
    await runtime.start();

    const first = runtime.stop();
    const second = runtime.stop();
    expect(second).toBe(first);
    await first;
    await runtime.stop();

    expect(transports[0]!.close).toHaveBeenCalledOnce();
  });

  test("stop while idle does nothing observable", async () => {
    const { runtime } = setup();
    const snapshot = runtime.getSnapshot();

    await runtime.stop();

    expect(runtime.getSnapshot()).toBe(snapshot);
  });

  test("a startup that fails on its own while stop waits keeps its own failure state", async () => {
    const pendingRelease = deferred();
    const { runtime } = setup({
      deps: {
        acquireInstanceLease: vi.fn(async () => ({ release: vi.fn(() => pendingRelease.promise) })),
        createTransport: vi.fn(async () => { throw new Error("relay refused"); }),
      },
    });

    const started = runtime.start();
    await flush();
    const stopped = runtime.stop();
    pendingRelease.resolve();
    await Promise.all([started, stopped]);

    expect(runtime.status).toBe("idle");
    expect(runtime.error).toBe("relay refused");
  });

  test.each([
    ["rejecting lease", {
      acquireInstanceLease: vi.fn(async () => ({ release: () => Promise.reject(new Error("lease stuck")) })),
    }, "lease stuck"],
    ["throwing closeTransport", {
      closeTransport: vi.fn(() => { throw new Error("close failed"); }),
    }, "close failed"],
  ] satisfies Array<[string, Partial<CoordinatorRuntimeDeps>, string]>)("a %s does not wedge shutdown in stopping", async (_label, deps, detail) => {
    const { runtime } = setup({ deps });
    await runtime.start();

    await expect(runtime.stop()).resolves.toBeUndefined();

    expect(runtime.status).toBe("idle");
    expect(logEntry(runtime, "coordinator cleanup failed")).toMatchObject({ level: "warn", details: detail });
    await expect(runtime.start()).resolves.toBeUndefined();
    expect(runtime.status).toBe("running");
  });

  test("a non-Error cleanup failure is still logged", async () => {
    const { runtime } = setup({
      deps: { closeTransport: vi.fn(() => { throw "close failed"; }) },
    });
    await runtime.start();

    await runtime.stop();

    expect(logEntry(runtime, "coordinator cleanup failed")?.details).toBe("close failed");
  });

  test("a closeTransport failure does not keep the lease", async () => {
    const { runtime, leases } = setup({
      deps: { closeTransport: vi.fn(() => { throw new Error("close failed"); }) },
    });
    await runtime.start();

    await runtime.stop();

    expect(leases[0]!.release).toHaveBeenCalledOnce();
    expect(runtime.createHostedRoomClient({ coordinatorPubkey: runtime.identity.publicKeyHex, relayUrls: [] })).toBeNull();
  });

  test("stopSync tears down resources directly", async () => {
    const { runtime, deps, transports, leases } = setup();
    await runtime.start();

    await runtime.stopSync();
    await runtime.stopSync();

    expect(transports[0]!.close).toHaveBeenCalledOnce();
    expect(leases[0]!.release).toHaveBeenCalledOnce();
    expect(deps.stopResourceMonitor).toHaveBeenCalledTimes(2);
    expect(runtime.createHostedRoomClient({ coordinatorPubkey: runtime.identity.publicKeyHex, relayUrls: [] })).toBeNull();
  });

  test("restart while idle or stopping does nothing", async () => {
    const pendingRelease = deferred();
    const { runtime, deps } = setup({
      deps: { acquireInstanceLease: vi.fn(async () => ({ release: () => pendingRelease.promise })) },
    });

    await runtime.restart();
    expect(deps.acquireInstanceLease).not.toHaveBeenCalled();

    await runtime.start();
    const stopped = runtime.stop();
    await flush();
    expect(runtime.status).toBe("stopping");
    await runtime.restart();
    expect(deps.acquireInstanceLease).toHaveBeenCalledOnce();
    pendingRelease.resolve();
    await stopped;
  });

  test("restart applies changed settings and clears restartRequired", async () => {
    const { runtime, config, deps, leases } = setup();
    expect(runtime.restartRequired).toBe(false);
    await runtime.start();
    expect(runtime.restartRequired).toBe(false);

    (config as { runtimeRevision: number }).runtimeRevision = 2;
    expect(runtime.restartRequired).toBe(true);

    await runtime.restart();

    expect(logEntry(runtime, "coordinator restart requested")?.details).toBe("applying updated settings");
    expect(deps.createTransport).toHaveBeenCalledTimes(2);
    expect(leases[0]!.release).toHaveBeenCalledOnce();
    expect(runtime.appliedConfigRevision).toBe(2);
    expect(runtime.restartRequired).toBe(false);
  });

  test("restartRequired is false until a running coordinator has applied a revision", async () => {
    const { runtime, config } = setup();
    (config as { runtimeRevision: number }).runtimeRevision = 3;
    expect(runtime.restartRequired).toBe(false);

    await runtime.start();
    await runtime.stop();
    (config as { runtimeRevision: number }).runtimeRevision = 4;

    expect(runtime.appliedConfigRevision).toBe(3);
    expect(runtime.restartRequired).toBe(false);
  });
});

describe("hosted room recovery", () => {
  function failingBravo(failures: number) {
    let attempts = 0;
    return vi.fn(async (target: HostedRoomRecoveryTarget) => {
      if (target.roomIdentityKey === targetB.roomIdentityKey) {
        attempts += 1;
        if (attempts <= failures) throw new Error("internal relay detail");
      }
    });
  }

  test("the policy outlives one connect plus one request window", () => {
    expect(ROOM_RECOVERY_POLICY.maxAttempts).toBe(3);
    expect(ROOM_RECOVERY_POLICY.attemptTimeoutMs).toHaveLength(3);
    expect(ROOM_RECOVERY_POLICY.retryDelayMs).toEqual([250, 750]);
  });

  test("no adapter means no rooms and no pause", async () => {
    const { runtime, deps } = setup();

    await runtime.start();

    expect(runtime.startupProgress.roomRecovery).toMatchObject({ state: "complete", completed: 0, total: 0 });
    expect(deps.wait).not.toHaveBeenCalled();
    expect(deps.runAttempt).not.toHaveBeenCalled();
  });

  test("an unregistered adapter is not used; a stale unregister does not remove a newer adapter", async () => {
    const { runtime } = setup();
    const older = { listTargets: vi.fn(() => []), recover: vi.fn() };
    const newer = { listTargets: vi.fn(() => []), recover: vi.fn() };

    const unregisterOlder = runtime.registerHostedRoomRecovery(older);
    const unregisterNewer = runtime.registerHostedRoomRecovery(newer);
    unregisterOlder();
    await runtime.start();
    expect(newer.listTargets).toHaveBeenCalledOnce();
    expect(older.listTargets).not.toHaveBeenCalled();
    await runtime.stop();

    unregisterNewer();
    await runtime.start();
    expect(newer.listTargets).toHaveBeenCalledOnce();
  });

  test("zero rooms pauses visibly at 0/0 before running", async () => {
    const pending = deferred();
    const { runtime, deps } = setup({ deps: { wait: vi.fn(() => pending.promise) } });
    runtime.registerHostedRoomRecovery({ listTargets: () => [], recover: vi.fn() });

    const started = runtime.start();
    await flush();
    expect(runtime.status).toBe("starting");
    expect(runtime.startupProgress).toMatchObject({
      phase: "restoring-rooms",
      roomRecovery: { state: "complete", completed: 0, total: 0, diagnostic: "No rooms to restore" },
    });
    pending.resolve();
    await started;

    expect(runtime.status).toBe("running");
    expect(deps.runAttempt).not.toHaveBeenCalled();
  });

  test("deduplicates targets, drops incomplete ones and restores in a stable order", async () => {
    const alpha = deferred();
    const bravo = deferred();
    const order: string[] = [];
    const { runtime, deps } = setup();
    runtime.registerHostedRoomRecovery({
      listTargets: async () => [
        targetB,
        targetA,
        { ...targetB, roomName: "Duplicate Bravo" },
        { ...targetA, roomIdentityKey: "" },
        { ...targetA, roomIdentityKey: "no-coordinator", coordinatorPubkey: "" },
        { ...targetA, roomIdentityKey: "no-id", roomId: "" },
        { ...targetA, roomIdentityKey: "no-name", roomName: "" },
      ],
      recover: async (target) => {
        order.push(target.roomIdentityKey);
        await (target.roomIdentityKey === targetA.roomIdentityKey ? alpha.promise : bravo.promise);
      },
    });

    const started = runtime.start();
    const shared = runtime.start();
    await vi.waitFor(() => expect(order).toEqual([targetA.roomIdentityKey]));
    expect(runtime.startupProgress).toMatchObject({
      phase: "restoring-rooms",
      detail: "Restoring # Alpha",
      roomRecovery: { state: "restoring", completed: 0, total: 2, roomName: "Alpha", attempt: 1 },
    });
    alpha.resolve();
    await vi.waitFor(() => expect(order).toHaveLength(2));
    expect(runtime.startupProgress.roomRecovery).toMatchObject({ completed: 1, total: 2, roomName: "Duplicate Bravo" });
    bravo.resolve();
    await Promise.all([started, shared]);

    expect(deps.runAttempt.mock.calls.map((call) => call[1])).toEqual([
      ROOM_RECOVERY_POLICY.attemptTimeoutMs[0],
      ROOM_RECOVERY_POLICY.attemptTimeoutMs[0],
    ]);
    expect(runtime.status).toBe("running");
    expect(runtime.startupProgress).toMatchObject({
      phase: "online",
      percent: 100,
      roomRecovery: { state: "complete", completed: 2, total: 2, roomName: null },
    });
  });

  test("retries with increasing deadlines and succeeds on a later attempt, discarding failures", async () => {
    const discard = vi.fn();
    const recover = failingBravo(2);
    const seenProgress: string[] = [];
    const { runtime, deps } = setup({
      deps: {
        wait: vi.fn(async () => {
          seenProgress.push(`${runtime.startupProgress.roomRecovery.state}:${runtime.startupProgress.detail}`);
        }),
      },
    });
    runtime.registerHostedRoomRecovery({ listTargets: () => [targetB], recover, discard });

    await runtime.start();

    expect(deps.runAttempt.mock.calls.map((call) => call[1])).toEqual([...ROOM_RECOVERY_POLICY.attemptTimeoutMs]);
    expect(deps.wait.mock.calls.map((call) => call[0])).toEqual([250, 750]);
    expect(seenProgress).toEqual(["retrying:Trying again…", "retrying:Trying again…"]);
    expect(discard).toHaveBeenCalledTimes(2);
    expect(runtime.status).toBe("running");
    const warning = logEntry(runtime, "hosted room recovery attempt failed");
    expect(warning).toMatchObject({ level: "warn", details: "# Bravo attempt 1/3: internal relay detail" });
  });

  test("works without a discard hook and logs a non-Error failure", async () => {
    const { runtime } = setup();
    let attempts = 0;
    runtime.registerHostedRoomRecovery({
      listTargets: () => [targetA],
      recover: async () => {
        attempts += 1;
        if (attempts === 1) throw "plain failure";
      },
    });

    await runtime.start();

    expect(runtime.status).toBe("running");
    expect(logEntry(runtime, "hosted room recovery attempt failed")?.details).toContain("plain failure");
  });

  test("a stale recovery without a discard hook still stops quietly", async () => {
    const pending = deferred();
    const { runtime } = setup();
    runtime.registerHostedRoomRecovery({ listTargets: () => [targetA], recover: () => pending.promise });

    const started = runtime.start();
    await flush();
    const stopped = runtime.stop();
    pending.resolve();
    await Promise.all([started, stopped]);

    expect(runtime.status).toBe("idle");
  });

  test("exhaustion waits in starting with a retry offered, keeping completed rooms", async () => {
    const recover = failingBravo(ROOM_RECOVERY_POLICY.maxAttempts);
    const { runtime, deps } = setup();
    runtime.registerHostedRoomRecovery({ listTargets: () => [targetB, targetA], recover });

    await runtime.start();

    expect(runtime.status).toBe("starting");
    expect(runtime.startupProgress).toMatchObject({
      phase: "restoring-rooms",
      detail: "Check your connection, then retry recovery.",
      roomRecovery: { state: "exhausted", completed: 1, total: 2, roomName: "Bravo", attempt: 3 },
    });
    expect(runtime.exhaustedRoomRecoveryTarget).toEqual(targetB);
    expect(deps.startResourceMonitor).not.toHaveBeenCalled();
    expect(runtime.createHostedRoomClient({ coordinatorPubkey: runtime.identity.publicKeyHex, relayUrls: [] })).not.toBeNull();

    const first = runtime.retryRoomRecovery();
    const duplicate = runtime.retryRoomRecovery();
    await Promise.all([first, duplicate]);

    expect(recover.mock.calls.map((call) => call[0].roomId)).toEqual(["alpha", "bravo", "bravo", "bravo", "bravo"]);
    expect(deps.acquireInstanceLease).toHaveBeenCalledOnce();
    expect(deps.createTransport).toHaveBeenCalledOnce();
    expect(deps.startResourceMonitor).toHaveBeenCalledOnce();
    expect(runtime.status).toBe("running");
    expect(runtime.appliedConfigRevision).toBe(1);
    expect(runtime.exhaustedRoomRecoveryTarget).toBeNull();
    expect(runtime.startupProgress.roomRecovery).toMatchObject({ state: "complete", completed: 2, total: 2 });
    expect(messages(runtime)).toContain("coordinator started");
  });

  test("a retry that exhausts again stays exhausted", async () => {
    const recover = vi.fn(async () => { throw new Error("offline"); });
    const { runtime, deps } = setup();
    runtime.registerHostedRoomRecovery({ listTargets: () => [targetA], recover });
    await runtime.start();

    await runtime.retryRoomRecovery();

    expect(recover).toHaveBeenCalledTimes(6);
    expect(runtime.status).toBe("starting");
    expect(runtime.exhaustedRoomRecoveryTarget).toEqual(targetA);
    expect(deps.startResourceMonitor).not.toHaveBeenCalled();
  });

  test("retry is refused unless recovery is exhausted", async () => {
    const { runtime, deps } = setup();
    const recover = vi.fn(async () => undefined);
    runtime.registerHostedRoomRecovery({ listTargets: () => [targetA], recover });

    await runtime.retryRoomRecovery();
    await runtime.start();
    expect(recover).toHaveBeenCalledOnce();
    await runtime.retryRoomRecovery();

    expect(recover).toHaveBeenCalledOnce();
    expect(deps.runAttempt).toHaveBeenCalledOnce();
    expect(runtime.exhaustedRoomRecoveryTarget).toBeNull();
  });

  test("retry is refused if the transport has gone away", async () => {
    const recover = vi.fn(async () => { throw new Error("offline"); });
    const { runtime } = setup();
    runtime.registerHostedRoomRecovery({ listTargets: () => [targetA], recover });
    await runtime.start();
    await runtime.stopSync();
    recover.mockClear();

    await runtime.retryRoomRecovery();

    expect(recover).not.toHaveBeenCalled();
  });

  test("retry joins a startup that is in flight", async () => {
    const pending = deferred<RunningTransport>();
    const { runtime, deps } = setup({ deps: { createTransport: vi.fn(() => pending.promise) } });

    const started = runtime.start();
    const retried = runtime.retryRoomRecovery();
    pending.resolve(createFakeTransport());
    await Promise.all([started, retried]);

    expect(deps.acquireInstanceLease).toHaveBeenCalledOnce();
    expect(runtime.status).toBe("running");
  });

  test("stopping during a retry's delay stops cleanly, with a real abortable wait", async () => {
    const recover = vi.fn(async () => { throw new Error("offline"); });
    const { runtime, transports, leases } = setup({ deps: { wait: defaultCoordinatorRuntimeDeps.wait } });
    runtime.registerHostedRoomRecovery({ listTargets: () => [targetA], recover });
    vi.useFakeTimers();
    const started = runtime.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await started;
    expect(runtime.exhaustedRoomRecoveryTarget).toEqual(targetA);

    const retried = runtime.retryRoomRecovery();
    await vi.advanceTimersByTimeAsync(10);
    const stopped = runtime.stop();

    await expect(stopped).resolves.toBeUndefined();
    await expect(retried).resolves.toBeUndefined();
    expect(runtime.status).toBe("idle");
    expect(runtime.error).toBeNull();
    expect(transports[0]!.close).toHaveBeenCalledOnce();
    expect(leases[0]!.release).toHaveBeenCalledOnce();
    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  test("a stale retry outcome does not mark the coordinator running", async () => {
    const pending = deferred();
    const recover = vi.fn(async (): Promise<void> => { throw new Error("offline"); });
    const { runtime, deps } = setup();
    runtime.registerHostedRoomRecovery({ listTargets: () => [targetA], recover });
    await runtime.start();
    recover.mockImplementationOnce(() => pending.promise);

    const retried = runtime.retryRoomRecovery();
    await flush();
    const stopped = runtime.stop();
    pending.resolve();
    await Promise.all([retried, stopped]);

    expect(deps.startResourceMonitor).not.toHaveBeenCalled();
    expect(runtime.status).toBe("idle");
  });

  test("a failure during a retry cleans up exactly like a failed startup", async () => {
    const { runtime, transports, leases } = setup();
    let listCalls = 0;
    runtime.registerHostedRoomRecovery({
      listTargets: () => {
        listCalls += 1;
        if (listCalls > 1) throw new Error("room list unavailable");
        return [targetA];
      },
      recover: async () => { throw new Error("offline"); },
    });
    await runtime.start();

    await runtime.resumeAfterRemovingFailedRoom({ roomId: targetA.roomId, coordinatorPubkey: targetA.coordinatorPubkey });

    expect(runtime.status).toBe("idle");
    expect(runtime.error).toBe("room list unavailable");
    expect(transports[0]!.close).toHaveBeenCalledOnce();
    expect(leases[0]!.release).toHaveBeenCalledOnce();
    expect(runtime.startupProgress.phase).toBe("failed");
    expect(await runtime.retryRoomRecovery()).toBeUndefined();
  });

  test("a failing discard fails startup and cleans up", async () => {
    const { runtime, transports } = setup();
    runtime.registerHostedRoomRecovery({
      listTargets: () => [targetA],
      recover: async () => { throw new Error("offline"); },
      discard: async () => { throw new Error("discard failed"); },
    });

    await runtime.start();

    expect(runtime.status).toBe("idle");
    expect(runtime.error).toBe("discard failed");
    expect(transports[0]!.close).toHaveBeenCalledOnce();
  });

  test("removing the exhausted room resumes startup without reacquiring resources", async () => {
    const { runtime, deps } = setup();
    let targets = [targetB, targetA];
    runtime.registerHostedRoomRecovery({
      listTargets: () => targets,
      recover: async (target) => {
        if (target.roomIdentityKey === targetB.roomIdentityKey) throw new Error("signer mismatch");
      },
    });
    await runtime.start();

    await expect(runtime.resumeAfterRemovingFailedRoom({
      roomId: targetA.roomId,
      coordinatorPubkey: targetA.coordinatorPubkey,
    })).rejects.toThrow("Failed recovery room changed");
    await expect(runtime.resumeAfterRemovingFailedRoom({
      roomId: targetB.roomId,
      coordinatorPubkey: targetA.coordinatorPubkey,
    })).rejects.toThrow("Failed recovery room changed");
    expect(runtime.status).toBe("starting");
    expect(runtime.exhaustedRoomRecoveryTarget).toEqual(targetB);

    targets = [targetA];
    const notified = vi.fn();
    runtime.subscribe(notified);
    await runtime.resumeAfterRemovingFailedRoom({
      roomId: targetB.roomId,
      coordinatorPubkey: ` ${targetB.coordinatorPubkey.toUpperCase()} `,
    });

    expect(notified).toHaveBeenCalled();
    expect(logEntry(runtime, "removed unrecoverable hosted room from startup")).toMatchObject({ level: "warn", details: "Bravo" });
    expect(runtime.status).toBe("running");
    expect(runtime.exhaustedRoomRecoveryTarget).toBeNull();
    expect(runtime.startupProgress.roomRecovery).toMatchObject({ state: "complete", completed: 1, total: 1 });
    expect(deps.acquireInstanceLease).toHaveBeenCalledOnce();
    expect(deps.createTransport).toHaveBeenCalledOnce();
  });

  test("removing the only room re-lists and finishes with zero rooms", async () => {
    const { runtime } = setup();
    let targets = [targetA];
    runtime.registerHostedRoomRecovery({
      listTargets: () => targets,
      recover: async () => { throw new Error("offline"); },
    });
    await runtime.start();
    targets = [];

    await runtime.resumeAfterRemovingFailedRoom({ roomId: targetA.roomId, coordinatorPubkey: targetA.coordinatorPubkey });

    expect(runtime.status).toBe("running");
    expect(runtime.startupProgress.roomRecovery).toMatchObject({ state: "complete", total: 0 });
  });

  test("removal is refused when recovery has not failed", async () => {
    const { runtime } = setup();

    await expect(runtime.resumeAfterRemovingFailedRoom({ roomId: "x", coordinatorPubkey: "y" }))
      .rejects.toThrow("Failed recovery room changed");
  });

  test("stopping from exhausted clears recovery state, and the next start lists again", async () => {
    const recover = vi.fn(async () => { throw new Error("offline"); });
    const listTargets = vi.fn(() => [targetA]);
    const { runtime, transports } = setup();
    runtime.registerHostedRoomRecovery({ listTargets, recover });
    await runtime.start();

    await runtime.stop();

    expect(runtime.status).toBe("idle");
    expect(runtime.exhaustedRoomRecoveryTarget).toBeNull();
    expect(transports[0]!.close).toHaveBeenCalledOnce();

    await runtime.start();
    expect(listTargets).toHaveBeenCalledTimes(2);
  });

  test("an adapter removed before a retry completes the retry with no rooms", async () => {
    const { runtime } = setup();
    const unregister = runtime.registerHostedRoomRecovery({
      listTargets: () => [targetA],
      recover: async () => { throw new Error("offline"); },
    });
    await runtime.start();
    unregister();

    await runtime.retryRoomRecovery();

    expect(runtime.status).toBe("running");
    expect(runtime.startupProgress.roomRecovery).toMatchObject({ state: "complete", total: 0 });
  });

  test("the removed room stops being reported as soon as it is removed", async () => {
    const { runtime } = setup();
    runtime.registerHostedRoomRecovery({
      listTargets: () => [targetA],
      recover: async () => { throw new Error("offline"); },
    });
    await runtime.start();
    const seen: Array<HostedRoomRecoveryTarget | null> = [];
    const stateAtNotification: string[] = [];
    runtime.subscribe(() => {
      if (stateAtNotification.length === 0) {
        stateAtNotification.push(runtime.startupProgress.roomRecovery.state);
        seen.push(runtime.exhaustedRoomRecoveryTarget);
      }
    });

    await runtime.resumeAfterRemovingFailedRoom({ roomId: targetA.roomId, coordinatorPubkey: targetA.coordinatorPubkey });

    expect(stateAtNotification).toEqual(["exhausted"]);
    expect(seen).toEqual([null]);
  });
});

describe("createHostedRoomClient", () => {
  test("is available only for this running coordinator, ignoring pubkey case", async () => {
    const { runtime } = setup();
    const own = () => ({ coordinatorPubkey: runtime.identity.publicKeyHex.toUpperCase(), relayUrls: [] });

    expect(runtime.createHostedRoomClient(own())).toBeNull();

    await runtime.start();
    expect(runtime.createHostedRoomClient(own())).toBeInstanceOf(LocalHostCoordinatorClient);
    expect(runtime.createHostedRoomClient({ coordinatorPubkey: "f".repeat(64), relayUrls: [] })).toBeNull();

    await runtime.stop();
    expect(runtime.createHostedRoomClient(own())).toBeNull();
  });
});

describe("deleteHostedRoom", () => {
  function fakeStorage(overrides: Partial<CoordinatorStorage> = {}) {
    return { deleteGroup: vi.fn(), close: vi.fn(), ...overrides } as unknown as CoordinatorStorage & {
      deleteGroup: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
  }

  test.each([[""], ["   "]])("requires a room id (%j)", async (id) => {
    const { runtime } = setup();

    await expect(runtime.deleteHostedRoom({ id, coordinatorPubkey: runtime.identity.publicKeyHex }))
      .rejects.toThrow("Room id is required");
  });

  test.each([["f".repeat(64)], [""], ["   "]])("refuses another coordinator (%j)", async (coordinatorPubkey) => {
    const createStorage = vi.fn();
    const { runtime } = setup({ deps: { createStorage } });

    await expect(runtime.deleteHostedRoom({ id: "room", coordinatorPubkey }))
      .rejects.toThrow("Cannot delete a room hosted by another coordinator");
    expect(createStorage).not.toHaveBeenCalled();
  });

  test("uses the running coordinator, normalizing input", async () => {
    const deleteGroup = vi.fn();
    const createStorage = vi.fn();
    const { runtime } = setup({
      deps: {
        createStorage,
        createTransport: vi.fn(async () => ({ close: vi.fn(), coordinator: { deleteGroup } }) as unknown as RunningTransport),
      },
    });
    await runtime.start();

    await runtime.deleteHostedRoom({ id: " room ", coordinatorPubkey: ` ${runtime.identity.publicKeyHex.toUpperCase()} ` });

    expect(deleteGroup).toHaveBeenCalledExactlyOnceWith("room");
    expect(createStorage).not.toHaveBeenCalled();
    expect(logEntry(runtime, "hosted room deleted")?.details).toBe("room");
  });

  test.each([
    ["an Error", new Error("group locked"), "group locked"],
    ["a non-Error", "plain", "plain"],
  ])("rethrows and logs when the running coordinator fails with %s", async (_label, thrown, details) => {
    const { runtime } = setup({
      deps: {
        createTransport: vi.fn(async () => ({
          close: vi.fn(),
          coordinator: { deleteGroup: () => { throw thrown; } },
        }) as unknown as RunningTransport),
      },
    });
    await runtime.start();

    await expect(runtime.deleteHostedRoom({ id: "room", coordinatorPubkey: runtime.identity.publicKeyHex }))
      .rejects.toBe(thrown);
    expect(logEntry(runtime, "hosted room deletion failed")).toMatchObject({ level: "warn", details });
  });

  test("offline uses storage with the persistence setting and closes it", async () => {
    const storage = fakeStorage();
    const createStorage = vi.fn(async () => storage);
    const { runtime } = setup({ deps: { createStorage } });
    await runtime.enablePersistence("pass", "pass");

    await runtime.deleteHostedRoom({ id: "room", coordinatorPubkey: runtime.identity.publicKeyHex });

    expect(createStorage).toHaveBeenCalledExactlyOnceWith(true, runtime.identity.publicKeyHex);
    expect(storage.deleteGroup).toHaveBeenCalledExactlyOnceWith("room");
    expect(storage.close).toHaveBeenCalledOnce();
  });

  test("offline storage is closed even when deletion fails", async () => {
    const storage = fakeStorage({ deleteGroup: vi.fn(() => { throw new Error("locked"); }) });
    const { runtime } = setup({ deps: { createStorage: () => storage } });

    await expect(runtime.deleteHostedRoom({ id: "room", coordinatorPubkey: runtime.identity.publicKeyHex }))
      .rejects.toThrow("locked");

    expect(storage.close).toHaveBeenCalledOnce();
    expect(logEntry(runtime, "hosted room deletion failed")?.details).toBe("locked");
  });

  test("storage without close is accepted", async () => {
    const storage = { deleteGroup: vi.fn() } as unknown as CoordinatorStorage;
    const { runtime } = setup({ deps: { createStorage: () => storage } });

    await runtime.deleteHostedRoom({ id: "room", coordinatorPubkey: runtime.identity.publicKeyHex });

    expect(storage.deleteGroup).toHaveBeenCalledOnce();
  });

  test("defaults to browser storage when no factory is supplied", async () => {
    const storage = fakeStorage();
    browserStorage.mockResolvedValue(storage as never);
    const { runtime } = setup();

    await runtime.deleteHostedRoom({ id: "room", coordinatorPubkey: runtime.identity.publicKeyHex });

    expect(browserStorage).toHaveBeenCalledExactlyOnceWith(false, runtime.identity.publicKeyHex);
    expect(storage.deleteGroup).toHaveBeenCalledOnce();
  });
});

describe("destroy", () => {
  function hostedRoom(coordinatorPubkey: string, id: string): StoredRoom {
    return {
      version: 1,
      id,
      title: id,
      name: "Host",
      coordinatorPubkey,
      stablePubkey: "c".repeat(64),
      relayUrls: [],
      isHost: true,
      lastCursor: 0,
      messages: [],
      pending: [],
      reactions: [],
      stateBase64: "",
      keyPackage: { reference: "r", publicBase64: "p", privateBase64: "s" },
    } as unknown as StoredRoom;
  }

  test("shuts down, erases identity and persisted records, in order", async () => {
    const order: string[] = [];
    const leaseKey = (pubkey: string) => `cordn:v1:instance:${pubkey}`;
    const stoppedKey = (pubkey: string) => `cordn:v1:stopped-instance:${pubkey}`;
    const events = new EventTarget();
    const restore = configureRoomEnvironment({ events });
    const context = setup({
      onDestroy: () => order.push("onDestroy"),
      config: { resetToDefaults: vi.fn(() => { order.push("resetConfig"); }) },
      deps: {
        closeTransport: vi.fn(() => { order.push("closeTransport"); }),
        acquireInstanceLease: vi.fn(async () => ({ release: async () => { order.push("releaseLease"); } })),
      },
    });
    const { runtime, keyStorage } = context;
    await runtime.enablePersistence("pass", "pass");
    await runtime.start();
    const oldManager = runtime.keyManager!;
    const oldPubkey = runtime.identity.publicKeyHex;
    saveRoom(hostedRoom(oldPubkey, "mine"));
    saveRoom(hostedRoom("d".repeat(64), "other"));
    localStorage.setItem(leaseKey(oldPubkey), "x");
    localStorage.setItem(stoppedKey(oldPubkey), "x");
    events.addEventListener(ROOMS_CHANGED_EVENT, (event) => {
      if ((event as CustomEvent).detail?.action === "destroyed") {
        order.push("event");
        expect(listRooms().map((room) => room.id)).toEqual(["other"]);
      }
    });
    clearPersisted.mockClear();
    clearPersisted.mockImplementation(async () => { order.push("clearPersisted"); });
    const cacheDelete = vi.fn(async (name: string) => { order.push(`cache:${name}`); return true; });
    vi.stubGlobal("caches", { keys: async () => ["one", "two"], delete: cacheDelete });

    await runtime.destroy();
    restore();

    expect(order).toEqual([
      "closeTransport",
      "releaseLease",
      "onDestroy",
      "event",
      "resetConfig",
      "clearPersisted",
      "cache:one",
      "cache:two",
    ]);
    expect(() => oldManager.getSecretKeyBytes()).toThrow("Coordinator key has been destroyed");
    expect(runtime.identity.publicKeyHex).not.toBe(oldPubkey);
    expect(keyStorage.hasPersisted()).toBe(false);
    expect(runtime.getSnapshot()).toMatchObject({
      status: "idle",
      loadState: "ready",
      error: null,
      persistenceEnabled: false,
      persistenceError: null,
      passphraseError: null,
      relayStatuses: {},
      appliedConfigRevision: null,
      profilePublicationState: "idle",
    });
    expect(runtime.startupProgress.phase).toBe("idle");
    expect(messages(runtime)).toEqual(["coordinator state destroyed"]);
    expect(runtime.debugLog[0]!.details).toBe(runtime.identity.npub);
    expect(localStorage.getItem(leaseKey(oldPubkey))).toBeNull();
    expect(localStorage.getItem(stoppedKey(oldPubkey))).toBeNull();
  });

  test("works from idle without a stop transition or caches API", async () => {
    const { runtime, deps } = setup();
    const onlyRoom = hostedRoom(runtime.identity.publicKeyHex, "mine");
    saveRoom(onlyRoom);
    const statuses: string[] = [];
    runtime.subscribe(() => statuses.push(runtime.status));

    await runtime.destroy();

    expect(new Set(statuses)).toEqual(new Set(["idle"]));
    expect(deps.stopResourceMonitor).toHaveBeenCalled();
    expect(listRooms()).toEqual([]);
    expect(clearPersisted).toHaveBeenCalledOnce();
  });

  test("while locked it rejects before any destructive step", async () => {
    const keyStorage = memoryKeyStorage();
    const manager = KeyManager.generate();
    await keyStorage.save(manager.getSecretKeyBytes(), "pass");
    const onDestroy = vi.fn();
    const { runtime } = setup({ keyStorage, onDestroy });

    await expect(runtime.destroy()).rejects.toThrow("Coordinator key is not loaded");

    expect(keyStorage.hasPersisted()).toBe(true);
    expect(onDestroy).not.toHaveBeenCalled();
    expect(clearPersisted).not.toHaveBeenCalled();
  });

  test("cancels an active startup instead of finishing on the new identity", async () => {
    const pending = deferred<InstanceLease>();
    const { runtime, deps } = setup({ deps: { acquireInstanceLease: vi.fn(() => pending.promise) } });
    const release = vi.fn(async () => undefined);

    const started = runtime.start();
    const destroyed = runtime.destroy();
    pending.resolve({ release });
    await Promise.all([started, destroyed]);

    expect(runtime.status).toBe("idle");
    expect(release).toHaveBeenCalledOnce();
    expect(deps.createTransport).not.toHaveBeenCalled();
  });
});

describe("pagehide", () => {
  const pagehide = () => window.dispatchEvent(new Event("pagehide"));

  test("releases the lease once when the page unloads", async () => {
    const { runtime, leases } = setup();
    await runtime.start();

    pagehide();

    expect(leases[0]!.release).toHaveBeenCalledOnce();
    expect(messages(runtime)).toContain("page unloading; releasing coordinator instance lease");
    await runtime.stop();
    expect(leases[0]!.release).toHaveBeenCalledOnce();
  });

  test("aborts an active startup so its late transport is closed", async () => {
    const pending = deferred<RunningTransport>();
    const { runtime, deps, leases } = setup({ deps: { createTransport: vi.fn(() => pending.promise) } });
    const transport = createFakeTransport();
    const started = runtime.start();
    await flush();

    pagehide();
    pending.resolve(transport);
    await started;

    expect(leases[0]!.release).toHaveBeenCalledOnce();
    expect(deps.closeTransport).toHaveBeenCalledExactlyOnceWith(transport);
    expect(deps.startResourceMonitor).not.toHaveBeenCalled();
  });

  test("a rejecting lease is logged rather than becoming an unhandled rejection", async () => {
    const { runtime } = setup({
      deps: { acquireInstanceLease: vi.fn(async () => ({ release: () => Promise.reject(new Error("lease stuck")) })) },
    });
    await runtime.start();

    pagehide();
    await flush();

    expect(logEntry(runtime, "coordinator cleanup failed")).toMatchObject({ level: "warn", details: "lease stuck" });
  });

  test("a non-Error lease rejection is logged too", async () => {
    const { runtime } = setup({
      deps: { acquireInstanceLease: vi.fn(async () => ({ release: () => Promise.reject("lease stuck") })) },
    });
    await runtime.start();

    pagehide();
    await flush();

    expect(logEntry(runtime, "coordinator cleanup failed")?.details).toBe("lease stuck");
  });

  test("is unregistered after stop", async () => {
    const { runtime, leases } = setup();
    await runtime.start();
    await runtime.stop();
    runtime.clearDebugLog();

    pagehide();

    expect(leases[0]!.release).toHaveBeenCalledOnce();
    expect(runtime.debugLog).toEqual([]);
  });

  test("still releases the lease after room recovery was retried", async () => {
    const { runtime, leases } = setup();
    let attempts = 0;
    runtime.registerHostedRoomRecovery({
      listTargets: () => [targetA],
      recover: async () => {
        attempts += 1;
        if (attempts <= ROOM_RECOVERY_POLICY.maxAttempts) throw new Error("offline");
      },
    });
    await runtime.start();
    await runtime.retryRoomRecovery();
    expect(runtime.status).toBe("running");

    pagehide();

    expect(leases[0]!.release).toHaveBeenCalledOnce();
    await runtime.stop();
  });

  test("does nothing while a stop owns the shutdown", async () => {
    const pending = deferred<RunningTransport>();
    const { runtime, leases } = setup({ deps: { createTransport: vi.fn(() => pending.promise) } });
    const started = runtime.start();
    await flush();
    const stopped = runtime.stop();
    runtime.clearDebugLog();

    pagehide();

    expect(leases[0]!.release).not.toHaveBeenCalled();
    expect(messages(runtime)).not.toContain("page unloading; releasing coordinator instance lease");
    pending.resolve(createFakeTransport());
    await Promise.all([started, stopped]);
    expect(leases[0]!.release).toHaveBeenCalledOnce();
  });

  test("a host without EventTarget globals can still start and stop", async () => {
    vi.stubGlobal("addEventListener", undefined);
    const { runtime, leases } = setup();

    await runtime.start();
    await runtime.stop();

    expect(leases[0]!.release).toHaveBeenCalledOnce();
  });

  test("tolerates a host without removeEventListener", async () => {
    const add = vi.fn();
    vi.stubGlobal("addEventListener", add);
    vi.stubGlobal("removeEventListener", undefined);
    const { runtime, leases } = setup();

    await runtime.start();
    expect(add).toHaveBeenCalledWith("pagehide", expect.any(Function), { once: true });
    await runtime.stop();

    expect(leases[0]!.release).toHaveBeenCalledOnce();
  });
});

describe("default dependencies", () => {
  const deps = defaultCoordinatorRuntimeDeps;

  describe("wait", () => {
    test("resolves after the delay and removes its listener", async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const settled = vi.fn();

      const waiting = deps.wait(100, controller.signal).then(settled);
      await vi.advanceTimersByTimeAsync(99);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await waiting;

      expect(settled).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    });

    test("rejects at once when already aborted, without a timer", async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      controller.abort();

      await expect(deps.wait(100, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
    });

    test("rejects on abort and clears its timer", async () => {
      vi.useFakeTimers();
      const controller = new AbortController();

      const waiting = deps.wait(100, controller.signal);
      controller.abort();

      await expect(waiting).rejects.toMatchObject({ name: "AbortError", message: "Recovery cancelled" });
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("runAttempt", () => {
    function trackedSignal() {
      const controller = new AbortController();
      const added = vi.spyOn(controller.signal, "addEventListener");
      const removed = vi.spyOn(controller.signal, "removeEventListener");
      return { controller, signal: controller.signal, added, removed };
    }

    function expectListenersCleaned(tracked: ReturnType<typeof trackedSignal>) {
      for (const call of tracked.added.mock.calls) {
        expect(tracked.removed).toHaveBeenCalledWith("abort", call[1]);
      }
    }

    test("rejects at once when already aborted without running the operation", async () => {
      const controller = new AbortController();
      controller.abort();
      const operation = vi.fn(async () => undefined);

      await expect(deps.runAttempt(operation, 100, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(operation).not.toHaveBeenCalled();
    });

    test("resolves with the operation, clearing the timer and listeners", async () => {
      vi.useFakeTimers();
      const tracked = trackedSignal();
      let attemptSignal!: AbortSignal;

      await deps.runAttempt(async (signal) => { attemptSignal = signal; }, 100, tracked.signal);

      expect(attemptSignal).not.toBe(tracked.signal);
      expect(attemptSignal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(tracked.added).toHaveBeenCalledTimes(2);
      expectListenersCleaned(tracked);
    });

    test("surfaces the operation's failure and cleans up", async () => {
      vi.useFakeTimers();
      const tracked = trackedSignal();

      await expect(deps.runAttempt(async () => { throw new Error("relay refused"); }, 100, tracked.signal))
        .rejects.toThrow("relay refused");

      expect(vi.getTimerCount()).toBe(0);
      expectListenersCleaned(tracked);
    });

    test("cleans up when the operation throws synchronously", async () => {
      vi.useFakeTimers();
      const tracked = trackedSignal();

      await expect(deps.runAttempt(() => { throw new Error("sync failure"); }, 100, tracked.signal))
        .rejects.toThrow("sync failure");

      expect(vi.getTimerCount()).toBe(0);
      expectListenersCleaned(tracked);
    });

    test("times out, aborting the attempt without touching the caller's signal", async () => {
      vi.useFakeTimers();
      const tracked = trackedSignal();
      let attemptSignal!: AbortSignal;

      const running = deps.runAttempt((signal) => {
        attemptSignal = signal;
        return new Promise(() => undefined);
      }, 100, tracked.signal);
      const outcome = expect(running).rejects.toThrow("Hosted room recovery timed out");
      await vi.advanceTimersByTimeAsync(100);
      await outcome;

      expect(attemptSignal.aborted).toBe(true);
      expect(tracked.signal.aborted).toBe(false);
      expectListenersCleaned(tracked);
    });

    test("caller abort aborts the attempt and rejects even if the operation never settles", async () => {
      vi.useFakeTimers();
      const tracked = trackedSignal();
      let attemptSignal!: AbortSignal;

      const running = deps.runAttempt((signal) => {
        attemptSignal = signal;
        return new Promise(() => undefined);
      }, 100, tracked.signal);
      tracked.controller.abort();

      await expect(running).rejects.toMatchObject({ name: "AbortError" });
      expect(attemptSignal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    test("a late rejection from a timed-out operation is not unhandled", async () => {
      vi.useFakeTimers();
      const pending = deferred<void>();
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const running = deps.runAttempt(() => pending.promise, 100, new AbortController().signal);
        const outcome = expect(running).rejects.toThrow("timed out");
        await vi.advanceTimersByTimeAsync(100);
        await outcome;
        pending.reject(new Error("late"));
        vi.useRealTimers();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });
  });

  test("closeTransport closes the transport", () => {
    const transport = createFakeTransport();

    deps.closeTransport(transport);

    expect(transport.close).toHaveBeenCalledOnce();
  });

  test("resource monitoring is opt-in, so the defaults are no-ops", () => {
    const transport = createFakeTransport();

    expect(deps.startResourceMonitor(transport)).toBeUndefined();
    expect(deps.stopResourceMonitor()).toBeUndefined();
    expect(transport.close).not.toHaveBeenCalled();
  });

  test("createTransport delegates to the transport factory", async () => {
    const transport = createFakeTransport();
    const create = vi.spyOn(transportFactory, "create").mockResolvedValue(transport);
    const key = new Uint8Array(32);
    const options = { announce: false, maxUsers: 1 };
    const diagnostics = {};

    await expect(deps.createTransport(key, ["wss://relay.example"], options, true, diagnostics)).resolves.toBe(transport);

    expect(create).toHaveBeenCalledExactlyOnceWith(key, ["wss://relay.example"], options, true, diagnostics);
  });

  test("profilePublisher delegates to publishCoordinatorProfile", async () => {
    const manager = KeyManager.generate();

    await expect(deps.profilePublisher({
      name: "Host",
      coordinatorPubkey: manager.identity.publicKeyHex,
      getSecretKeyBytes: () => manager.getSecretKeyBytes(),
      relayUrls: [],
    })).rejects.toThrow("Coordinator profile publication failed");
  });

  test("acquireInstanceLease uses a real single-instance guard", async () => {
    const publicKeyHex = "ab".repeat(32);
    const debug = vi.fn();
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("BroadcastChannel", undefined);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
    delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;

    const lease = await deps.acquireInstanceLease({
      publicKeyHex,
      relayUrls: [],
      getSecretKeyBytes: () => new Uint8Array(32).fill(1),
      debug,
    });

    expect(localStorage.getItem(`cordn:v1:instance:${publicKeyHex}`)).not.toBeNull();
    await lease.release();
    expect(localStorage.getItem(`cordn:v1:instance:${publicKeyHex}`)).toBeNull();
    expect(debug).toHaveBeenCalledWith("info", "single instance guard acquired", expect.any(String));
    if (descriptor) Object.defineProperty(globalThis, "BroadcastChannel", descriptor);
  });
});
