import { describe, expect, it } from "vitest";

import {
  createBrowserCoordinatorStorage,
  normalizeCoordinatorStorageKey,
} from "../../src/cordn/coordinator/storage/indexedDbSnapshotStorage";

describe("IndexedDB coordinator snapshots", () => {
  it("normalizes an exact coordinator identity before opening browser storage", async () => {
    const coordinatorKey = ` ${"A".repeat(64)} `;

    expect(normalizeCoordinatorStorageKey(coordinatorKey)).toBe("a".repeat(64));
    await expect(
      createBrowserCoordinatorStorage(true, "not-a-coordinator-key"),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });
});
