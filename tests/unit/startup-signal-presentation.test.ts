import { describe, expect, test } from "vitest";

import { projectStartupSignal } from "../../src/components/startup-signal-presentation";
import type { CoordinatorStartupProgress, CoordinatorStatus } from "@cahmls/sdk/runtime";

function progress(overrides: Partial<CoordinatorStartupProgress> = {}): CoordinatorStartupProgress {
  return {
    phase: "connecting-relays",
    step: 3,
    totalSteps: 5,
    percent: 60,
    label: "Connecting relays",
    detail: "Connecting relay paths",
    roomRecovery: {
      state: "idle",
      completed: 0,
      total: 0,
      roomName: null,
      attempt: 0,
      diagnostic: "",
    },
    ...overrides,
  };
}

describe("projectStartupSignal", () => {
  test("passes transport startup truth through without mutating it", () => {
    const source = progress();
    const projection = projectStartupSignal(source, "starting");

    expect(projection).toMatchObject({
      phase: "connecting-relays",
      recoveryState: "idle",
      completed: 0,
      total: 0,
      roomName: null,
      forwardPercent: 60,
      mode: "active",
    });
    expect(source.percent).toBe(60);
  });

  test.each([
    [0, 0, 100],
    [1, 4, 88.75],
    [4, 4, 100],
  ])("maps room recovery %i of %i into the final startup interval", (completed, total, forwardPercent) => {
    const projection = projectStartupSignal(progress({
      phase: "restoring-rooms",
      roomRecovery: { state: "restoring", completed, total, roomName: "Room one", attempt: 1, diagnostic: "" },
    }), "starting");

    expect(projection.forwardPercent).toBe(forwardPercent);
    expect(projection).toMatchObject({ completed, total, roomName: "Room one", recoveryState: "restoring" });
  });

  test("clamps invalid visual inputs without changing coordinator-owned truth", () => {
    const source = progress({
      percent: 140,
      roomRecovery: { state: "restoring", completed: 8, total: 4, roomName: "Room one", attempt: 1, diagnostic: "" },
    });
    const projection = projectStartupSignal(source, "starting");

    expect(projection).toMatchObject({ completed: 4, total: 4, forwardPercent: 100 });
    expect(source).toMatchObject({ percent: 140, roomRecovery: { completed: 8, total: 4 } });
  });

  test.each(["retrying", "exhausted"] as const)("retains %s recovery truth without inferring another outcome", (recoveryState) => {
    const projection = projectStartupSignal(progress({
      phase: "restoring-rooms",
      roomRecovery: { state: recoveryState, completed: 1, total: 2, roomName: "Exact room", attempt: 3, diagnostic: "" },
    }), "starting");

    expect(projection).toMatchObject({ recoveryState, completed: 1, total: 2, roomName: "Exact room", forwardPercent: 92.5 });
  });

  test.each([
    ["starting", "active"],
    ["stopping", "resting"],
    ["running", "resting"],
    ["idle", "active"],
  ] satisfies Array<[CoordinatorStatus, "active" | "resting"]>)("uses a resting field for terminal coordinator states (%s)", (status, mode) => {
    expect(projectStartupSignal(progress(), status).mode).toBe(mode);
  });

  test("keeps transport and restored-room targets forward-only across an interrupted sequence", () => {
    const targets = [
      projectStartupSignal(progress({ percent: 20 }), "starting"),
      projectStartupSignal(progress({ percent: 60 }), "starting"),
      projectStartupSignal(progress({
        phase: "restoring-rooms",
        roomRecovery: { state: "restoring", completed: 1, total: 4, roomName: "Exact room", attempt: 1, diagnostic: "" },
      }), "starting"),
      projectStartupSignal(progress({
        phase: "restoring-rooms",
        roomRecovery: { state: "retrying", completed: 1, total: 4, roomName: "Exact room", attempt: 2, diagnostic: "" },
      }), "starting"),
      projectStartupSignal(progress({
        phase: "restoring-rooms",
        roomRecovery: { state: "exhausted", completed: 1, total: 4, roomName: "Exact room", attempt: 3, diagnostic: "" },
      }), "starting"),
    ];

    expect(targets.map((target) => target.forwardPercent)).toEqual([20, 60, 88.75, 88.75, 88.75]);
    expect(targets.slice(1).every((target, index) => target.forwardPercent >= targets[index]!.forwardPercent)).toBe(true);
    expect(targets.at(-2)).toMatchObject({ recoveryState: "retrying", completed: 1, total: 4 });
    expect(targets.at(-1)).toMatchObject({ recoveryState: "exhausted", completed: 1, total: 4 });
  });
});
