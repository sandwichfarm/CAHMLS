import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { base64ToBytes, bytesToBase64 } from "ts-mls";

import { LocalHostCoordinatorClient } from "../src/client/local-coordinator-client.js";
import { addMember, createKeyPackage, createRoomState } from "../src/client/protocol.js";
import { Coordinator } from "../src/coordinator/coordinator.js";
import { encodeWelcome } from "../src/mls/mlsCodec.js";

const HOST = "aa".repeat(32);
const GUEST = "bb".repeat(32);
const GROUP = "group-1";
const payload = (...bytes: number[]) => bytesToBase64(Uint8Array.from(bytes));

describe("LocalHostCoordinatorClient", () => {
  let coordinator: Coordinator;
  let client: LocalHostCoordinatorClient;

  beforeEach(() => {
    coordinator = new Coordinator({ welcomeCleanupIntervalMs: 0 });
    client = new LocalHostCoordinatorClient(coordinator);
  });

  afterEach(() => {
    coordinator.close();
  });

  async function publishGuestPackage() {
    const guest = await createKeyPackage(GUEST);
    coordinator.publishKeyPackage({
      stablePubkey: GUEST,
      keyPackage: guest.keyPackage,
      keyPackageRef: guest.stored.reference,
      publicationEvent: { id: "publication" } as never,
    });
    return guest;
  }

  test("close is a harmless no-op that leaves the shared coordinator running", async () => {
    await expect(client.close()).resolves.toBeUndefined();
    await client.postGroupMessage(GROUP, payload(1));
    await expect(client.fetchMessages(GROUP)).resolves.toHaveLength(1);
  });

  describe("group messages", () => {
    test("posts and returns the coordinator's cursor, group and time", async () => {
      const posted = await client.postGroupMessage(GROUP, payload(1, 2, 3));

      expect(posted).toEqual({ cursor: expect.any(Number), gid: GROUP, at: expect.any(Number) });
    });

    test("delivers the exact bytes in Cordn's message shape", async () => {
      const posted = await client.postGroupMessage(GROUP, payload(1, 2, 3));

      await expect(client.fetchMessages(GROUP)).resolves.toEqual([
        { cursor: posted.cursor, gid: GROUP, msg_64: payload(1, 2, 3), at: posted.at },
      ]);
    });

    test("fetches only messages after a cursor", async () => {
      const first = await client.postGroupMessage(GROUP, payload(1));
      const second = await client.postGroupMessage(GROUP, payload(2));

      const messages = await client.fetchMessages(GROUP, first.cursor);

      expect(messages.map((message) => message.cursor)).toEqual([second.cursor]);
    });

    test("keeps groups apart", async () => {
      await client.postGroupMessage(GROUP, payload(1));
      await expect(client.fetchMessages("other-group")).resolves.toEqual([]);
    });

    test("stores under one ephemeral sender that is not a real identity", async () => {
      const spy = vi.spyOn(coordinator, "postGroupMessage");
      await client.postGroupMessage(GROUP, payload(1));
      await client.postGroupMessage(GROUP, payload(2));
      const other = new LocalHostCoordinatorClient(coordinator);
      await other.postGroupMessage(GROUP, payload(3));

      const senders = spy.mock.calls.map(([input]) => input.ephemeralSenderPubkey);
      expect(senders[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(senders[1]).toBe(senders[0]);
      expect(senders[2]).not.toBe(senders[0]);
    });

    test.each([
      ["empty", ""],
      ["not base64", "%%%"],
      ["non-canonical base64", "AQ"],
    ])("refuses a %s payload before it reaches the coordinator", async (_label, value) => {
      const spy = vi.spyOn(coordinator, "postGroupMessage");
      await expect(client.postGroupMessage(GROUP, value)).rejects.toThrow("Invalid base64 payload");
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("join requests", () => {
    test("maps pending requests to the wire shape", async () => {
      const guest = await publishGuestPackage();
      const record = coordinator.storeJoinRequest({
        groupId: GROUP,
        requesterStablePubkey: GUEST,
        keyPackageRef: guest.stored.reference,
        inviteToken: "token",
      });

      await expect(client.fetchJoinRequests(GROUP)).resolves.toEqual([{
        gid: GROUP,
        pk: GUEST,
        kp_ref: guest.stored.reference,
        at: record.createdAt,
        invite_token: "token",
      }]);
    });

    test("does not return another group's requests", async () => {
      const guest = await publishGuestPackage();
      coordinator.storeJoinRequest({ groupId: "other", requesterStablePubkey: GUEST, keyPackageRef: guest.stored.reference });

      await expect(client.fetchJoinRequests(GROUP)).resolves.toEqual([]);
    });

    test("acknowledged requests are consumed", async () => {
      const guest = await publishGuestPackage();
      const record = coordinator.storeJoinRequest({
        groupId: GROUP,
        requesterStablePubkey: GUEST,
        keyPackageRef: guest.stored.reference,
      });
      await expect(client.fetchJoinRequests(GROUP, [])).resolves.toHaveLength(1);

      const spy = vi.spyOn(coordinator, "fetchManyPendingJoinRequests");
      await expect(client.fetchJoinRequests(GROUP, [{ pk: GUEST, at: record.createdAt }])).resolves.toEqual([]);
      expect(spy).toHaveBeenCalledWith({
        groups: [{ groupId: GROUP }],
        consumed: [{ groupId: GROUP, requesterStablePubkey: GUEST, createdAt: record.createdAt }],
      });
    });

    test("an empty acknowledgement list is omitted", async () => {
      const spy = vi.spyOn(coordinator, "fetchManyPendingJoinRequests");
      await client.fetchJoinRequests(GROUP, []);
      expect(spy).toHaveBeenCalledWith({ groups: [{ groupId: GROUP }] });
    });

    test("subscribers hear new requests until they unsubscribe", async () => {
      const guest = await publishGuestPackage();
      const listener = vi.fn();
      const unsubscribe = client.subscribeJoinRequests(GROUP, listener);

      const first = coordinator.storeJoinRequest({ groupId: GROUP, requesterStablePubkey: GUEST, keyPackageRef: guest.stored.reference });
      await coordinator.waitForJoinRequestNotifications(first);
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      const second = coordinator.storeJoinRequest({ groupId: GROUP, requesterStablePubkey: "cc".repeat(32), keyPackageRef: guest.stored.reference });
      await coordinator.waitForJoinRequestNotifications(second);
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe("key packages", () => {
    test("consuming returns the package's identity, reference and publication event", async () => {
      const guest = await publishGuestPackage();

      await expect(client.consumeKeyPackage(guest.stored.reference)).resolves.toEqual({
        pk: GUEST,
        kp_ref: guest.stored.reference,
        event: { id: "publication" },
      });
    });

    test("consuming an ordinary package removes it", async () => {
      const guest = await publishGuestPackage();
      await client.consumeKeyPackage(guest.stored.reference);

      await expect(client.consumeKeyPackage(guest.stored.reference)).resolves.toBeNull();
    });

    test("an unknown package resolves to null", async () => {
      await expect(client.consumeKeyPackage("missing")).resolves.toBeNull();
    });
  });

  describe("welcomes", () => {
    async function realWelcome() {
      const host = await createKeyPackage(HOST);
      const guest = await createKeyPackage(GUEST);
      const state = await createRoomState(host.keyPackage, host.privateKeyPackage);
      return { guest, ...(await addMember(state, guest.stored.publicBase64)) };
    }

    test("stores a valid welcome for its target with the join cursor", async () => {
      const { guest, welcomeBase64 } = await realWelcome();

      await client.storeWelcome(GUEST, guest.stored.reference, welcomeBase64, 7);

      const [stored] = coordinator.fetchPendingWelcomes(GUEST);
      expect(stored).toMatchObject({
        targetStablePubkey: GUEST,
        keyPackageReference: guest.stored.reference,
        joinAfterCursor: 7,
      });
      expect(encodeWelcome(stored!.welcome)).toEqual(base64ToBytes(welcomeBase64));
    });

    test.each([
      ["invalid base64", "%%%", "Invalid base64 payload"],
      ["bytes that are not an MLS message", payload(1, 2, 3), "Invalid welcome_64"],
    ])("refuses %s", async (_label, value, message) => {
      await expect(client.storeWelcome(GUEST, "ref", value, 0)).rejects.toThrow(message);
      expect(coordinator.fetchPendingWelcomes(GUEST)).toEqual([]);
    });

    test("refuses a well-formed MLS message that is not a welcome", async () => {
      const guest = await createKeyPackage(GUEST);
      const { encode, mlsMessageEncoder, protocolVersions, wireformats } = await import("ts-mls");
      const notWelcome = bytesToBase64(encode(mlsMessageEncoder, {
        version: protocolVersions.mls10,
        wireformat: wireformats.mls_key_package,
        keyPackage: guest.keyPackage,
      }));

      await expect(client.storeWelcome(GUEST, "ref", notWelcome, 0)).rejects.toThrow("Invalid welcome_64");
      expect(coordinator.fetchPendingWelcomes(GUEST)).toEqual([]);
    });
  });

  describe("guest-only operations", () => {
    test("a host session refuses them rather than silently doing nothing", async () => {
      await expect(client.publishKeyPackage()).rejects.toThrow("cannot publish a guest key package");
      await expect(client.listOwnKeyPackageRefs()).rejects.toThrow("cannot list guest key packages");
      await expect(client.storeJoinRequest()).rejects.toThrow("cannot request guest admission");
      await expect(client.fetchWelcomes()).rejects.toThrow("cannot consume guest Welcomes");
    });
  });
});
