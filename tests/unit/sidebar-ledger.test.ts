import { describe, expect, test } from "vitest";
import { roomIdentityKey, type StoredRoom } from "../../src/chat/room-store";
import { archiveSidebarRoom, emptySidebarLedger, parseSidebarLedger, reconcileSidebarLedger, serializeSidebarLedger, toggleSidebarFavorite } from "../../src/chat/sidebar-ledger";

function room(id: string, coordinatorPubkey: string, createdAt: number, overrides: Partial<StoredRoom> = {}): StoredRoom {
  return {
    version: 1, id, title: id, coordinatorPubkey, relayUrls: [], name: "anon", stablePubkey: "f".repeat(64),
    isHost: false, stateBase64: "", keyPackage: { reference: "", publicBase64: "", privateBase64: "" }, lastCursor: 0,
    messages: [], pending: [], createdAt, ...overrides,
  };
}

describe("sidebar ledger", () => {
  test("preserves first-seen coordinator and room order across activity-sorted inputs", () => {
    const local = "a".repeat(64);
    const remote = "b".repeat(64);
    const first = reconcileSidebarLedger(emptySidebarLedger(), [room("later", remote, 2), room("first", remote, 1), room("local", local, 3)], local, "Mine", 10);
    const again = reconcileSidebarLedger(first.ledger, [room("first", remote, 1, { updatedAt: 99 }), room("local", local, 3), room("later", remote, 2, { updatedAt: 100 })], local, "Mine", 20);
    expect(again.activeRooms.map(({ id }) => id)).toEqual(["local", "first", "later"]);
    expect(again.ledger.coordinatorOrder).toEqual([remote]);
  });

  test("moves rotated and retired rooms into secret-free history", () => {
    const current = "a".repeat(64);
    const rotated = room("old-host", "b".repeat(64), 1, { isHost: true, stateBase64: "SECRET", messages: [{ type: "message", id: "m", sender: "s", name: "n", content: "DECRYPTED", createdAt: 1 }] });
    const retired = room("retired", current, 2, { membershipStatus: "retired", anonymousSecretKey: "c".repeat(64) });
    const result = reconcileSidebarLedger(emptySidebarLedger(), [rotated, retired], current, "Mine", 50);
    expect(result.activeRooms).toEqual([]);
    expect(result.history.map(({ reason }) => reason)).toEqual(["identity-retired", "coordinator-rotated"]);
    const serialized = serializeSidebarLedger(result.ledger);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("DECRYPTED");
    expect(serialized).not.toContain("cccccccc");
  });

  test("archives explicit removal once and recovers malformed storage", () => {
    const target = room("gone", "a".repeat(64), 1);
    const ledger = archiveSidebarRoom(emptySidebarLedger(), target, "deleted", "Mine", 7);
    archiveSidebarRoom(ledger, target, "deleted", "Mine", 8);
    expect(ledger.history).toEqual([expect.objectContaining({ title: "gone", reason: "deleted", archivedAt: 7 })]);
    expect(parseSidebarLedger("not json")).toEqual(emptySidebarLedger());
  });

  test("preserves first archive order when dead rooms are reconciled again", () => {
    const current = "a".repeat(64);
    const rotated = room("rotated", "b".repeat(64), 1, { isHost: true });
    const retired = room("retired", current, 2, { membershipStatus: "retired" });
    const first = reconcileSidebarLedger(emptySidebarLedger(), [rotated, retired], current, "Mine", 100);
    const second = reconcileSidebarLedger(first.ledger, [rotated, retired], current, "Mine", 900);

    expect(second.history.map(({ archivedAt }) => archivedAt)).toEqual([100, 100]);
    expect(second.history.map(({ roomId }) => roomId)).toEqual(first.history.map(({ roomId }) => roomId));
  });

  test("normalizes valid composite favorites independently and retires stale keys", () => {
    const firstCoordinator = "a".repeat(64);
    const secondCoordinator = "b".repeat(64);
    const first = room("same-id", firstCoordinator, 1);
    const second = room("same-id", secondCoordinator, 2);
    const firstKey = roomIdentityKey(firstCoordinator, first.id);
    const secondKey = roomIdentityKey(secondCoordinator, second.id);
    const parsed = parseSidebarLedger(JSON.stringify({
      version: 1,
      coordinatorOrder: [secondCoordinator],
      roomOrder: { [secondCoordinator]: [secondKey] },
      history: [],
      favorites: [firstKey, firstKey, `not-a-pubkey\u0000same-id`, `${firstCoordinator}\u0000`, 42],
    }));

    expect(parsed.coordinatorOrder).toEqual([secondCoordinator]);
    expect(parsed.favorites).toEqual([firstKey]);

    const toggled = toggleSidebarFavorite(parsed, second);
    expect(toggled.favorites).toEqual([firstKey, secondKey]);
    const reconciled = reconcileSidebarLedger(toggled, [first, second], firstCoordinator, "Mine");
    expect(reconciled.ledger.favorites).toEqual([firstKey, secondKey]);

    const afterRemoval = reconcileSidebarLedger(reconciled.ledger, [second], firstCoordinator, "Mine");
    expect(afterRemoval.ledger.favorites).toEqual([secondKey]);
    expect(afterRemoval.activeRooms.map((storedRoom) => roomIdentityKey(storedRoom.coordinatorPubkey, storedRoom.id))).toEqual([secondKey]);
  });
});
