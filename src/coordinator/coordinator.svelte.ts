import { configStore, type BrowserCoordinatorOptions } from "../config/config.svelte";
import { SvelteSet } from "svelte/reactivity";
import {
  CoordinatorStorageFailure,
  clearPersistedCoordinatorState,
  createBrowserCoordinatorStorage,
  removePersistedCoordinatorSnapshot,
  type CoordinatorStorageFailureKind,
} from "../cordn/coordinator/storage/indexedDbSnapshotStorage";
import { KeyManager } from "../crypto/key-manager";
import {
  keyStorage,
  WrongPassphraseError,
  type CoordinatorKeyBackup,
} from "../crypto/key-storage";
import { transportFactory, type RunningTransport, type TransportDiagnostics } from "../lib/transport";
import { removeHostedRoomsForCoordinator, ROOMS_CHANGED_EVENT } from "../chat/room-store";
import { SIDEBAR_LEDGER_KEY } from "../chat/sidebar-ledger";
import {
  CHAT_COORDINATOR_CONNECT_TIMEOUT_MS,
  CHAT_COORDINATOR_REQUEST_TIMEOUT_MS,
  type ChatCoordinatorOperations,
  type CoordinatorTarget,
} from "../chat/coordinator-client";
import { LocalHostCoordinatorClient } from "../chat/local-coordinator-client";
import { resourceMonitor } from "./resource-monitor.svelte";
import {
  publishCoordinatorProfile,
  type CoordinatorProfilePublisherInput,
} from "./coordinator-profile";
import {
  clearCoordinatorInstanceRecords,
  INSTANCE_RUNNING_MESSAGE,
  SingleInstanceGuard,
  type InstanceLease,
  type SingleInstanceAcquireInput,
} from "./single-instance-guard";
import { isConfigLocked, transitionCoordinator } from "./state-machine";
import { createHostedRoomRecoveryProgress } from "./types";
import type {
  CoordinatorLoadState,
  CoordinatorStartupPhase,
  CoordinatorStartupProgress,
  CoordinatorStatus,
  HostedRoomRecoveryAdapter,
  HostedRoomRecoveryProgress,
  HostedRoomRecoveryTarget,
  RelayConnectionStatus,
} from "./types";

export interface DebugLogEntry {
  id: string;
  timestamp: number;
  timeLabel: string;
  level: "info" | "warn" | "error";
  message: string;
  details?: string;
}

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

export interface CoordinatorStoreRuntime {
  acquireInstanceLease(input: SingleInstanceAcquireInput): Promise<InstanceLease>;
  createTransport(
    privateKey: Uint8Array,
    relayUrls: string[],
    options: BrowserCoordinatorOptions,
    persistent: boolean,
    diagnostics?: TransportDiagnostics,
  ): Promise<RunningTransport>;
  closeTransport(transport: RunningTransport): void;
  startResourceMonitor(transport: RunningTransport): void;
  stopResourceMonitor(): void;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  runAttempt(operation: (signal: AbortSignal) => Promise<void>, timeoutMs: number, signal: AbortSignal): Promise<void>;
  profilePublisher(input: CoordinatorProfilePublisherInput): Promise<unknown>;
}

export type CoordinatorProfilePublicationState = "idle" | "publishing" | "published" | "failed";
export type SnapshotPersistenceState = "checking" | "durable" | "temporary" | "attention" | "flushing" | "flush-failed";

export interface CoordinatorProfilePublicationResult {
  localSaved: boolean;
  published: boolean;
}

function abortError(): DOMException {
  return new DOMException("Recovery cancelled", "AbortError");
}

