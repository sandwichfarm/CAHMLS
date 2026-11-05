import { describe, expect, test } from "vitest";

import { createHostedRoomRecoveryProgress } from "../src/runtime/types.js";

describe("createHostedRoomRecoveryProgress", () => {
  test("fills optional fields with neutral defaults", () => {
    expect(createHostedRoomRecoveryProgress({ state: "idle", completed: 0, total: 0 })).toEqual({
      state: "idle",
      completed: 0,
      total: 0,
      roomName: null,
      attempt: 0,
      diagnostic: "",
    });
  });

  test("announces an empty recovery only when there was nothing to restore", () => {
    expect(createHostedRoomRecoveryProgress({ state: "complete", completed: 0, total: 0 }).diagnostic)
      .toBe("No rooms to restore");
    expect(createHostedRoomRecoveryProgress({ state: "complete", completed: 2, total: 2 }).diagnostic)
      .toBe("");
  });

  test("keeps the room and attempt during a retry", () => {
    expect(createHostedRoomRecoveryProgress({
      state: "retrying",
      completed: 1,
      total: 2,
      roomName: "Planning",
      attempt: 2,
    })).toEqual({
      state: "retrying",
      completed: 1,
      total: 2,
      roomName: "Planning",
      attempt: 2,
      diagnostic: "Trying again…",
    });
  });

  test("advises a retry when a named room exhausted its attempts", () => {
    expect(createHostedRoomRecoveryProgress({ state: "exhausted", completed: 0, total: 1, roomName: "Planning" }).diagnostic)
      .toBe("Check your connection, then retry recovery.");
    expect(createHostedRoomRecoveryProgress({ state: "exhausted", completed: 0, total: 1 }).diagnostic)
      .toBe("");
  });

  test("an explicit diagnostic always wins, including an empty one", () => {
    expect(createHostedRoomRecoveryProgress({ state: "retrying", completed: 0, total: 1, diagnostic: "custom" }).diagnostic)
      .toBe("custom");
    expect(createHostedRoomRecoveryProgress({ state: "complete", completed: 0, total: 0, diagnostic: "" }).diagnostic)
      .toBe("");
  });
});
