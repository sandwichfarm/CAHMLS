import {
  CHAT_COORDINATOR_CONNECT_TIMEOUT_MS,
  CHAT_COORDINATOR_REQUEST_TIMEOUT_MS,
  type ChatCoordinatorOperations,
  type CoordinatorTarget,
} from "../client/coordinator-client.js";
import { LocalHostCoordinatorClient } from "../client/local-coordinator-client.js";
import { getRoomEnvironment } from "../client/room-environment.js";
import { removeHostedRoomsForCoordinator, ROOMS_CHANGED_EVENT } from "../client/room-store.js";
import {
  clearPersistedCoordinatorState,
  createBrowserCoordinatorStorage,
} from "../coordinator/storage/browserSqliteStorage.js";
import type { CoordinatorStorage } from "../coordinator/storage/storage.js";
import { KeyManager } from "../crypto/key-manager.js";
import {
  keyStorage as defaultKeyStorage,
  WrongPassphraseError,
  type CoordinatorKeyBackup,
  type KeyStorage,
} from "../crypto/key-storage.js";
import {
  transportFactory,
  type CoordinatorHostOptions,
  type RunningTransport,
  type TransportDiagnostics,
} from "../server/transport.js";
import {
  publishCoordinatorProfile,
  type CoordinatorProfilePublisherInput,
} from "./coordinator-profile.js";
import {
  clearCoordinatorInstanceRecords,
  INSTANCE_RUNNING_MESSAGE,
  SingleInstanceGuard,
  type InstanceLease,
  type SingleInstanceAcquireInput,
} from "./single-instance-guard.js";
import { isConfigLocked, transitionCoordinator } from "./state-machine.js";
import { createHostedRoomRecoveryProgress } from "./types.js";
import type {
  CoordinatorLoadState,
  CoordinatorStartupPhase,
  CoordinatorStartupProgress,
  CoordinatorStatus,
  HostedRoomRecoveryAdapter,
  HostedRoomRecoveryProgress,
  HostedRoomRecoveryTarget,
  RelayConnectionStatus,
} from "./types.js";

export interface DebugLogEntry {
  id: string;
  timestamp: number;
  timeLabel: string;
  level: "info" | "warn" | "error";
  message: string;
  details?: string;
}

/** Bounded retry policy for restoring locally hosted rooms during startup. */
export const ROOM_RECOVERY_POLICY = {
  maxAttempts: 3,
  // Probe quickly first, then allow one complete Nostr connection-plus-request
  // window. Real relays commonly exceed the in-process test relay's latency,
  // while an unreachable room should still fail in bounded time.
  attemptTimeoutMs: [
    4_000,
    CHAT_COORDINATOR_CONNECT_TIMEOUT_MS,
    CHAT_COORDINATOR_CONNECT_TIMEOUT_MS + CHAT_COORDINATOR_REQUEST_TIMEOUT_MS + 6_000,
  ] as const,
  retryDelayMs: [250, 750] as const,
} as const;

/** Application configuration read by the coordinator lifecycle. */
export interface CoordinatorRuntimeConfig {
  readonly isSetupComplete: boolean;
  readonly coordinatorName: string;
  readonly enabledRelayUrls: string[];
  readonly inviteRelayUrls: string[];
  readonly coordinatorOptions: CoordinatorHostOptions;
  /** Increases whenever a runtime-affecting setting changes. */
  readonly runtimeRevision: number;
  lock(): void;
  completeSetup(name: unknown): boolean;
  setCoordinatorName(name: unknown): boolean;
  resetToDefaults(): void;
}

/** Replaceable side effects used by the lifecycle. */
export interface CoordinatorRuntimeDeps {
  acquireInstanceLease(input: SingleInstanceAcquireInput): Promise<InstanceLease>;
  createTransport(
    privateKey: Uint8Array,
    relayUrls: string[],
    options: CoordinatorHostOptions,
    persistent: boolean,
    diagnostics?: TransportDiagnostics,
  ): Promise<RunningTransport>;
  closeTransport(transport: RunningTransport): void;
  startResourceMonitor(transport: RunningTransport): void;
  stopResourceMonitor(): void;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  runAttempt(operation: (signal: AbortSignal) => Promise<void>, timeoutMs: number, signal: AbortSignal): Promise<void>;
  profilePublisher(input: CoordinatorProfilePublisherInput): Promise<unknown>;
  /** Used to edit hosted rooms while offline. Defaults to browser storage. */
  createStorage?(persistent: boolean, coordinatorPubkey: string): CoordinatorStorage | Promise<CoordinatorStorage>;
}

export type CoordinatorProfilePublicationState = "idle" | "publishing" | "published" | "failed";

export interface CoordinatorProfilePublicationResult {
  localSaved: boolean;
  published: boolean;
}

function abortError(): DOMException {
  return new DOMException("Recovery cancelled", "AbortError");
}