export const defaultCoordinatorStoreRuntime: CoordinatorStoreRuntime = {
  acquireInstanceLease(input) {
    return new SingleInstanceGuard().acquire(input);
  },
  createTransport(privateKey, relayUrls, options, persistent, diagnostics) {
    return transportFactory.create(privateKey, relayUrls, options, persistent, diagnostics);
  },
  closeTransport(transport) {
    transport.close();
  },
  startResourceMonitor(transport) {
    resourceMonitor.start(transport);
  },
  stopResourceMonitor() {
    resourceMonitor.stop();
  },
  wait(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const timer = window.setTimeout(resolve, milliseconds);
      signal.addEventListener("abort", () => {
        window.clearTimeout(timer);
        reject(abortError());
      }, { once: true });
    });
  },
  async runAttempt(operation, timeoutMs, signal) {
    if (signal.aborted) throw abortError();
    const attemptController = new AbortController();
    const abort = () => attemptController.abort();
    signal.addEventListener("abort", abort, { once: true });
    let timer: number | null = null;
    try {
      await Promise.race([
        operation(attemptController.signal),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => {
            attemptController.abort();
            reject(new Error("Hosted room recovery timed out"));
          }, timeoutMs);
          signal.addEventListener("abort", () => {
            if (timer !== null) window.clearTimeout(timer);
            reject(abortError());
          }, { once: true });
        }),
      ]);
    } finally {
      if (timer !== null) window.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
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

export class CoordinatorStore {
  keyManager = $state<KeyManager | null>(null);
  loadState = $state<CoordinatorLoadState>("ready");
  status = $state<CoordinatorStatus>("idle");
  error = $state<string | null>(null);
  passphraseError = $state<string | null>(null);
  persistenceError = $state<string | null>(null);
  persistenceEnabled = $state(false);
  snapshotPersistence = $state<SnapshotPersistenceState>("temporary");
  snapshotFailureKind = $state<CoordinatorStorageFailureKind | null>(null);
  private snapshotTemporarySession = $state(false);
  relayStatuses = $state<Record<string, RelayConnectionStatus>>({});
  debugLog = $state<DebugLogEntry[]>([]);
  profilePublicationState = $state<CoordinatorProfilePublicationState>("idle");
  startupProgress = $state<CoordinatorStartupProgress>(startupProgress("idle"));
  appliedConfigRevision = $state<number | null>(null);
  private running: RunningTransport | null = null;
  private instanceLease: InstanceLease | null = null;
  private pagehideRelease: (() => void) | null = null;
  private hostedRoomRecovery: HostedRoomRecoveryAdapter | null = null;
  private recoveryTargets: readonly HostedRoomRecoveryTarget[] = [];
  private recoveryCompleted = new SvelteSet<string>();
  private startupGeneration = 0;
  private startupController: AbortController | null = null;
  private startupPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private profilePublicationPromise: Promise<CoordinatorProfilePublicationResult> | null = null;
  private readonly runtime: CoordinatorStoreRuntime;

  constructor(runtime: CoordinatorStoreRuntime = defaultCoordinatorStoreRuntime) {
    this.runtime = runtime;
    if (keyStorage.hasPersisted()) {
      this.loadState = "prompting";
      this.persistenceEnabled = true;
      return;
    }

    this.keyManager = KeyManager.generate();
  }

  get identity() {
    return this.requireKeyManager().identity;
  }

  get locked(): boolean {
    return isConfigLocked(this.status);
  }

  get restartRequired(): boolean {
    return this.status === "running"
      && this.appliedConfigRevision !== null
      && this.appliedConfigRevision !== configStore.runtimeRevision;
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
    this.passphraseError = null;
    this.addDebugLog("info", "unlocking persisted identity");

    try {
      const secretKey = await keyStorage.load(passphrase);
      this.keyManager = KeyManager.fromBytes(secretKey);
      secretKey.fill(0);
      this.persistenceEnabled = true;
      this.loadState = "ready";
      this.addDebugLog("info", "persisted identity unlocked", this.identity.npub);
    } catch (error) {
      this.passphraseError =
        error instanceof WrongPassphraseError ? "Wrong passphrase" : "Could not unlock persisted key";
      this.addDebugLog("warn", "persisted identity unlock failed", this.passphraseError);
    }
  }

  generateFreshKey(): void {
    keyStorage.clear();
    this.keyManager = KeyManager.generate();
    this.persistenceEnabled = false;
    this.passphraseError = null;
    this.loadState = "ready";
    this.addDebugLog("info", "fresh identity generated", this.identity.npub);
  }

  async enablePersistence(passphrase: string, confirmPassphrase: string): Promise<boolean> {
    this.persistenceError = null;

    if (passphrase.length === 0) {
      this.persistenceError = "Passphrase is required";
      return false;
    }

    if (passphrase !== confirmPassphrase) {
      this.persistenceError = "Passphrases do not match";
      return false;
    }

    await keyStorage.save(this.requireKeyManager().getSecretKeyBytes(), passphrase);
    this.persistenceEnabled = true;
    this.addDebugLog("info", "encrypted persistence enabled");
    return true;
  }

  async disablePersistence(): Promise<void> {
    keyStorage.clear();
    await clearPersistedCoordinatorState();
    this.persistenceEnabled = false;
    this.persistenceError = null;
    this.addDebugLog("info", "encrypted persistence disabled");
  }

  async exportCoordinatorKeyBackup(passphrase: string): Promise<CoordinatorKeyBackup | null> {
    this.persistenceError = null;

    if (!this.persistenceEnabled || !keyStorage.hasPersisted()) {
      this.persistenceError = "Enable persistence before exporting this coordinator";
      return null;
    }

    if (passphrase.length === 0) {
      this.persistenceError = "Passphrase is required";
      return null;
    }

    try {
      const backup = await keyStorage.exportBackup(passphrase);
      if (!this.persistenceEnabled || !keyStorage.hasPersisted()) {
        this.persistenceError = "Persistence changed before the export completed";
        this.addDebugLog("warn", "encrypted coordinator export cancelled", this.persistenceError);
        return null;
      }

      if (backup.identity.publicKeyHex !== this.identity.publicKeyHex) {
        this.persistenceError = "Saved key does not match this coordinator";
        this.addDebugLog("warn", "encrypted coordinator export rejected", this.persistenceError);
        return null;
      }

      this.addDebugLog("info", "encrypted coordinator backup exported");
      return backup;
    } catch (error) {
      this.persistenceError =
        error instanceof WrongPassphraseError ? "Wrong passphrase" : "Could not export persisted key";
      this.addDebugLog("warn", "encrypted coordinator export failed", this.persistenceError);
      return null;
    }
  }

  clearPersistenceError(): void {
    this.persistenceError = null;
  }

  registerHostedRoomRecovery(adapter: HostedRoomRecoveryAdapter): () => void {
    this.hostedRoomRecovery = adapter;
    return () => {
      if (this.hostedRoomRecovery === adapter) this.hostedRoomRecovery = null;
    };
  }

  completeSetupAndPublish(name: unknown): Promise<CoordinatorProfilePublicationResult> {
    if (!configStore.completeSetup(name)) return Promise.resolve({ localSaved: false, published: false });
    return this.publishPersistedCoordinatorProfile();
  }

  saveCoordinatorNameAndPublish(name: unknown): Promise<CoordinatorProfilePublicationResult> {
    if (!configStore.setCoordinatorName(name)) return Promise.resolve({ localSaved: false, published: false });
    return this.publishPersistedCoordinatorProfile();
  }

  retryCoordinatorProfilePublication(): Promise<CoordinatorProfilePublicationResult> {
    if (!configStore.isSetupComplete) return Promise.resolve({ localSaved: false, published: false });
    return this.publishPersistedCoordinatorProfile();
  }

  private publishPersistedCoordinatorProfile(): Promise<CoordinatorProfilePublicationResult> {
    if (this.profilePublicationPromise) return this.profilePublicationPromise;

    const keyManager = this.requireKeyManager();
    this.profilePublicationState = "publishing";
    const transaction = Promise.resolve()
      .then(() => this.runtime.profilePublisher({
        name: configStore.coordinatorName,
        coordinatorPubkey: keyManager.identity.publicKeyHex,
        getSecretKeyBytes: () => keyManager.getSecretKeyBytes(),
        relayUrls: configStore.inviteRelayUrls,
      }))
      .then(() => {
        this.profilePublicationState = "published";
        return { localSaved: true, published: true };
      })
      .catch(() => {
        this.profilePublicationState = "failed";
        this.addDebugLog("warn", "coordinator profile publication failed");
        return { localSaved: true, published: false };
      })
      .finally(() => {
        if (this.profilePublicationPromise === transaction) this.profilePublicationPromise = null;
      });
    this.profilePublicationPromise = transaction;
    return transaction;
  }

  async start(): Promise<void> {
    if (this.startupPromise) return this.startupPromise;
    if (!configStore.isSetupComplete) {
      throw new Error("Complete coordinator setup before starting.");
    }
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
    this.status = transitionCoordinator(this.status, "start");
    this.snapshotPersistence = this.persistenceEnabled && !this.snapshotTemporarySession ? "checking" : "temporary";
    this.setStartupProgress("checking-instance");
    configStore.lock();
    this.error = null;
    this.setEnabledRelayStatuses("connecting");
    this.addDebugLog("info", "coordinator start requested", `${configStore.enabledRelayUrls.length} enabled relays`);

    try {
      const keyManager = this.requireKeyManager();
      const lease = await this.runtime.acquireInstanceLease({
        publicKeyHex: keyManager.identity.publicKeyHex,
        relayUrls: configStore.enabledRelayUrls,
        getSecretKeyBytes: () => keyManager.getSecretKeyBytes(),
        debug: (level, message, details) => this.addDebugLog(level, message, details),
      });
      if (!this.ownsGeneration(generation, signal)) {
        await lease.release();
        return;
      }
      this.instanceLease = lease;
      this.registerPagehideRelease(generation);

      const running = await this.runtime.createTransport(
        keyManager.getSecretKeyBytes(),
        configStore.enabledRelayUrls,
        configStore.coordinatorOptions,
        this.persistenceEnabled && !this.snapshotTemporarySession,
        {
          onStartupPhase: ({ phase }) => {
            const detail = phase === "opening-storage"
              ? this.persistenceEnabled && !this.snapshotTemporarySession
                ? "Loading encrypted room state from this device."
                : "Preparing temporary room state for this session."
              : phase === "connecting-relays"
                ? `Opening ${configStore.enabledRelayUrls.length} configured relay ${configStore.enabledRelayUrls.length === 1 ? "path" : "paths"}.`
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
        this.runtime.closeTransport(running);
        return;
      }
      this.running = running;
      this.snapshotPersistence = this.persistenceEnabled && !this.snapshotTemporarySession ? "durable" : "temporary";
      this.setEnabledRelayStatuses("connected");
      const recovered = await this.recoverHostedRooms(generation, signal);
      if (!recovered || !this.ownsGeneration(generation, signal)) return;
      this.status = transitionCoordinator(this.status, "started");
      this.appliedConfigRevision = configStore.runtimeRevision;
      this.runtime.startResourceMonitor(this.running);
      this.addDebugLog("info", "coordinator started", keyManager.identity.npub);
    } catch (error) {
      if (!this.ownsGeneration(generation, signal)) return;
      this.running = null;
      await this.releaseInstanceLease();
      this.runtime.stopResourceMonitor();
      if (error instanceof CoordinatorStorageFailure) {
        this.snapshotPersistence = "attention";
        this.snapshotFailureKind = error.kind;
        this.error = "Storage needs attention";
      } else {
        this.error = error instanceof Error ? error.message : "Coordinator startup failed";
      }
      this.setStartupProgress("failed", this.error);
      if (this.error === INSTANCE_RUNNING_MESSAGE) {
        this.addDebugLog("warn", INSTANCE_RUNNING_MESSAGE);
      } else {
        this.addDebugLog("error", "coordinator startup failed", this.error);
      }
      this.setEnabledRelayStatuses("error");
      this.status = transitionCoordinator(this.status, "error");
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const transaction = this.stopCurrentGeneration(false).finally(() => {
      if (this.stopPromise === transaction) this.stopPromise = null;
    });
    this.stopPromise = transaction;
    return transaction;
  }

  async stopWithoutSaving(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const transaction = this.stopCurrentGeneration(true).finally(() => {
      if (this.stopPromise === transaction) this.stopPromise = null;
    });
    this.stopPromise = transaction;
    return transaction;
  }

  async retrySnapshotFlush(): Promise<void> {
    if (!this.running) return;
    this.snapshotPersistence = "flushing";
    try {
      await this.running.flush?.();
      this.snapshotPersistence = this.persistenceEnabled && !this.snapshotTemporarySession ? "durable" : "temporary";
    } catch {
      this.snapshotPersistence = "flush-failed";
    }
  }

  async retryStorage(): Promise<void> {
    if (this.snapshotPersistence !== "attention") return;
    await this.start();
  }

  async removeCorruptSnapshot(): Promise<void> {
    if (this.snapshotFailureKind !== "corrupt") return;
    await removePersistedCoordinatorSnapshot(this.identity.publicKeyHex);
    this.snapshotFailureKind = null;
    await this.retryStorage();
  }

  async continueTemporarily(): Promise<void> {
    if (this.snapshotPersistence !== "attention") return;
    this.snapshotTemporarySession = true;
    await this.start();
  }

  private async stopCurrentGeneration(abandonPersistence: boolean): Promise<void> {
    this.addDebugLog("info", "coordinator stop requested");
    this.startupGeneration += 1;
    this.startupController?.abort();
    this.startupController = null;
    const activeStartup = this.startupPromise;
    if (activeStartup) await activeStartup;
    if (this.startupPromise === activeStartup) this.startupPromise = null;
    if (this.running && !abandonPersistence) {
      this.snapshotPersistence = "flushing";
      try {
        await this.running.flush?.();
      } catch {
        // Never replace a usable running transport with a false successful
        // stop. The recovery UI owns retry, keep-running, or explicit abandon.
        this.snapshotPersistence = "flush-failed";
        this.addDebugLog("warn", "coordinator snapshot flush failed");
        return;
      }
    }
    this.status = transitionCoordinator(this.status, "stop");
    await this.stopSync();
    this.recoveryTargets = [];
    this.recoveryCompleted.clear();
    this.relayStatuses = {};
    this.status = transitionCoordinator(this.status, "stopped");
    this.snapshotPersistence = abandonPersistence
      ? "temporary"
      : this.persistenceEnabled && !this.snapshotTemporarySession ? "durable" : "temporary";
    this.setStartupProgress("idle");
    this.addDebugLog("info", "coordinator stopped");
  }

  async restart(): Promise<void> {
    if (this.status !== "running" && this.status !== "starting") return;
    this.addDebugLog("info", "coordinator restart requested", "applying updated settings");
    await this.stop();
    if (!this.isStopped()) return;
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
        const storage = await createBrowserCoordinatorStorage(
          this.persistenceEnabled,
          this.identity.publicKeyHex,
        );
        try {
          storage.deleteGroup(normalizedGroupId);
        } finally {
          storage.close();
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
    this.runtime.stopResourceMonitor();
    if (this.running) this.runtime.closeTransport(this.running);
    this.running = null;
    await this.releaseInstanceLease();
  }

  private isStopped(): boolean {
    return this.status === "idle";
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
      await this.runtime.wait(500, signal);
      if (!this.ownsGeneration(generation, signal)) return false;
      return true;
    }

    for (const target of this.recoveryTargets) {
      if (this.recoveryCompleted.has(target.roomIdentityKey)) continue;
      let succeeded = false;
      for (let attempt = 1; attempt <= ROOM_RECOVERY_POLICY.maxAttempts; attempt += 1) {
        if (!this.ownsGeneration(generation, signal)) return false;
        this.setRoomRecoveryProgress(attempt === 1 ? "restoring" : "retrying", this.recoveryCompleted.size, total, target.roomName, attempt);
        try {
          await this.runtime.runAttempt(
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
          succeeded = true;
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
          await this.runtime.wait(ROOM_RECOVERY_POLICY.retryDelayMs[attempt - 1]!, signal);
        }
      }
      if (!succeeded) return false;
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
    this.startupProgress = startupProgress(
      state === "complete" && total > 0 ? "online" : "restoring-rooms",
      state === "complete" ? undefined : roomRecovery.diagnostic || `Restoring # ${roomName ?? "room"}`,
      roomRecovery,
    );
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
    const transaction = this.recoverHostedRooms(generation, controller.signal).then((recovered) => {
      if (!recovered || !this.ownsGeneration(generation, controller.signal)) return;
      this.status = transitionCoordinator(this.status, "started");
      this.appliedConfigRevision = configStore.runtimeRevision;
      this.runtime.startResourceMonitor(this.running!);
    });
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
    this.error = null;
  }

  async destroy(): Promise<void> {
    const destroyedCoordinatorPubkey = this.identity.publicKeyHex;
    if (this.status === "running") {
      await this.stop();
    } else {
      await this.stopSync();
    }

    removeHostedRoomsForCoordinator(destroyedCoordinatorPubkey);
    localStorage.removeItem(SIDEBAR_LEDGER_KEY);
    window.dispatchEvent(new CustomEvent(ROOMS_CHANGED_EVENT, { detail: { action: "destroyed" } }));
    this.destroyStateSynchronously();
    await clearPersistedCoordinatorState();
    await this.clearBrowserCaches();
    clearCoordinatorInstanceRecords(destroyedCoordinatorPubkey);
  }

  private destroyStateSynchronously(): void {
    this.runtime.stopResourceMonitor();
    this.keyManager?.destroy();
    keyStorage.clear();
    this.keyManager = KeyManager.generate();
    this.persistenceEnabled = false;
    this.persistenceError = null;
    this.passphraseError = null;
    this.relayStatuses = {};
    this.appliedConfigRevision = null;
    this.error = null;
    this.setStartupProgress("idle");
    configStore.resetToDefaults();
    this.status = "idle";
    this.loadState = "ready";
    this.debugLog = [];
    this.addDebugLog("info", "coordinator state destroyed", this.identity.npub);
  }

  clearDebugLog(): void {
    this.debugLog = [];
  }

  private setEnabledRelayStatuses(status: RelayConnectionStatus): void {
    this.relayStatuses = Object.fromEntries(
      configStore.enabledRelayUrls.map((url) => [url, status]),
    );
  }

  private setStartupProgress(phase: CoordinatorStartupPhase, detail?: string): void {
    this.startupProgress = startupProgress(phase, detail);
  }

  private requireKeyManager(): KeyManager {
    if (!this.keyManager) {
      throw new Error("Coordinator key is not loaded");
    }

    return this.keyManager;
  }

  private addDebugLog(level: DebugLogEntry["level"], message: string, details?: string): void {
    const timestamp = Date.now();
    const entry: DebugLogEntry = {
      id: crypto.randomUUID(),
      timestamp,
      timeLabel: debugTimeFormatter.format(timestamp),
      level,
      message,
      details,
    };
    this.debugLog = [...this.debugLog, entry].slice(-80);
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
      void this.releaseInstanceLease();
    };

    globalThis.addEventListener("pagehide", handler, { once: true });
    this.pagehideRelease = () => globalThis.removeEventListener("pagehide", handler);
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

export const coordinatorStore = new CoordinatorStore();
