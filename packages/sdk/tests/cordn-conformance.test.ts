import { describe, expect, test, vi } from "vitest";
import type { NostrSigner } from "@contextvm/sdk/core";

import { ChatCoordinatorClient, type RemoteJoinRequest } from "../src/client/coordinator-client.js";
import { LocalHostCoordinatorClient } from "../src/client/local-coordinator-client.js";
import {
  addMember,
  createKeyPackage,
  createRoomState,
  decodeState,
  encodeState,
  groupId,
  joinWelcome,
  sealGroupPayloadBase64,
  unsealGroupPayloadBase64,
} from "../src/client/protocol.js";
import { ChatRoomSession, isCurrentInviteRequest, type StoredRoom } from "../src/client/room-store.js";
import {
  APP_DATA_DICTIONARY_EXTENSION_TYPE,
  LAST_RESORT_KEY_PACKAGE_COMPONENT_ID,
} from "../src/client/cordn-wire.js";
import {
  COORDINATOR_METHODS,
  fetchManyPendingJoinRequestsInputSchema,
  fetchPendingWelcomesInputSchema,
  postGroupMessageInputSchema,
  storeJoinRequestInputSchema,
} from "../src/contracts/index.js";
import { InMemoryCoordinatorStorage } from "../src/coordinator/storage/inMemoryStorage.js";
import { Coordinator } from "../src/coordinator/coordinator.js";
import { encodeWelcome } from "../src/mls/mlsCodec.js";
import { encodeBase64 } from "../src/server/base64.js";
import { CoordinatorAdapter } from "../src/server/coordinatorMethods.js";

const CANONICAL_CORDN_METHODS = {
  publishKeyPackage: "kp_publish",
  listAvailableKeyPackages: "kp_list",
  consumeKeyPackage: "kp_take",
  removeKeyPackages: "kp_remove",
  fetchPendingWelcomes: "welcome_take",
  storeWelcome: "welcome_store",
  storeJoinRequest: "join_request_store",
  fetchManyPendingJoinRequests: "join_request_take_many",
  postGroupMessage: "msg_post",
  fetchManyGroupMessages: "msg_fetch_many",
  subscribeManyGroupMessages: "msg_sub_many",
} as const;

