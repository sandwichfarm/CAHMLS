import type { CoordinatorEvent, CoordinatorStatus } from "./types.js";

const transitions: Record<CoordinatorStatus, Partial<Record<CoordinatorEvent, CoordinatorStatus>>> = {
  idle: { start: "starting" },
  starting: { started: "running", stop: "stopping", error: "idle" },
  running: { stop: "stopping" },
  stopping: { stopped: "idle", error: "idle" },
};

export function transitionCoordinator(
  status: CoordinatorStatus,
  event: CoordinatorEvent,
): CoordinatorStatus {
  const next = transitions[status][event];
  if (!next) {
    throw new Error(`Invalid coordinator transition: ${status} -> ${event}`);
  }

  return next;
}

export function isConfigLocked(status: CoordinatorStatus): boolean {
  return status !== "idle";
}