/** Production dependencies. Resource monitoring is opt-in through `startResourceMonitor`. */
export const defaultCoordinatorRuntimeDeps: CoordinatorRuntimeDeps = {
  acquireInstanceLease(input) {
    return new SingleInstanceGuard().acquire(input);
  },
  createTransport(privateKey, relayUrls, options, persistent, diagnostics) {
    return transportFactory.create(privateKey, relayUrls, options, persistent, diagnostics);
  },
  closeTransport(transport) {
    transport.close();
  },
  startResourceMonitor() {},
  stopResourceMonitor() {},
  wait(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const abort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, milliseconds);
      signal.addEventListener("abort", abort, { once: true });
    });
  },
  async runAttempt(operation, timeoutMs, signal) {
    if (signal.aborted) throw abortError();
    const attemptController = new AbortController();
    const abort = () => attemptController.abort();
    signal.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | null = null;
    let rejectOnAbort: (() => void) | null = null;
    try {
      await Promise.race([
        operation(attemptController.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            attemptController.abort();
            reject(new Error("Hosted room recovery timed out"));
          }, timeoutMs);
          rejectOnAbort = () => reject(abortError());
          signal.addEventListener("abort", rejectOnAbort, { once: true });
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (rejectOnAbort) signal.removeEventListener("abort", rejectOnAbort);
    }
  },
  profilePublisher(input) {
    return publishCoordinatorProfile(input);
  },
};

const debugTimeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const STARTUP_TOTAL_STEPS = 5;

const STARTUP_PHASE_COPY: Record<CoordinatorStartupPhase, Omit<CoordinatorStartupProgress, "phase" | "detail" | "roomRecovery"> & { detail: string }> = {
  idle: {
    step: 0,
    totalSteps: STARTUP_TOTAL_STEPS,
    percent: 0,
    label: "Ready to start",
    detail: "The coordinator is offline.",
  },
  "checking-instance": {
    step: 1,
    totalSteps: STARTUP_TOTAL_STEPS,
    percent: 20,
    label: "Checking coordinator availability",
    detail: "Confirming this identity is not already active.",
  },
  "opening-storage": {
    step: 2,
    totalSteps: STARTUP_TOTAL_STEPS,
    percent: 40,
    label: "Opening room storage",
    detail: "Loading the coordinator's room state.",
  },
  "preparing-runtime": {
    step: 3,
    totalSteps: STARTUP_TOTAL_STEPS,
    percent: 60,
    label: "Preparing MLS services",
    detail: "Registering encrypted room coordination methods.",
  },
  "connecting-relays": {
    step: 4,
    totalSteps: STARTUP_TOTAL_STEPS,
    percent: 80,
    label: "Connecting relay paths",
    detail: "Subscribing for coordinator requests.",
  },
  "restoring-rooms": {
    step: 5,
    totalSteps: 6,
    percent: 85,
    label: "Restoring rooms",
    detail: "Restoring local hosted rooms.",
  },
  online: {
    step: 6,
    totalSteps: 6,
    percent: 100,
    label: "Coordinator online",
    detail: "Encrypted room delivery is ready.",
  },
  failed: {
    step: 0,
    totalSteps: STARTUP_TOTAL_STEPS,
    percent: 0,
    label: "Startup interrupted",
    detail: "The coordinator could not start.",
  },
};

function startupProgress(
  phase: CoordinatorStartupPhase,
  detail = STARTUP_PHASE_COPY[phase].detail,
  roomRecovery = createHostedRoomRecoveryProgress({ state: "idle", completed: 0, total: 0 }),
): CoordinatorStartupProgress {
  return { phase, ...STARTUP_PHASE_COPY[phase], detail, roomRecovery };
}

/** Immutable observable state. A new object is published for every change. */
export interface CoordinatorRuntimeState {
  readonly keyManager: KeyManager | null;
  readonly loadState: CoordinatorLoadState;
  readonly status: CoordinatorStatus;
  readonly error: string | null;
  readonly passphraseError: string | null;
  readonly persistenceError: string | null;
  readonly persistenceEnabled: boolean;
  readonly relayStatuses: Readonly<Record<string, RelayConnectionStatus>>;
  readonly debugLog: readonly DebugLogEntry[];
  readonly profilePublicationState: CoordinatorProfilePublicationState;
  readonly startupProgress: CoordinatorStartupProgress;
  readonly appliedConfigRevision: number | null;
}

export interface CoordinatorRuntimeOptions {
  config: CoordinatorRuntimeConfig;
  deps?: Partial<CoordinatorRuntimeDeps>;
  /** Encrypted coordinator-key persistence. Defaults to `localStorage`. */
  keyStorage?: KeyStorage;
  /** Clears application-owned records during `destroy()`. */
  onDestroy?: () => void;
}