describe("canonical Cordn client conformance", () => {
  test("opens and recovers an empty same-tab host room without a relay round-trip", async () => {
    const hostKeys = await createKeyPackage("12".repeat(32));
    const hostState = await createRoomState(hostKeys.keyPackage, hostKeys.privateKeyPackage);
    const room: StoredRoom = {
      version: 1,
      id: groupId(hostState),
      title: "Fresh room",
      coordinatorPubkey: "13".repeat(32),
      relayUrls: ["wss://relay.example"],
      name: "Host",
      stablePubkey: "12".repeat(32),
      isHost: true,
      stateBase64: encodeState(hostState),
      keyPackage: hostKeys.stored,
      lastCursor: 0,
      messages: [],
      pending: [],
      autoApprove: true,
    };
    const coordinator = new Coordinator({ welcomeCleanupIntervalMs: 0 });
    const createClient = () => new LocalHostCoordinatorClient(coordinator);
    const liveSession = new ChatRoomSession(room, {} as NostrSigner, createClient);

    await liveSession.start();
    expect(liveSession.status.connection).toBe("connected");
    liveSession.stop();

    const recoveredRoom = { ...room, messages: [], pending: [] };
    const recoverySession = new ChatRoomSession(recoveredRoom, {} as NostrSigner, createClient);
    await recoverySession.recover(new AbortController().signal);
    expect(recoverySession.status.connection).toBe("connected");
    recoverySession.stop();
    coordinator.close();
  });

  test("immediately admits a canonical Cordn requester that arrives after hosted-room recovery", async () => {
    const hostPubkey = "12".repeat(32);
    const guestPubkey = "22".repeat(32);
    const hostKeys = await createKeyPackage(hostPubkey);
    const guestKeys = await createKeyPackage(guestPubkey, { lastResort: true });
    const hostState = await createRoomState(hostKeys.keyPackage, hostKeys.privateKeyPackage);
    const room: StoredRoom = {
      version: 1,
      id: groupId(hostState),
      title: "Recovered room",
      coordinatorPubkey: "13".repeat(32),
      relayUrls: ["wss://relay.example"],
      name: "Host",
      stablePubkey: hostPubkey,
      isHost: true,
      stateBase64: encodeState(hostState),
      keyPackage: hostKeys.stored,
      lastCursor: 0,
      messages: [],
      pending: [],
      autoApprove: true,
    };
    const coordinator = new Coordinator({ welcomeCleanupIntervalMs: 0 });
    const session = new ChatRoomSession(
      room,
      {} as NostrSigner,
      () => new LocalHostCoordinatorClient(coordinator),
    );

    try {
      await session.recover(new AbortController().signal);
      session.activateSteadyState();

      coordinator.publishKeyPackage({
        stablePubkey: guestPubkey,
        keyPackage: guestKeys.keyPackage,
        keyPackageRef: guestKeys.stored.reference,
        publicationEvent: {
          content: JSON.stringify({
            params: { arguments: { kp_64: guestKeys.stored.publicBase64 } },
          }),
        } as never,
      });
      coordinator.storeJoinRequest({
        groupId: room.id,
        requesterStablePubkey: guestPubkey,
        keyPackageRef: guestKeys.stored.reference,
      });

      let welcome = coordinator.fetchPendingWelcomes(guestPubkey)[0];
      await vi.waitFor(() => {
        welcome = coordinator.fetchPendingWelcomes(guestPubkey)[0];
        expect(welcome).toBeDefined();
      }, { timeout: 500 });
      expect(welcome).toBeDefined();
      expect(groupId(await joinWelcome(
        encodeBase64(encodeWelcome(welcome.welcome)),
        guestKeys.stored,
      ))).toBe(room.id);
    } finally {
      session.stop();
      coordinator.close();
    }
  });

  test("makes a Welcome available to one immediate canonical welcome_take after join_request_store", async () => {
    const hostPubkey = "14".repeat(32);
    const guestPubkey = "24".repeat(32);
    const hostKeys = await createKeyPackage(hostPubkey);
    const guestKeys = await createKeyPackage(guestPubkey, { lastResort: true });
    const hostState = await createRoomState(hostKeys.keyPackage, hostKeys.privateKeyPackage);
    const room: StoredRoom = {
      version: 1,
      id: groupId(hostState),
      title: "Immediate wire room",
      coordinatorPubkey: "34".repeat(32),
      relayUrls: ["wss://relay.example"],
      name: "Host",
      stablePubkey: hostPubkey,
      isHost: true,
      stateBase64: encodeState(hostState),
      keyPackage: hostKeys.stored,
      lastCursor: 0,
      messages: [],
      pending: [],
      autoApprove: true,
    };
    const coordinator = new Coordinator({ welcomeCleanupIntervalMs: 0 });
    const adapter = new CoordinatorAdapter(coordinator);
    const host = new ChatRoomSession(
      room,
      {} as NostrSigner,
      () => new LocalHostCoordinatorClient(coordinator),
    );
    const requesterExtra = { _meta: { clientPubkey: guestPubkey } };

    try {
      await host.start();
      coordinator.publishKeyPackage({
        stablePubkey: guestPubkey,
        keyPackage: guestKeys.keyPackage,
        keyPackageRef: guestKeys.stored.reference,
        publicationEvent: {
          content: JSON.stringify({
            params: { arguments: { kp_64: guestKeys.stored.publicBase64 } },
          }),
        } as never,
      });

      const stored = await adapter.storeJoinRequest({
        gid: room.id,
        kp_ref: guestKeys.stored.reference,
      }, requesterExtra);
      expect(stored.structuredContent).toEqual({ at: expect.any(Number) });

      const immediateWelcome = adapter.fetchPendingWelcomes({}, requesterExtra);
      expect(immediateWelcome.structuredContent.welcomes).toHaveLength(1);
      expect(immediateWelcome.structuredContent.welcomes[0]?.kp_ref)
        .toBe(guestKeys.stored.reference);
    } finally {
      host.stop();
      coordinator.close();
    }
  });

  test("acknowledges an unsubscribed canonical join request without manufacturing a Welcome", async () => {
    const guestPubkey = "25".repeat(32);
    const guestKeys = await createKeyPackage(guestPubkey, { lastResort: true });
    const coordinator = new Coordinator({ welcomeCleanupIntervalMs: 0 });
    const adapter = new CoordinatorAdapter(coordinator);
    const requesterExtra = { _meta: { clientPubkey: guestPubkey } };

    vi.useFakeTimers();
    try {
      coordinator.publishKeyPackage({
        stablePubkey: guestPubkey,
        keyPackage: guestKeys.keyPackage,
        keyPackageRef: guestKeys.stored.reference,
        publicationEvent: {
          content: JSON.stringify({
            params: { arguments: { kp_64: guestKeys.stored.publicBase64 } },
          }),
        } as never,
      });

      const stored = await adapter.storeJoinRequest({
        gid: "unsubscribed-wire-room",
        kp_ref: guestKeys.stored.reference,
      }, requesterExtra);
      expect(stored.structuredContent).toEqual({ at: expect.any(Number) });

      const immediateWelcome = adapter.fetchPendingWelcomes({}, requesterExtra);
      expect(immediateWelcome.structuredContent).toEqual({ welcomes: [] });
    } finally {
      vi.useRealTimers();
      coordinator.close();
    }
  });

  test("exposes every canonical coordinator method with its canonical wire name", () => {
    for (const [key, value] of Object.entries(CANONICAL_CORDN_METHODS)) {
      expect(COORDINATOR_METHODS[key as keyof typeof COORDINATOR_METHODS]).toBe(value);
    }
  });

  test("accepts canonical client request shapes", () => {
    expect(storeJoinRequestInputSchema.parse({ gid: "room", kp_ref: "kp" })).toEqual({
      gid: "room",
      kp_ref: "kp",
    });
    expect(fetchPendingWelcomesInputSchema.parse({
      consumed: [{ kp_ref: "kp", at: 42 }],
    })).toEqual({ consumed: [{ kp_ref: "kp", at: 42 }] });
    expect(fetchManyPendingJoinRequestsInputSchema.parse({
      groups: [{ gid: "room" }],
      consumed: [{ gid: "room", pk: "requester", at: 42 }],
    })).toEqual({
      groups: [{ gid: "room" }],
      consumed: [{ gid: "room", pk: "requester", at: 42 }],
    });
    expect(postGroupMessageInputSchema.parse({ gid: "room", msg_64: "AQ==" })).toEqual({
      gid: "room",
      msg_64: "AQ==",
    });
  });

  test("routes spec/03 payloads opaquely by the outer gid", () => {
    const coordinator = new Coordinator({ welcomeCleanupIntervalMs: 0 });
    const sealedPayload = Uint8Array.from([
      0x7f, 0x43, 0x4f, 0x52, 0x44, 0x4e, 0xff, 0x00, 0x19,
    ]);

    const posted = coordinator.postGroupMessage({
      groupId: "canonical-group",
      ephemeralSenderPubkey: "ephemeral-client",
      opaqueMessage: sealedPayload,
    });

    expect(posted.groupId).toBe("canonical-group");
    expect(posted.opaqueMessage).toEqual(sealedPayload);
    expect(coordinator.fetchGroupMessages({ groupId: "canonical-group" }))
      .toEqual([posted]);
  });

  test("uses canonical KeyPackage references and Cordn extension capabilities", async () => {
    const keyPackage = await createKeyPackage("ab".repeat(32), { lastResort: true });

    expect(keyPackage.stored.reference).toMatch(/^[0-9a-f]{64}$/);
    expect(keyPackage.keyPackage.leafNode.capabilities.extensions)
      .toEqual(expect.arrayContaining([0xc04d, 0x0006]));
    const lastResort = keyPackage.keyPackage.extensions.find(
      (extension) => extension.extensionType === APP_DATA_DICTIONARY_EXTENSION_TYPE,
    );
    expect(lastResort?.extensionData).toEqual(Uint8Array.from([
      0x03,
      0x00,
      LAST_RESORT_KEY_PACKAGE_COMPONENT_ID,
      0x00,
    ]));
    expect(keyPackage.stored.lastResort).toBe(true);
  });

  test("consumes ordinary packages before preserving the newest last-resort fallback", async () => {
    const storage = new InMemoryCoordinatorStorage();
    const stablePubkey = "ab".repeat(32);
    const ordinary = await createKeyPackage(stablePubkey);
    const oldLastResort = await createKeyPackage(stablePubkey, { lastResort: true });
    const currentLastResort = await createKeyPackage(stablePubkey, { lastResort: true });
    const event = {} as never;

    storage.publishKeyPackage({
      stablePubkey,
      keyPackage: ordinary.keyPackage,
      keyPackageRef: ordinary.stored.reference,
      isLastResort: false,
      publishedAt: 1,
      publicationEvent: event,
    });
    storage.publishKeyPackage({
      stablePubkey,
      keyPackage: oldLastResort.keyPackage,
      keyPackageRef: oldLastResort.stored.reference,
      isLastResort: true,
      publishedAt: 2,
      publicationEvent: event,
    });
    storage.publishKeyPackage({
      stablePubkey,
      keyPackage: currentLastResort.keyPackage,
      keyPackageRef: currentLastResort.stored.reference,
      isLastResort: true,
      publishedAt: 3,
      publicationEvent: event,
    });

    expect(storage.consumeKeyPackage(stablePubkey)?.keyPackageRef)
      .toBe(ordinary.stored.reference);
    expect(storage.consumeKeyPackage(stablePubkey)?.keyPackageRef)
      .toBe(currentLastResort.stored.reference);
    expect(storage.consumeKeyPackage(stablePubkey)?.keyPackageRef)
      .toBe(currentLastResort.stored.reference);
    expect(storage.getKeyPackage(currentLastResort.stored.reference)).not.toBeNull();
    expect(storage.getKeyPackage(ordinary.stored.reference)).toBeNull();
  });

  test("selects the matching room Welcome when one last-resort package is reused", async () => {
    const guestKeys = await createKeyPackage("21".repeat(32), { lastResort: true });
    const firstHost = await createKeyPackage("31".repeat(32));
    const secondHost = await createKeyPackage("41".repeat(32));
    const firstState = await createRoomState(firstHost.keyPackage, firstHost.privateKeyPackage);
    const secondState = await createRoomState(secondHost.keyPackage, secondHost.privateKeyPackage);
    const firstAdded = await addMember(firstState, guestKeys.stored.publicBase64);
    const secondAdded = await addMember(secondState, guestKeys.stored.publicBase64);
    const room: StoredRoom = {
      version: 1,
      id: groupId(secondState),
      title: "Second room",
      coordinatorPubkey: "51".repeat(32),
      relayUrls: [],
      name: "Guest",
      stablePubkey: "21".repeat(32),
      isHost: false,
      stateBase64: "",
      keyPackage: guestKeys.stored,
      lastCursor: 0,
      messages: [],
      pending: [],
      joinRequestSent: true,
    };
    const consumed: Array<{ kp_ref: string; at: number }> = [];
    const client = {
      async fetchWelcomes(entries?: Array<{ kp_ref: string; at: number }>) {
        if (entries) {
          consumed.push(...entries);
          return [];
        }
        return [
          { kp_ref: guestKeys.stored.reference, welcome_64: firstAdded.welcomeBase64, at: 10 },
          { kp_ref: guestKeys.stored.reference, welcome_64: secondAdded.welcomeBase64, at: 11 },
        ];
      },
    } as unknown as ChatCoordinatorClient;
    const session = new ChatRoomSession(room, {} as NostrSigner);
    const admission = session as unknown as {
      acceptWelcome(coordinator: ChatCoordinatorClient): Promise<void>;
    };

    await admission.acceptWelcome(client);

    expect(groupId(decodeState(room.stateBase64))).toBe(room.id);
    expect(consumed).toEqual([{ kp_ref: guestKeys.stored.reference, at: 11 }]);
    expect(room.joinRequestSent).toBe(false);
  });

  test("repairs a pending legacy room with a reusable Cordn join package", async () => {
    const room: StoredRoom = {
      version: 1,
      id: "legacy-room",
      title: "Legacy room",
      coordinatorPubkey: "61".repeat(32),
      relayUrls: ["wss://relay.example"],
      name: "Guest",
      stablePubkey: "71".repeat(32),
      isHost: false,
      stateBase64: "",
      keyPackage: (await createKeyPackage("71".repeat(32))).stored,
      lastCursor: 0,
      messages: [],
      pending: [],
      inviteToken: "current-invite",
      joinRequestSent: true,
    };
    const publishKeyPackage = vi.fn().mockResolvedValue(undefined);
    const storeJoinRequest = vi.fn().mockResolvedValue(undefined);
    const client = { publishKeyPackage, storeJoinRequest } as unknown as ChatCoordinatorClient;
    const session = new ChatRoomSession(room, {} as NostrSigner);
    const migration = session as unknown as {
      upgradeLegacyJoinRequest(coordinator: ChatCoordinatorClient): Promise<void>;
    };

    await migration.upgradeLegacyJoinRequest(client);

    expect(room.keyPackage.lastResort).toBe(true);
    expect(publishKeyPackage).toHaveBeenCalledWith(
      room.keyPackage.reference,
      room.keyPackage.publicBase64,
    );
    expect(storeJoinRequest).toHaveBeenCalledWith(
      room.id,
      room.keyPackage.reference,
      room.inviteToken,
    );
  });

  test("seals and unseals the group payload around MLS bytes", async () => {
    const keyPackage = await createKeyPackage("cd".repeat(32));
    const state = await createRoomState(
      keyPackage.keyPackage,
      keyPackage.privateKeyPackage,
      { name: "Canonical room", adminPubkeys: ["cd".repeat(32)] },
    );
    const raw = "AQIDBAUGBwg=";

    const sealed = await sealGroupPayloadBase64(state, raw);
    expect(sealed).not.toBe(raw);
    expect(await unsealGroupPayloadBase64(decodeState(encodeState(state)), sealed))
      .toBe(raw);
  });

  test("admits a canonical tokenless request while rejecting an explicitly stale CAHMLS token", () => {
    expect(isCurrentInviteRequest("current-token", {})).toBe(true);
    expect(isCurrentInviteRequest("current-token", { invite_token: "current-token" })).toBe(true);
    expect(isCurrentInviteRequest("current-token", { invite_token: "stale-token" })).toBe(false);
  });

  test("retires join requests using the canonical consumed acknowledgement", () => {
    const storage = new InMemoryCoordinatorStorage();
    storage.storeJoinRequest({
      groupId: "room",
      requesterStablePubkey: "requester",
      keyPackageRef: "kp",
      createdAt: 42,
      readAt: null,
    });

    expect(storage.fetchManyPendingJoinRequests({ groups: [{ groupId: "room" }] }, 50)).toHaveLength(1);
    expect(storage.fetchManyPendingJoinRequests({
      groups: [{ groupId: "room" }],
      consumed: [{
        groupId: "room",
        requesterStablePubkey: "requester",
        createdAt: 42,
      }],
    }, 51)).toEqual([]);
  });

  test("refreshes a Cordn join re-request in place with its current key package", () => {
    const storage = new InMemoryCoordinatorStorage();
    storage.storeJoinRequest({
      groupId: "room",
      requesterStablePubkey: "requester",
      keyPackageRef: "stale-kp",
      inviteToken: "stale-invite",
      createdAt: 42,
      readAt: null,
    });

    const refreshed = storage.storeJoinRequest({
      groupId: "room",
      requesterStablePubkey: "requester",
      keyPackageRef: "current-kp",
      inviteToken: "current-invite",
      createdAt: 84,
      readAt: null,
    });

    expect(refreshed).toMatchObject({
      keyPackageRef: "current-kp",
      inviteToken: "current-invite",
      createdAt: 84,
      readAt: null,
    });
    expect(storage.fetchManyPendingJoinRequests({ groups: [{ groupId: "room" }] }, 85))
      .toHaveLength(1);
    expect(storage.fetchManyPendingJoinRequests({
      groups: [{ groupId: "room" }],
      consumed: [{
        groupId: "room",
        requesterStablePubkey: "requester",
        createdAt: 42,
      }],
    }, 85)).toEqual([expect.objectContaining({
      keyPackageRef: "current-kp",
      createdAt: 84,
    })]);
  });

  test("does not retire a join request merely because its key package was consumed", async () => {
    const storage = new InMemoryCoordinatorStorage();
    const stablePubkey = "de".repeat(32);
    const keyPackage = await createKeyPackage(stablePubkey);
    storage.publishKeyPackage({
      stablePubkey,
      keyPackage: keyPackage.keyPackage,
      keyPackageRef: keyPackage.stored.reference,
      isLastResort: false,
      publishedAt: 1,
      publicationEvent: {} as never,
    });
    storage.storeJoinRequest({
      groupId: "room",
      requesterStablePubkey: stablePubkey,
      keyPackageRef: keyPackage.stored.reference,
      createdAt: 42,
      readAt: null,
    });

    expect(storage.consumeKeyPackage(keyPackage.stored.reference)).not.toBeNull();
    expect(storage.fetchManyPendingJoinRequests({ groups: [{ groupId: "room" }] }, 43))
      .toHaveLength(1);
  });

  test("retains CAHMLS invite tokens as an optional extension", () => {
    expect(storeJoinRequestInputSchema.parse({
      gid: "room",
      kp_ref: "kp",
      invite_token: "rotating-token",
    })).toEqual({
      gid: "room",
      kp_ref: "kp",
      invite_token: "rotating-token",
    });
  });

  test("collapses replayed join requests before keyed pending-invite rendering", () => {
    const room = {
      version: 1,
      id: "room",
      title: "Replay room",
      coordinatorPubkey: "3".repeat(64),
      relayUrls: [],
      name: "Host",
      stablePubkey: "1".repeat(64),
      isHost: true,
      stateBase64: "",
      keyPackage: { reference: "host", publicBase64: "", privateBase64: "" },
      lastCursor: 0,
      messages: [],
      pending: [],
    } satisfies StoredRoom;
    const session = new ChatRoomSession(room, {} as NostrSigner);
    const replayed = [
      { gid: room.id, pk: "2".repeat(64), kp_ref: "7".repeat(64), at: 10 },
      { gid: room.id, pk: "2".repeat(64), kp_ref: "7".repeat(64), at: 11 },
    ];

    const current = (session as unknown as {
      currentInviteRequests(requests: RemoteJoinRequest[]): RemoteJoinRequest[];
    }).currentInviteRequests(replayed);

    expect(current).toEqual([replayed[1]]);
  });

  test("falls back to the requester's current last-resort key package after its reference rotates", async () => {
    const hostKeys = await createKeyPackage("11".repeat(32));
    const guestKeys = await createKeyPackage("22".repeat(32), { lastResort: true });
    const otherGuestKeys = await createKeyPackage("22".repeat(32), { lastResort: true });
    const hostState = await createRoomState(hostKeys.keyPackage, hostKeys.privateKeyPackage);
    const room: StoredRoom = {
      version: 1,
      id: groupId(hostState),
      title: "Canonical room",
      coordinatorPubkey: "33".repeat(32),
      relayUrls: [],
      name: "Host",
      stablePubkey: "11".repeat(32),
      isHost: true,
      stateBase64: encodeState(hostState),
      keyPackage: hostKeys.stored,
      lastCursor: 0,
      messages: [],
      pending: [],
      autoApprove: true,
    };
    const request: RemoteJoinRequest = {
      gid: room.id,
      pk: "22".repeat(32),
      kp_ref: otherGuestKeys.stored.reference,
      at: 42,
    };
    const calls = {
      consumedIdentifiers: [] as string[],
      storedTarget: "",
      storedReference: "",
      welcome: "",
    };
    const client = {
      async consumeKeyPackage(identifier: string) {
        calls.consumedIdentifiers.push(identifier);
        if (identifier === request.kp_ref) return null;
        return {
          pk: request.pk,
          kp_ref: guestKeys.stored.reference,
          event: {
            content: JSON.stringify({
              params: { arguments: { keyPackageBase64: guestKeys.stored.publicBase64 } },
            }),
          },
        };
      },
      async postGroupMessage() {
        return { cursor: 7, gid: room.id, at: 43 };
      },
      async fetchMessages() {
        return [];
      },
      async storeWelcome(target: string, reference: string, welcome: string) {
        calls.storedTarget = target;
        calls.storedReference = reference;
        calls.welcome = welcome;
      },
      async fetchJoinRequests() {
        return [];
      },
    } as unknown as ChatCoordinatorClient;
    const session = new ChatRoomSession(room, {} as NostrSigner);
    const admission = session as unknown as {
      acceptJoinRequests(
        coordinator: ChatCoordinatorClient,
        requests: RemoteJoinRequest[],
      ): Promise<{ accepted: RemoteJoinRequest[]; retryable: RemoteJoinRequest[] }>;
    };

    const result = await admission.acceptJoinRequests(client, [request]);

    expect(calls.consumedIdentifiers).toEqual([request.kp_ref, request.pk]);
    expect(calls.storedTarget).toBe(request.pk);
    expect(calls.storedReference).toBe(guestKeys.stored.reference);
    expect(result).toEqual({ accepted: [request], retryable: [] });
    expect(groupId(await joinWelcome(calls.welcome, guestKeys.stored))).toBe(room.id);
    expect(room.pendingWelcomes).toEqual([]);
  });

  test("admits the exact key package named by a join request before identity fallback", async () => {
    const hostKeys = await createKeyPackage("71".repeat(32));
    const requestedKeys = await createKeyPackage("72".repeat(32), { lastResort: true });
    const otherDeviceKeys = await createKeyPackage("72".repeat(32));
    const hostState = await createRoomState(hostKeys.keyPackage, hostKeys.privateKeyPackage);
    const room: StoredRoom = {
      version: 1,
      id: groupId(hostState),
      title: "Cross-client room",
      coordinatorPubkey: "73".repeat(32),
      relayUrls: [],
      name: "Host",
      stablePubkey: "71".repeat(32),
      isHost: true,
      stateBase64: encodeState(hostState),
      keyPackage: hostKeys.stored,
      lastCursor: 0,
      messages: [],
      pending: [],
      autoApprove: true,
    };
    const request: RemoteJoinRequest = {
      gid: room.id,
      pk: "72".repeat(32),
      kp_ref: requestedKeys.stored.reference,
      at: 96,
    };
    const consumedIdentifiers: string[] = [];
    let deliveredReference = "";
    let deliveredWelcome = "";
    const client = {
      async consumeKeyPackage(identifier: string) {
        consumedIdentifiers.push(identifier);
        const keys = identifier === request.kp_ref ? requestedKeys : otherDeviceKeys;
        return {
          pk: request.pk,
          kp_ref: keys.stored.reference,
          event: {
            content: JSON.stringify({
              params: { arguments: { kp_64: keys.stored.publicBase64 } },
            }),
          },
        };
      },
      async postGroupMessage() {
        return { cursor: 11, gid: room.id, at: 97 };
      },
      async fetchMessages() {
        return [];
      },
      async storeWelcome(_target: string, reference: string, welcome: string) {
        deliveredReference = reference;
        deliveredWelcome = welcome;
      },
      async fetchJoinRequests() {
        return [];
      },
    } as unknown as ChatCoordinatorClient;
    const session = new ChatRoomSession(room, {} as NostrSigner);
    const admission = session as unknown as {
      acceptJoinRequests(
        coordinator: ChatCoordinatorClient,
        requests: RemoteJoinRequest[],
      ): Promise<{ accepted: RemoteJoinRequest[]; retryable: RemoteJoinRequest[] }>;
    };

    const result = await admission.acceptJoinRequests(client, [request]);

    expect(consumedIdentifiers).toEqual([request.kp_ref]);
    expect(deliveredReference).toBe(request.kp_ref);
    expect(result).toEqual({ accepted: [request], retryable: [] });
    expect(groupId(await joinWelcome(deliveredWelcome, requestedKeys.stored))).toBe(room.id);
  });

  test("delivers the Welcome even when persisting the delivery outbox is temporarily unavailable", async () => {
    const hostKeys = await createKeyPackage("44".repeat(32));
    const guestKeys = await createKeyPackage("55".repeat(32));
    const hostState = await createRoomState(hostKeys.keyPackage, hostKeys.privateKeyPackage);
    const room: StoredRoom = {
      version: 1,
      id: groupId(hostState),
      title: "Canonical room",
      coordinatorPubkey: "66".repeat(32),
      relayUrls: [],
      name: "Host",
      stablePubkey: "44".repeat(32),
      isHost: true,
      stateBase64: encodeState(hostState),
      keyPackage: hostKeys.stored,
      lastCursor: 0,
      messages: [],
      pending: [],
      autoApprove: true,
    };
    const request: RemoteJoinRequest = {
      gid: room.id,
      pk: "55".repeat(32),
      kp_ref: guestKeys.stored.reference,
      at: 84,
    };
    let deliveredWelcome = "";
    const client = {
      async consumeKeyPackage() {
        return {
          pk: request.pk,
          kp_ref: request.kp_ref,
          event: {
            content: JSON.stringify({
              params: { arguments: { kp_64: guestKeys.stored.publicBase64 } },
            }),
          },
        };
      },
      async postGroupMessage() {
        return { cursor: 9, gid: room.id, at: 85 };
      },
      async fetchMessages() {
        return [];
      },
      async storeWelcome(_target: string, _reference: string, welcome: string) {
        deliveredWelcome = welcome;
      },
      async fetchJoinRequests() {
        return [];
      },
    } as unknown as ChatCoordinatorClient;
    const session = new ChatRoomSession(room, {} as NostrSigner);
    const admission = session as unknown as {
      acceptJoinRequests(
        coordinator: ChatCoordinatorClient,
        requests: RemoteJoinRequest[],
      ): Promise<{ accepted: RemoteJoinRequest[]; retryable: RemoteJoinRequest[] }>;
    };
    const storageWrite = vi.spyOn(window.localStorage, "setItem")
      .mockImplementationOnce(() => {
        throw new DOMException("Storage temporarily unavailable", "QuotaExceededError");
      });

    try {
      const result = await admission.acceptJoinRequests(client, [request]);

      expect(result).toEqual({ accepted: [request], retryable: [] });
      expect(groupId(await joinWelcome(deliveredWelcome, guestKeys.stored))).toBe(room.id);
    } finally {
      storageWrite.mockRestore();
    }
  });
});
