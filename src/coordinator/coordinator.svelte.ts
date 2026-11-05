import "../sdk-bindings";
import {
  CoordinatorRuntime,
  defaultCoordinatorRuntimeDeps,
  type CoordinatorProfilePublicationResult,
  type CoordinatorProfilePublicationState,
  type CoordinatorRuntimeDeps,
  type CoordinatorRuntimeState,
  type CoordinatorStartupProgress,
  type CoordinatorLoadState,
  type CoordinatorStatus,
  type DebugLogEntry,
  type HostedRoomRecoveryAdapter,
  type RelayConnectionStatus,
} from "@cahmls/sdk/runtime";
import type { ChatCoordinatorOperations, CoordinatorTarget } from "@cahmls/sdk/client";
import type { KeyManager } from "@cahmls/sdk/crypto";
import { SIDEBAR_LEDGER_KEY } from "../chat/sidebar-ledger";
import { configStore } from "../config/config.svelte";
import { resourceMonitor } from "./resource-monitor.svelte";

export {
  ROOM_RECOVERY_POLICY,
  type CoordinatorProfilePublicationResult,
  type CoordinatorProfilePublicationState,
  type DebugLogEntry,
} from "@cahmls/sdk/runtime";

export type CoordinatorStoreRuntime = CoordinatorRuntimeDeps;

export const defaultCoordinatorStoreRuntime: CoordinatorStoreRuntime = {
  ...defaultCoordinatorRuntimeDeps,
  startResourceMonitor(transport) {
    resourceMonitor.start(transport);
  },
  stopResourceMonitor() {
    resourceMonitor.stop();
  },
};

/** Svelte 5 reactive binding over the SDK's framework-free coordinator lifecycle. */
export class CoordinatorStore {
  keyManager = $state.raw<KeyManager | null>(null);
  loadState = $state.raw<CoordinatorLoadState>("ready");
  status = $state.raw<CoordinatorStatus>("idle");
  error = $state.raw<string | null>(null);
  passphraseError = $state.raw<string | null>(null);
  persistenceError = $state.raw<string | null>(null);
  persistenceEnabled = $state.raw(false);
  relayStatuses = $state.raw<Readonly<Record<string, RelayConnectionStatus>>>({});
  debugLog = $state.raw<readonly DebugLogEntry[]>([]);
  profilePublicationState = $state.raw<CoordinatorProfilePublicationState>("idle");
  startupProgress = $state.raw<CoordinatorStartupProgress>(null as unknown as CoordinatorStartupProgress);
  appliedConfigRevision = $state.raw<number | null>(null);
  /** Tracks changes to runtime state that has no mirrored field. */
  private revision = $state.raw(0);
  private revisionCounter = 0;
  private readonly runtime: CoordinatorRuntime;

  constructor(runtime: CoordinatorStoreRuntime = defaultCoordinatorStoreRuntime) {
    this.runtime = new CoordinatorRuntime({
      config: configStore,
      deps: runtime,
      onDestroy: () => localStorage.removeItem(SIDEBAR_LEDGER_KEY),
    });
    this.mirror(this.runtime.getSnapshot());
    this.runtime.subscribe(() => this.mirror(this.runtime.getSnapshot()));
  }

  private mirror(state: CoordinatorRuntimeState): void {
    this.keyManager = state.keyManager;
    this.loadState = state.loadState;
    this.status = state.status;
    this.error = state.error;
    this.passphraseError = state.passphraseError;
    this.persistenceError = state.persistenceError;
    this.persistenceEnabled = state.persistenceEnabled;
    this.relayStatuses = state.relayStatuses;
    this.debugLog = state.debugLog;
    this.profilePublicationState = state.profilePublicationState;
    this.startupProgress = state.startupProgress;
    this.appliedConfigRevision = state.appliedConfigRevision;
    // Never read reactive state here: mirroring can run inside a caller's $effect.
    this.revision = ++this.revisionCounter;
  }

  get identity() {
    void this.keyManager;
    return this.runtime.identity;
  }

  get locked(): boolean {
    void this.status;
    return this.runtime.locked;
  }

  get restartRequired(): boolean {
    void this.status;
    void this.appliedConfigRevision;
    return this.runtime.restartRequired;
  }

  get exhaustedRoomRecoveryTarget() {
    void this.revision;
    return this.runtime.exhaustedRoomRecoveryTarget;
  }

  createHostedRoomClient(target: CoordinatorTarget): ChatCoordinatorOperations | null {
    return this.runtime.createHostedRoomClient(target);
  }

  loadFromPassphrase(passphrase: string) { return this.runtime.loadFromPassphrase(passphrase); }
  generateFreshKey() { this.runtime.generateFreshKey(); }
  enablePersistence(passphrase: string, confirmPassphrase: string) { return this.runtime.enablePersistence(passphrase, confirmPassphrase); }
  disablePersistence() { return this.runtime.disablePersistence(); }
  exportCoordinatorKeyBackup(passphrase: string) { return this.runtime.exportCoordinatorKeyBackup(passphrase); }
  clearPersistenceError() { this.runtime.clearPersistenceError(); }
  registerHostedRoomRecovery(adapter: HostedRoomRecoveryAdapter) { return this.runtime.registerHostedRoomRecovery(adapter); }
  completeSetupAndPublish(name: unknown): Promise<CoordinatorProfilePublicationResult> { return this.runtime.completeSetupAndPublish(name); }
  saveCoordinatorNameAndPublish(name: unknown): Promise<CoordinatorProfilePublicationResult> { return this.runtime.saveCoordinatorNameAndPublish(name); }
  retryCoordinatorProfilePublication(): Promise<CoordinatorProfilePublicationResult> { return this.runtime.retryCoordinatorProfilePublication(); }
  start() { return this.runtime.start(); }
  stop() { return this.runtime.stop(); }
  restart() { return this.runtime.restart(); }
  deleteHostedRoom(target: { id: string; coordinatorPubkey: string }) { return this.runtime.deleteHostedRoom(target); }
  stopSync() { return this.runtime.stopSync(); }
  retryRoomRecovery() { return this.runtime.retryRoomRecovery(); }
  resumeAfterRemovingFailedRoom(target: { roomId: string; coordinatorPubkey: string }) { return this.runtime.resumeAfterRemovingFailedRoom(target); }
  dismissError() { this.runtime.dismissError(); }
  destroy() { return this.runtime.destroy(); }
  clearDebugLog() { this.runtime.clearDebugLog(); }
}

export const coordinatorStore = new CoordinatorStore();