/**
 * Framework-free coordinator lifecycle: identity, single-instance leasing,
 * transport startup and shutdown, hosted-room recovery, and profile publication.
 * Bind any UI framework through `subscribe()` and `getSnapshot()`.
 */
export class CoordinatorRuntime {
  private state: CoordinatorRuntimeState = {
    keyManager: null,
    loadState: "ready",
    status: "idle",
    error: null,
    passphraseError: null,
    persistenceError: null,
    persistenceEnabled: false,
    relayStatuses: {},
    debugLog: [],
    profilePublicationState: "idle",
    startupProgress: startupProgress("idle"),
    appliedConfigRevision: null,
  };
  private readonly listeners = new Set<() => void>();
  private running: RunningTransport | null = null;
  private instanceLease: InstanceLease | null = null;
  private pagehideRelease: (() => void) | null = null;
  private hostedRoomRecovery: HostedRoomRecoveryAdapter | null = null;
  private recoveryTargets: readonly HostedRoomRecoveryTarget[] = [];
  private readonly recoveryCompleted = new Set<string>();
  private startupGeneration = 0;
  private startupController: AbortController | null = null;
  private startupPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private profilePublicationPromise: Promise<CoordinatorProfilePublicationResult> | null = null;
  private profilePublicationRequest: string | null = null;
  private readonly config: CoordinatorRuntimeConfig;
  private readonly deps: CoordinatorRuntimeDeps;
  private readonly keyStorage: KeyStorage;
  private readonly onDestroy?: () => void;

  constructor(options: CoordinatorRuntimeOptions) {
    this.config = options.config;
    this.deps = { ...defaultCoordinatorRuntimeDeps, ...options.deps };
    this.keyStorage = options.keyStorage ?? defaultKeyStorage;
    this.onDestroy = options.onDestroy;
    if (this.keyStorage.hasPersisted()) {
      this.state = { ...this.state, loadState: "prompting", persistenceEnabled: true };
      return;
    }

    this.state = { ...this.state, keyManager: KeyManager.generate() };
  }

  /** Register a synchronous change listener. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The current state. Its identity changes only when state changes. */
  getSnapshot(): CoordinatorRuntimeState {
    return this.state;
  }

