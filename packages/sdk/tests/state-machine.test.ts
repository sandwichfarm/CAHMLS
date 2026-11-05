import { describe, expect, test } from "vitest";

import { isConfigLocked, transitionCoordinator } from "../src/runtime/state-machine.js";
import type { CoordinatorEvent, CoordinatorStatus } from "../src/runtime/types.js";

const statuses: CoordinatorStatus[] = ["idle", "starting", "running", "stopping"];
const events: CoordinatorEvent[] = ["start", "started", "stop", "stopped", "error"];
const allowed: Record<string, CoordinatorStatus> = {
  "idle+start": "starting",
  "starting+started": "running",
  "starting+stop": "stopping",
  "starting+error": "idle",
  "running+stop": "stopping",
  "stopping+stopped": "idle",
  "stopping+error": "idle",
};

describe("transitionCoordinator", () => {
  const matrix = statuses.flatMap((status) => events.map((event) => [status, event] as const));

  test.each(matrix)("%s + %s follows the transition table", (status, event) => {
    const expected = allowed[`${status}+${event}`];
    if (expected) {
      expect(transitionCoordinator(status, event)).toBe(expected);
    } else {
      expect(() => transitionCoordinator(status, event)).toThrow(
        `Invalid coordinator transition: ${status} -> ${event}`,
      );
    }
  });
});

describe("isConfigLocked", () => {
  test.each([
    ["idle", false],
    ["starting", true],
    ["running", true],
    ["stopping", true],
  ] satisfies Array<[CoordinatorStatus, boolean]>)("%s -> %s", (status, locked) => {
    expect(isConfigLocked(status)).toBe(locked);
  });
});
