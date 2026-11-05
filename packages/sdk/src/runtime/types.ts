export type CoordinatorStatus = "idle" | "starting" | "running" | "stopping";

export type CoordinatorStartupPhase =
  | "idle"
  | "checking-instance"
  | "opening-storage"
  | "preparing-runtime"
  | "connecting-relays"
  | "restoring-rooms"
  | "online"
  | "failed";

export interface CoordinatorStartupProgress {
  phase: CoordinatorStartupPhase;
  step: number;
  totalSteps: number;
  percent: number;
  label: string;
  detail: string;
  roomRecovery: HostedRoomRecoveryProgress;
}

/** A strict persisted-room identity used by the startup recovery transaction. */
export interface HostedRoomRecoveryTarget {
  readonly coordinatorPubkey: string;
  readonly roomId: string;
  readonly roomName: string;
  /** Stable composite identity, supplied by the adapter rather than inferred from display copy. */
  readonly roomIdentityKey: string;
}

export type HostedRoomRecoveryState = "idle" | "restoring" | "retrying" | "exhausted" | "complete";

export interface HostedRoomRecoveryProgress {
  state: HostedRoomRecoveryState;
  completed: number;
  total: number;
  roomName: string | null;
  attempt: number;
  diagnostic: string;
}

export interface HostedRoomRecoveryAdapter {
  listTargets(): readonly HostedRoomRecoveryTarget[] | Promise<readonly HostedRoomRecoveryTarget[]>;
  recover(target: HostedRoomRecoveryTarget, signal: AbortSignal): Promise<void>;
  discard?(target: HostedRoomRecoveryTarget): void | Promise<void>;
}

export function createHostedRoomRecoveryProgress(input: Partial<HostedRoomRecoveryProgress> & Pick<HostedRoomRecoveryProgress, "state" | "completed" | "total">): HostedRoomRecoveryProgress {
  const roomName = input.roomName ?? null;
  const diagnostic = input.diagnostic
    ?? (input.state === "complete" && input.total === 0
      ? "No rooms to restore"
      : input.state === "retrying"
        ? "Trying again…"
        : input.state === "exhausted" && roomName
          ? "Check your connection, then retry recovery."
          : "");
  return {
    state: input.state,
    completed: input.completed,
    total: input.total,
    roomName,
    attempt: input.attempt ?? 0,
    diagnostic,
  };
}

export type CoordinatorEvent = "start" | "started" | "stop" | "stopped" | "error";

export type CoordinatorLoadState = "prompting" | "ready";

export type RelayConnectionStatus = "idle" | "connecting" | "connected" | "error";

export interface StatusSnapshot {
  status: CoordinatorStatus;
  error: string | null;
}