  private update(patch: Partial<CoordinatorRuntimeState>): void {
    const keys = Object.keys(patch) as Array<keyof CoordinatorRuntimeState>;
    if (keys.every((key) => Object.is(this.state[key], patch[key]))) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  get keyManager() { return this.state.keyManager; }
  get loadState() { return this.state.loadState; }
  get status() { return this.state.status; }
  get error() { return this.state.error; }
  get passphraseError() { return this.state.passphraseError; }
  get persistenceError() { return this.state.persistenceError; }
  get persistenceEnabled() { return this.state.persistenceEnabled; }
  get relayStatuses() { return this.state.relayStatuses; }
  get debugLog() { return this.state.debugLog; }
  get profilePublicationState() { return this.state.profilePublicationState; }
  get startupProgress() { return this.state.startupProgress; }
  get appliedConfigRevision() { return this.state.appliedConfigRevision; }

  get identity() {
    return this.requireKeyManager().identity;
  }

  get locked(): boolean {
    return isConfigLocked(this.status);
  }

  get restartRequired(): boolean {
    return this.status === "running"
      && this.appliedConfigRevision !== null
      && this.appliedConfigRevision !== this.config.runtimeRevision;
  }

  get exhaustedRoomRecoveryTarget(): HostedRoomRecoveryTarget | null {
    if (this.startupProgress.roomRecovery.state !== "exhausted") return null;
    return this.recoveryTargets.find((target) => !this.recoveryCompleted.has(target.roomIdentityKey)) ?? null;
  }

  /**
   * Return the in-process room client only for this running coordinator.
   * Remote rooms intentionally fall back to the public Nostr transport.
   */
  createHostedRoomClient(target: CoordinatorTarget): ChatCoordinatorOperations | null {
    if (!this.running || target.coordinatorPubkey.toLowerCase() !== this.identity.publicKeyHex.toLowerCase()) {
      return null;
    }
    return new LocalHostCoordinatorClient(this.running.coordinator);
  }

  async loadFromPassphrase(passphrase: string): Promise<void> {
    this.update({ passphraseError: null });
    this.addDebugLog("info", "unlocking persisted identity");

    try {
      const secretKey = await this.keyStorage.load(passphrase);
      this.update({ keyManager: KeyManager.fromBytes(secretKey) });
      secretKey.fill(0);
      this.update({ persistenceEnabled: true });
      this.update({ loadState: "ready" });
      this.addDebugLog("info", "persisted identity unlocked", this.identity.npub);
    } catch (error) {
      this.update({ passphraseError: error instanceof WrongPassphraseError ? "Wrong passphrase" : "Could not unlock persisted key" });
      this.addDebugLog("warn", "persisted identity unlock failed", this.passphraseError);
    }
  }

  generateFreshKey(): void {
    this.keyStorage.clear();
    this.update({ keyManager: KeyManager.generate() });
    this.update({ persistenceEnabled: false });
    this.update({ passphraseError: null });
    this.update({ loadState: "ready" });
    this.addDebugLog("info", "fresh identity generated", this.identity.npub);
  }

  async enablePersistence(passphrase: string, confirmPassphrase: string): Promise<boolean> {
    this.update({ persistenceError: null });

    if (passphrase.length === 0) {
      this.update({ persistenceError: "Passphrase is required" });
      return false;
    }

    if (passphrase !== confirmPassphrase) {
      this.update({ persistenceError: "Passphrases do not match" });
      return false;
    }

    const secretKey = this.requireKeyManager().getSecretKeyBytes();
    try {
      await this.keyStorage.save(secretKey, passphrase);
    } catch {
      this.update({ persistenceError: "Could not save persisted key" });
      return false;
    } finally {
      secretKey.fill(0);
    }
    this.update({ persistenceEnabled: true });
    this.addDebugLog("info", "encrypted persistence enabled");
    return true;
  }

  async disablePersistence(): Promise<void> {
    this.keyStorage.clear();
    // The key is gone from here on, even if clearing the room state fails.
    this.update({ persistenceEnabled: false });
    this.update({ persistenceError: null });
    await clearPersistedCoordinatorState();
    this.addDebugLog("info", "encrypted persistence disabled");
  }

  async exportCoordinatorKeyBackup(passphrase: string): Promise<CoordinatorKeyBackup | null> {
    this.update({ persistenceError: null });

    if (!this.persistenceEnabled || !this.keyStorage.hasPersisted()) {
      this.update({ persistenceError: "Enable persistence before exporting this coordinator" });
      return null;
    }

    if (passphrase.length === 0) {
      this.update({ persistenceError: "Passphrase is required" });
      return null;
    }

    try {
      const backup = await this.keyStorage.exportBackup(passphrase);
      if (!this.persistenceEnabled || !this.keyStorage.hasPersisted()) {
        this.update({ persistenceError: "Persistence changed before the export completed" });
        this.addDebugLog("warn", "encrypted coordinator export cancelled", this.persistenceError);
        return null;
      }

      if (backup.identity.publicKeyHex !== this.identity.publicKeyHex) {
        this.update({ persistenceError: "Saved key does not match this coordinator" });
        this.addDebugLog("warn", "encrypted coordinator export rejected", this.persistenceError);
        return null;
      }

      this.addDebugLog("info", "encrypted coordinator backup exported");
      return backup;
    } catch (error) {
      this.update({ persistenceError: error instanceof WrongPassphraseError ? "Wrong passphrase" : "Could not export persisted key" });
      this.addDebugLog("warn", "encrypted coordinator export failed", this.persistenceError);
      return null;
    }
  }

  clearPersistenceError(): void {
    this.update({ persistenceError: null });
  }

  registerHostedRoomRecovery(adapter: HostedRoomRecoveryAdapter): () => void {
    this.hostedRoomRecovery = adapter;
    return () => {
      if (this.hostedRoomRecovery === adapter) this.hostedRoomRecovery = null;
    };
  }

  completeSetupAndPublish(name: unknown): Promise<CoordinatorProfilePublicationResult> {
    if (!this.config.completeSetup(name)) return Promise.resolve({ localSaved: false, published: false });
    return this.publishPersistedCoordinatorProfile();
  }

  saveCoordinatorNameAndPublish(name: unknown): Promise<CoordinatorProfilePublicationResult> {
    if (!this.config.setCoordinatorName(name)) return Promise.resolve({ localSaved: false, published: false });
    return this.publishPersistedCoordinatorProfile();
  }

  retryCoordinatorProfilePublication(): Promise<CoordinatorProfilePublicationResult> {
    if (!this.config.isSetupComplete) return Promise.resolve({ localSaved: false, published: false });
    return this.publishPersistedCoordinatorProfile();
  }

  private publishPersistedCoordinatorProfile(): Promise<CoordinatorProfilePublicationResult> {
    const keyManager = this.requireKeyManager();
    const request = JSON.stringify([
      keyManager.identity.publicKeyHex,
      this.config.coordinatorName,
      this.config.inviteRelayUrls,
    ]);
    if (this.profilePublicationPromise) {
      if (this.profilePublicationRequest === request) return this.profilePublicationPromise;
      // Changed while publishing: the in-flight result does not cover it, so publish again afterwards.
      return this.profilePublicationPromise.then(() => this.publishPersistedCoordinatorProfile());
    }

    this.update({ profilePublicationState: "publishing" });
    const transaction = Promise.resolve()
      .then(() => this.deps.profilePublisher({
        name: this.config.coordinatorName,
        coordinatorPubkey: keyManager.identity.publicKeyHex,
        getSecretKeyBytes: () => keyManager.getSecretKeyBytes(),
        relayUrls: this.config.inviteRelayUrls,
      }))
      .then(() => {
        if (this.profilePublicationPromise === transaction) this.update({ profilePublicationState: "published" });
        return { localSaved: true, published: true };
      })
      .catch(() => {
        if (this.profilePublicationPromise === transaction) {
          this.update({ profilePublicationState: "failed" });
          this.addDebugLog("warn", "coordinator profile publication failed");
        }
        return { localSaved: true, published: false };
      })
      .finally(() => {
        if (this.profilePublicationPromise === transaction) this.profilePublicationPromise = null;
      });
    this.profilePublicationPromise = transaction;
    this.profilePublicationRequest = request;
    return transaction;
  }

  async start(): Promise<void> {
    if (this.startupPromise) return this.startupPromise;
    if (!this.config.isSetupComplete) {
      throw new Error("Complete coordinator setup before starting.");
    }
    // Refuse before taking ownership: a rejected start must not disturb the current generation.
    transitionCoordinator(this.status, "start");
    const generation = ++this.startupGeneration;
    const controller = new AbortController();
    this.startupController = controller;
    const transaction = this.startGeneration(generation, controller.signal);
    this.startupPromise = transaction.finally(() => {
      if (this.startupGeneration === generation) this.startupPromise = null;
    });
    return this.startupPromise;
  }

  private async startGeneration(generation: number, signal: AbortSignal): Promise<void> {
    this.recoveryTargets = [];
    this.recoveryCompleted.clear();
    this.update({ status: transitionCoordinator(this.status, "start") });
    this.setStartupProgress("checking-instance");
    this.config.lock();
    this.update({ error: null });
    this.setEnabledRelayStatuses("connecting");
    this.addDebugLog("info", "coordinator start requested", `${this.config.enabledRelayUrls.length} enabled relays`);

    try {
      const keyManager = this.requireKeyManager();
      const lease = await this.deps.acquireInstanceLease({
        publicKeyHex: keyManager.identity.publicKeyHex,
        relayUrls: this.config.enabledRelayUrls,
        getSecretKeyBytes: () => keyManager.getSecretKeyBytes(),
        debug: (level, message, details) => this.addDebugLog(level, message, details),
      });
      if (!this.ownsGeneration(generation, signal)) {
        await lease.release();
        return;
      }
      this.instanceLease = lease;
      this.registerPagehideRelease(generation);

      const running = await this.deps.createTransport(
        keyManager.getSecretKeyBytes(),
        this.config.enabledRelayUrls,
        this.config.coordinatorOptions,
        this.persistenceEnabled,
        {
          onStartupPhase: ({ phase }) => {
            const detail = phase === "opening-storage"
              ? this.persistenceEnabled
                ? "Loading encrypted room state from this device."
                : "Preparing temporary room state for this session."
              : phase === "connecting-relays"
                ? `Opening ${this.config.enabledRelayUrls.length} configured relay ${this.config.enabledRelayUrls.length === 1 ? "path" : "paths"}.`
                : undefined;
            if (this.ownsGeneration(generation, signal)) this.setStartupProgress(phase, detail);
          },
          onStarted: ({ publicKeyHex, relayUrls }) => {
            if (!this.ownsGeneration(generation, signal)) return;
            this.addDebugLog(
              "info",
              "nostr transport subscribed",
              `${relayUrls.length} relays for ${abbreviateHex(publicKeyHex)}`,
            );
          },
          onNostrEvent: ({ summary }) => {
            this.addDebugLog("info", "raw nostr event received", summary);
          },
          onInboundMessage: ({ method, clientPubkey, summary }) => {
            this.addDebugLog(
              "info",
              "decoded client request",
              `${method} from ${abbreviateHex(clientPubkey)} ${summary}`,
            );
          },
          onNostrPublish: ({ phase, summary }) => {
            this.addDebugLog("info", phase === "attempt" ? "publishing nostr response event" : "nostr response event accepted", summary);
          },
          onRelayPublish: ({ relayUrl, eventId, eventKind, operation, attempt, elapsedMs, outcome }) => {
            this.addDebugLog(
              outcome === "failed" || outcome === "aborted" ? "warn" : "info",
              `relay publish ${outcome}`,
              `${operation} relay=${relayUrl} event=${abbreviateHex(eventId)} kind=${eventKind} attempt=${attempt} elapsed=${elapsedMs}ms`,
            );
          },
          onOutboundMessage: ({ type, summary, error }) => {
            this.addDebugLog(
              error ? "warn" : "info",
              "outbound coordinator response",
              error ? `${type}: ${error} ${summary}` : `${type} ${summary}`,
            );
          },
          onOutboundError: (transportError) => {
            this.addDebugLog("error", "nostr transport error", transportError.message);
          },
          onClosed: () => {
            this.addDebugLog("info", "nostr transport closed");
          },
        },
      );
      if (!this.ownsGeneration(generation, signal)) {
        this.deps.closeTransport(running);
        return;
      }
      this.running = running;
      this.setEnabledRelayStatuses("connected");
      const recovered = await this.recoverHostedRooms(generation, signal);
      if (!recovered || !this.ownsGeneration(generation, signal)) return;
      this.update({ status: transitionCoordinator(this.status, "started") });
      this.update({ appliedConfigRevision: this.config.runtimeRevision });
      this.deps.startResourceMonitor(this.running);
      this.addDebugLog("info", "coordinator started", keyManager.identity.npub);
    } catch (error) {
      await this.failStartup(generation, signal, error);
    }
  }

  private async failStartup(generation: number, signal: AbortSignal, error: unknown): Promise<void> {
    if (!this.ownsGeneration(generation, signal)) return;
    await this.releaseResources();
    const message = error instanceof Error ? error.message : "Coordinator startup failed";
    this.update({ error: message });
    this.setStartupProgress("failed", message);
    if (message === INSTANCE_RUNNING_MESSAGE) {
      this.addDebugLog("warn", INSTANCE_RUNNING_MESSAGE);
    } else {
      this.addDebugLog("error", "coordinator startup failed", message);
    }
    this.setEnabledRelayStatuses("error");
    this.update({ status: transitionCoordinator(this.status, "error") });
  }

  /** Release resources without letting a failing cleanup step wedge the lifecycle. */
  private async releaseResources(): Promise<void> {
    try {
      await this.stopSync();
    } catch (error) {
      this.addDebugLog("warn", "coordinator cleanup failed", error instanceof Error ? error.message : String(error));
    }
  }

  /** Stop the coordinator. Safe to call repeatedly and while already idle. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.status === "idle" && !this.startupPromise) return Promise.resolve();
    const transaction = this.stopOnce().finally(() => {
      this.stopPromise = null;
    });
    this.stopPromise = transaction;
    return transaction;
  }

  private async stopOnce(): Promise<void> {
    this.addDebugLog("info", "coordinator stop requested");
    this.startupGeneration += 1;
    this.startupController?.abort();
    this.startupController = null;
    const activeStartup = this.startupPromise;
    // A startup rejection belongs to the start() caller; it must not abort this shutdown.
    if (activeStartup) await activeStartup.catch(() => undefined);
    this.startupPromise = null;
    // A startup that failed on its own has already returned to idle.
    if (this.status === "idle") return;
    this.update({ status: transitionCoordinator(this.status, "stop") });
    await this.releaseResources();
    this.recoveryTargets = [];
    this.recoveryCompleted.clear();
    this.update({ relayStatuses: {} });
    this.update({ status: transitionCoordinator(this.status, "stopped") });
    this.setStartupProgress("idle");
    this.addDebugLog("info", "coordinator stopped");
  }

  async restart(): Promise<void> {
    if (this.status !== "running" && this.status !== "starting") return;
    this.addDebugLog("info", "coordinator restart requested", "applying updated settings");
    await this.stop();
    await this.start();
  }

  /**
   * Delete a room through the local host control plane. This is deliberately
   * not registered as a coordinator RPC method.
   */
  async deleteHostedRoom(target: { id: string; coordinatorPubkey: string }): Promise<void> {
    const normalizedGroupId = target.id.trim();
    if (normalizedGroupId.length === 0) {
      throw new Error("Room id is required");
    }
    const targetCoordinatorPubkey = target.coordinatorPubkey.trim().toLowerCase();
    const localCoordinatorPubkey = this.identity.publicKeyHex.toLowerCase();
    if (!targetCoordinatorPubkey || targetCoordinatorPubkey !== localCoordinatorPubkey) {
      throw new Error("Cannot delete a room hosted by another coordinator");
    }

    try {
      if (this.running) {
        this.running.coordinator.deleteGroup(normalizedGroupId);
      } else {
        const storage = await (this.deps.createStorage ?? createBrowserCoordinatorStorage)(
          this.persistenceEnabled,
          this.identity.publicKeyHex,
        );
        try {
          storage.deleteGroup(normalizedGroupId);
        } finally {
          storage.close?.();
        }
      }
      this.addDebugLog("info", "hosted room deleted", normalizedGroupId);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      this.addDebugLog("warn", "hosted room deletion failed", details);
      throw error;
    }
  }

  async stopSync(): Promise<void> {
    this.deps.stopResourceMonitor();
    const running = this.running;
    this.running = null;
    try {
      if (running) this.deps.closeTransport(running);
    } finally {
      await this.releaseInstanceLease();
    }
  }

  private async recoverHostedRooms(generation: number, signal: AbortSignal): Promise<boolean> {
    const adapter = this.hostedRoomRecovery;
    if (!adapter) {
      this.recoveryTargets = [];
      this.recoveryCompleted.clear();
      this.setRoomRecoveryProgress("complete", 0, 0, null, 0);
      return true;
    }

    if (this.recoveryTargets.length === 0) {
      const listed = await adapter.listTargets();
      if (!this.ownsGeneration(generation, signal)) return false;
      const unique: Record<string, HostedRoomRecoveryTarget> = {};
      for (const target of listed) {
        if (!target.roomIdentityKey || !target.coordinatorPubkey || !target.roomId || !target.roomName) continue;
        unique[target.roomIdentityKey] = target;
      }
      this.recoveryTargets = Object.values(unique).sort((left, right) => left.roomIdentityKey.localeCompare(right.roomIdentityKey));
      this.recoveryCompleted.clear();
    }

    const total = this.recoveryTargets.length;
    if (total === 0) {
      this.setRoomRecoveryProgress("complete", 0, 0, null, 0, "No rooms to restore");
      // Keep the approved zero-room completion visible long enough to be perceived before ready.
      await this.deps.wait(500, signal);
      if (!this.ownsGeneration(generation, signal)) return false;
      return true;
    }

    for (const target of this.recoveryTargets) {
      if (this.recoveryCompleted.has(target.roomIdentityKey)) continue;
      for (let attempt = 1; attempt <= ROOM_RECOVERY_POLICY.maxAttempts; attempt += 1) {
        if (!this.ownsGeneration(generation, signal)) return false;
        this.setRoomRecoveryProgress(attempt === 1 ? "restoring" : "retrying", this.recoveryCompleted.size, total, target.roomName, attempt);
        try {
          await this.deps.runAttempt(
            (attemptSignal) => adapter.recover(target, attemptSignal),
            ROOM_RECOVERY_POLICY.attemptTimeoutMs[attempt - 1]!,
            signal,
          );
          if (!this.ownsGeneration(generation, signal)) {
            await adapter.discard?.(target);
            return false;
          }
          this.recoveryCompleted.add(target.roomIdentityKey);
          this.setRoomRecoveryProgress("restoring", this.recoveryCompleted.size, total, target.roomName, attempt);
          break;
        } catch (error) {
          const details = error instanceof Error ? error.message : String(error);
          this.addDebugLog(
            "warn",
            "hosted room recovery attempt failed",
            `# ${target.roomName} attempt ${attempt}/${ROOM_RECOVERY_POLICY.maxAttempts}: ${details}`,
          );
          await adapter.discard?.(target);
          if (!this.ownsGeneration(generation, signal)) {
            return false;
          }
          if (attempt === ROOM_RECOVERY_POLICY.maxAttempts) {
            this.setRoomRecoveryProgress("exhausted", this.recoveryCompleted.size, total, target.roomName, attempt, "Check your connection, then retry recovery.");
            return false;
          }
          this.setRoomRecoveryProgress("retrying", this.recoveryCompleted.size, total, target.roomName, attempt, "Trying again…");
          await this.deps.wait(ROOM_RECOVERY_POLICY.retryDelayMs[attempt - 1]!, signal);
        }
      }
    }

    this.setRoomRecoveryProgress("complete", this.recoveryCompleted.size, total, null, 0);
    return true;
  }

  private setRoomRecoveryProgress(
    state: HostedRoomRecoveryProgress["state"],
    completed: number,
    total: number,
    roomName: string | null,
    attempt: number,
    diagnostic?: string,
  ): void {
    const roomRecovery = createHostedRoomRecoveryProgress({ state, completed, total, roomName, attempt, diagnostic });
    this.update({ startupProgress: startupProgress(
      state === "complete" && total > 0 ? "online" : "restoring-rooms",
      state === "complete" ? undefined : roomRecovery.diagnostic || `Restoring # ${roomName}`,
      roomRecovery,
    ) });
  }

  private ownsGeneration(generation: number, signal: AbortSignal): boolean {
    return this.startupGeneration === generation && !signal.aborted;
  }

  async retryRoomRecovery(): Promise<void> {
    if (this.startupPromise) return this.startupPromise;
    if (this.status !== "starting" || this.startupProgress.roomRecovery.state !== "exhausted" || !this.running) return;
    const generation = ++this.startupGeneration;
    const controller = new AbortController();
    this.startupController = controller;
    this.registerPagehideRelease(generation);
    const transaction = this.recoverHostedRooms(generation, controller.signal).then((recovered) => {
      if (!recovered || !this.ownsGeneration(generation, controller.signal)) return;
      this.update({ status: transitionCoordinator(this.status, "started") });
      this.update({ appliedConfigRevision: this.config.runtimeRevision });
      this.deps.startResourceMonitor(this.running!);
      this.addDebugLog("info", "coordinator started", this.identity.npub);
    }).catch((error: unknown) => this.failStartup(generation, controller.signal, error));
    this.startupPromise = transaction.finally(() => {
      if (this.startupGeneration === generation) this.startupPromise = null;
    });
    return this.startupPromise;
  }

  async resumeAfterRemovingFailedRoom(target: { roomId: string; coordinatorPubkey: string }): Promise<void> {
    const failedTarget = this.exhaustedRoomRecoveryTarget;
    const targetCoordinatorPubkey = target.coordinatorPubkey.trim().toLowerCase();
    if (!failedTarget
      || failedTarget.roomId !== target.roomId
      || failedTarget.coordinatorPubkey.toLowerCase() !== targetCoordinatorPubkey) {
      throw new Error("Failed recovery room changed");
    }

    this.recoveryTargets = this.recoveryTargets.filter(
      (candidate) => candidate.roomIdentityKey !== failedTarget.roomIdentityKey,
    );
    this.recoveryCompleted.delete(failedTarget.roomIdentityKey);
    this.addDebugLog("warn", "removed unrecoverable hosted room from startup", failedTarget.roomName);
    await this.retryRoomRecovery();
  }

  dismissError(): void {
    this.update({ error: null });
  }

  async destroy(): Promise<void> {
    const destroyedCoordinatorPubkey = this.identity.publicKeyHex;
    if (this.status !== "idle") {
      await this.stop();
    } else {
      await this.stopSync();
    }

    removeHostedRoomsForCoordinator(destroyedCoordinatorPubkey);
    this.onDestroy?.();
    getRoomEnvironment().events.dispatchEvent(new CustomEvent(ROOMS_CHANGED_EVENT, { detail: { action: "destroyed" } }));
    this.destroyStateSynchronously();
    await clearPersistedCoordinatorState();
    await this.clearBrowserCaches();
    clearCoordinatorInstanceRecords(destroyedCoordinatorPubkey);
  }

  private destroyStateSynchronously(): void {
    this.deps.stopResourceMonitor();
    this.profilePublicationPromise = null;
    this.profilePublicationRequest = null;
    this.update({ profilePublicationState: "idle" });
    this.keyManager?.destroy();
    this.keyStorage.clear();
    this.update({ keyManager: KeyManager.generate() });
    this.update({ persistenceEnabled: false });
    this.update({ persistenceError: null });
    this.update({ passphraseError: null });
    this.update({ relayStatuses: {} });
    this.update({ appliedConfigRevision: null });
    this.update({ error: null });
    this.setStartupProgress("idle");
    this.config.resetToDefaults();
    this.update({ status: "idle" });
    this.update({ loadState: "ready" });
    this.update({ debugLog: [] });
    this.addDebugLog("info", "coordinator state destroyed", this.identity.npub);
  }

  clearDebugLog(): void {
    if (this.debugLog.length > 0) this.update({ debugLog: [] });
  }

  private setEnabledRelayStatuses(status: RelayConnectionStatus): void {
    this.update({ relayStatuses: Object.fromEntries(
      this.config.enabledRelayUrls.map((url) => [url, status]),
    ) });
  }

  private setStartupProgress(phase: CoordinatorStartupPhase, detail?: string): void {
    this.update({ startupProgress: startupProgress(phase, detail) });
  }

  private requireKeyManager(): KeyManager {
    if (!this.keyManager) {
      throw new Error("Coordinator key is not loaded");
    }

    return this.keyManager;
  }

  private addDebugLog(level: DebugLogEntry["level"], message: string, details?: string | null): void {
    const timestamp = Date.now();
    const entry: DebugLogEntry = {
      id: crypto.randomUUID(),
      timestamp,
      timeLabel: debugTimeFormatter.format(timestamp),
      level,
      message,
      details: details ?? undefined,
    };
    this.update({ debugLog: [...this.debugLog, entry].slice(-80) });
  }

  private async releaseInstanceLease(): Promise<void> {
    this.pagehideRelease?.();
    this.pagehideRelease = null;
    const lease = this.instanceLease;
    this.instanceLease = null;
    await lease?.release();
  }

  private registerPagehideRelease(generation: number): void {
    this.pagehideRelease?.();

    const handler = (): void => {
      if (this.startupGeneration !== generation) return;
      this.startupController?.abort();
      this.addDebugLog("info", "page unloading; releasing coordinator instance lease");
      void this.releaseInstanceLease().catch((error: unknown) => {
        this.addDebugLog("warn", "coordinator cleanup failed", error instanceof Error ? error.message : String(error));
      });
    };

    const target = globalThis as unknown as Partial<EventTarget>;
    if (typeof target.addEventListener !== "function") return;
    target.addEventListener("pagehide", handler, { once: true });
    this.pagehideRelease = () => target.removeEventListener?.("pagehide", handler);
  }

  private async clearBrowserCaches(): Promise<void> {
    if (!("caches" in globalThis)) {
      return;
    }

    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map((name) => caches.delete(name)));
  }
}

function abbreviateHex(value: string): string {
  if (value.length <= 16) {
    return value;
  }

  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}
