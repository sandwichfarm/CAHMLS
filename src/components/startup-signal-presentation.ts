import type { CoordinatorStartupProgress, CoordinatorStatus } from "@cahmls/sdk/runtime";

export interface StartupSignalPresentation {
  readonly phase: CoordinatorStartupProgress["phase"];
  readonly recoveryState: CoordinatorStartupProgress["roomRecovery"]["state"];
  readonly completed: number;
  readonly total: number;
  readonly roomName: string | null;
  readonly forwardPercent: number;
  readonly mode: "active" | "resting";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : minimum;
}

/** Maps coordinator-owned recovery truth to decorative, forward-only field inputs. */
export function projectStartupSignal(
  progress: CoordinatorStartupProgress,
  status: CoordinatorStatus,
): StartupSignalPresentation {
  const total = clamp(progress.roomRecovery.total, 0, Number.MAX_SAFE_INTEGER);
  const completed = clamp(progress.roomRecovery.completed, 0, total);
  const roomRatio = total === 0 ? 1 : completed / total;
  const forwardPercent = progress.phase === "restoring-rooms"
    ? 85 + roomRatio * 15
    : clamp(progress.percent, 0, 100);

  return {
    phase: progress.phase,
    recoveryState: progress.roomRecovery.state,
    completed,
    total,
    roomName: progress.roomRecovery.roomName,
    forwardPercent,
    // Stopping and the brief running-room handoff settle without extending
    // coordinator lifecycle ownership into the decorative field.
    mode: status === "stopping" || status === "running" ? "resting" : "active",
  };
}
