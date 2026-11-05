import { beforeEach, describe, expect, test } from "vitest";

import {
  clearPersistedCoordinatorState,
  createBrowserCoordinatorStorage,
} from "../../src/cordn/coordinator/storage/indexedDbSnapshotStorage";
import { CoordinatorStore } from "../../src/coordinator/coordinator.svelte";

describe("browser coordinator deleted-room persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("keeps temporary tombstones only for the active in-memory owner", async () => {
    const firstStorage = await createBrowserCoordinatorStorage(false, "coordinator-a");
    firstStorage.deleteGroup("deleted-room");
    firstStorage.close();

    const restartedStorage = await createBrowserCoordinatorStorage(false, "coordinator-a");
    const otherCoordinatorStorage = await createBrowserCoordinatorStorage(
      false,
      "coordinator-b",
    );

    expect(restartedStorage.isGroupDeleted("deleted-room")).toBe(false);
    expect(otherCoordinatorStorage.isGroupDeleted("deleted-room")).toBe(false);

    restartedStorage.close();
    otherCoordinatorStorage.close();
  });

  test("requires an exact coordinator identity for durable browser storage", async () => {
    await expect(createBrowserCoordinatorStorage(true, "coordinator-a")).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  test("clears coordinator-scoped tombstone registries with persisted state", async () => {
    const storage = await createBrowserCoordinatorStorage(false, "coordinator-a");
    storage.deleteGroup("deleted-room");
    storage.close();

    await clearPersistedCoordinatorState();

    const restartedStorage = await createBrowserCoordinatorStorage(false, "coordinator-a");
    expect(restartedStorage.isGroupDeleted("deleted-room")).toBe(false);
    restartedStorage.close();
  });

  test("does not pretend an ephemeral stopped coordinator deletion is durable", async () => {
    const coordinator = new CoordinatorStore();
    const coordinatorPubkey = coordinator.identity.publicKeyHex;

    await coordinator.deleteHostedRoom({
      id: "hosted-room",
      coordinatorPubkey,
    });

    expect(coordinator.debugLog.at(-1)).toMatchObject({
      level: "info",
      message: "hosted room deleted",
      details: "hosted-room",
    });
    const storage = await createBrowserCoordinatorStorage(false, coordinatorPubkey);
    expect(storage.isGroupDeleted("hosted-room")).toBe(false);
    storage.close();
  });

  test("refuses to delete a same-id room owned by another coordinator", async () => {
    const coordinator = new CoordinatorStore();
    const coordinatorPubkey = coordinator.identity.publicKeyHex;

    await expect(coordinator.deleteHostedRoom({
      id: "shared-room",
      coordinatorPubkey: "f".repeat(64),
    })).rejects.toThrow("Cannot delete a room hosted by another coordinator");

    const storage = await createBrowserCoordinatorStorage(false, coordinatorPubkey);
    expect(storage.isGroupDeleted("shared-room")).toBe(false);
    storage.close();
  });
});
