import { beforeEach, describe, expect, test, vi } from "vitest";
import type { NostrSigner } from "@contextvm/sdk/core";

import {
  createKeyPackage,
  createRoomState,
  encodeState,
} from "../../src/chat/protocol";
import type { ChatCoordinatorOperations } from "../../src/chat/coordinator-client";
import { LocalHostCoordinatorClient } from "../../src/chat/local-coordinator-client";
import { ChatRoomSession, type StoredRoom } from "../../src/chat/room-store";
import { Coordinator } from "../../src/cordn/coordinator/coordinator";

const GUEST_PUBKEY = "d".repeat(64);
const COORDINATOR_PUBKEY = "c".repeat(64);

/**
 * A guest client that reaches the same in-process coordinator the host uses,
 * so admission is exercised through the real storage rather than through a
 * hand-written stub of its behaviour.
 */
function guestClient(coordinator: Coordinator, stablePubkey: string): ChatCoordinatorOperations {
  const local = new LocalHostCoordinatorClient(coordinator);
  return {
    close: () => Promise.resolve(),
    consumeKeyPackage: (identifier) => local.consumeKeyPackage(identifier),
    postGroupMessage: (groupId, message) => local.postGroupMessage(groupId, message),
    storeWelcome: (target, ref, welcome, after) => local.storeWelcome(target, ref, welcome, after),
    fetchMessages: (groupId, after) => local.fetchMessages(groupId, after),
    fetchJoinRequests: (groupId, consumed) => local.fetchJoinRequests(groupId, consumed),
    async listOwnKeyPackageRefs() {
      return coordinator
        .listKeyPackagesForIdentity(stablePubkey)
        .map((record) => record.keyPackageRef);
    },
    async publishKeyPackage(reference, keyPackageBase64) {
      coordinator.publishKeyPackage({
        stablePubkey,
        keyPackageRef: reference,
        keyPackage: publishedKeyPackages.get(reference)!,
        publicationEvent: {
          content: JSON.stringify({ params: { arguments: { kp_64: keyPackageBase64 } } }),
        } as never,
      });
    },
    async storeJoinRequest(groupId, keyPackageReference, inviteToken) {
      coordinator.storeJoinRequest({
        groupId,
        requesterStablePubkey: stablePubkey,
        keyPackageRef: keyPackageReference,
        ...(inviteToken ? { inviteToken } : {}),
      });
    },
    async fetchWelcomes() {
      return [];
    },
  };
}

const publishedKeyPackages = new Map<string, Awaited<ReturnType<typeof createKeyPackage>>["keyPackage"]>();

async function waitingGuestRoom(): Promise<{ room: StoredRoom; reference: string }> {
  const keys = await createKeyPackage(GUEST_PUBKEY, { lastResort: true });
  publishedKeyPackages.set(keys.stored.reference, keys.keyPackage);
  const state = await createRoomState(keys.keyPackage, keys.privateKeyPackage);
  return {
    reference: keys.stored.reference,
    room: {
      version: 1,
      id: "room-id",
      title: "Room",
      coordinatorPubkey: COORDINATOR_PUBKEY,
      relayUrls: ["wss://relay.example"],
      name: "Guest",
      stablePubkey: GUEST_PUBKEY,
      isHost: false,
      stateBase64: encodeState(state),
      keyPackage: keys.stored,
      lastCursor: 0,
      messages: [],
      pending: [],
      joinRequestSent: true,
      inviteToken: "invite-token",
    } as StoredRoom,
  };
}

describe("invite admission recovery", () => {
  beforeEach(() => {
    localStorage.clear();
    publishedKeyPackages.clear();
  });

  test("a waiting guest republishes a key package the coordinator has lost", async () => {
    const coordinator = new Coordinator({ welcomeCleanupIntervalMs: 0 });
    const { room, reference } = await waitingGuestRoom();
    const client = guestClient(coordinator, GUEST_PUBKEY);
    const session = new ChatRoomSession(room, {} as NostrSigner, () => client);
    session.status = { connection: "connected" };

    expect(coordinator.getKeyPackage(reference)).toBeNull();

    await session.sync();

    // The invite is admissible again: both the material and the request that
    // names it are present.
    expect(coordinator.getKeyPackage(reference)).not.toBeNull();
    expect(coordinator
      .fetchManyPendingJoinRequests({ groups: [{ groupId: room.id }] })
      .map((request) => request.keyPackageRef)).toContain(reference);
  });

  test("recovery is idempotent while the coordinator still holds the package", async () => {
    const coordinator = new Coordinator({ welcomeCleanupIntervalMs: 0 });
    const { room } = await waitingGuestRoom();
    const client = guestClient(coordinator, GUEST_PUBKEY);
    const publish = vi.spyOn(client, "publishKeyPackage");
    const session = new ChatRoomSession(room, {} as NostrSigner, () => client);
    session.status = { connection: "connected" };

    await session.sync();
    expect(publish).toHaveBeenCalledTimes(1);

    await session.sync();
    await session.sync();
    // A present package must not be republished, because each publication
    // evicts the previous last-resort record.
    expect(publish).toHaveBeenCalledTimes(1);
  });

  test("a failing recovery probe does not break an otherwise healthy wait", async () => {
    const coordinator = new Coordinator({ welcomeCleanupIntervalMs: 0 });
    const { room } = await waitingGuestRoom();
    const client = guestClient(coordinator, GUEST_PUBKEY);
    client.listOwnKeyPackageRefs = () => Promise.reject(new Error("kp_list unsupported"));
    const session = new ChatRoomSession(room, {} as NostrSigner, () => client);
    session.status = { connection: "connected" };

    await session.sync();

    expect(session.status.connection).toBe("connected");
  });

  test("an unadmittable request reports why instead of failing silently", async () => {
    const coordinator = new Coordinator({ welcomeCleanupIntervalMs: 0 });
    const hostKeys = await createKeyPackage("a".repeat(64));
    const hostState = await createRoomState(hostKeys.keyPackage, hostKeys.privateKeyPackage);
    const hostRoom = {
      version: 1,
      id: "host-room",
      title: "Host room",
      coordinatorPubkey: COORDINATOR_PUBKEY,
      relayUrls: ["wss://relay.example"],
      name: "Host",
      stablePubkey: "a".repeat(64),
      isHost: true,
      autoApprove: false,
      stateBase64: encodeState(hostState),
      keyPackage: hostKeys.stored,
      lastCursor: 0,
      messages: [],
      pending: [],
      joinRequestSent: false,
    } as StoredRoom;

    const session = new ChatRoomSession(
      hostRoom,
      {} as NostrSigner,
      () => new LocalHostCoordinatorClient(coordinator),
    );
    session.status = { connection: "connected" };
    // A join request whose key package the coordinator never received.
    coordinator.storeJoinRequest({
      groupId: hostRoom.id,
      requesterStablePubkey: GUEST_PUBKEY,
      keyPackageRef: "missing-reference",
    });

    await session.approveJoinRequests();

    expect(session.admissionError).toMatch(/no longer on the coordinator/i);
    expect(session.pendingJoinRequests).toHaveLength(1);
  });
});
