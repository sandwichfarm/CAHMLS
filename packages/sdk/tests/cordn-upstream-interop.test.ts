/* @vitest-environment node */

import { afterEach, describe, expect, test } from "vitest";

import { ChatCoordinatorClient } from "../src/client/coordinator-client.js";
import {
  addMember,
  createKeyPackage,
  createRoomState,
  decryptMessage,
  encryptMessage,
  groupId,
  joinWelcome,
} from "../src/client/protocol.js";
import { BrowserNostrSigner } from "../src/crypto/browser-nostr-signer.js";
import { KeyManager } from "../src/crypto/key-manager.js";
import { transportFactory, type RunningTransport } from "../src/server/transport.js";
import { startMockRelay, type MockRelay } from "./support/mock-relay.js";

interface UpstreamCliSession {
  stablePubkey: string;
  disconnect(): Promise<void>;
  generateKeyPackage(
    alias: string,
    options?: { lastResort?: boolean },
  ): Promise<{ keyPackageRef: string }>;
  storeJoinRequest(
    groupId: string,
    keyPackageAlias: string,
  ): Promise<{ keyPackageRef: string; at: number }>;
  fetchWelcomes(): Promise<Array<{
    kp_ref: string;
    welcome_64: string;
    after?: number;
    at: number;
  }>>;
  acceptWelcome(keyPackageReference: string, groupAlias: string): Promise<unknown>;
  createGroup(
    alias: string,
    options: { keyPackageAlias: string },
  ): Promise<unknown>;
  addMember(
    groupAlias: string,
    identifier: string,
  ): Promise<{ keyPackageReference: string }>;
  sendMessage(groupAlias: string, content: string): Promise<unknown>;
  syncGroup(groupAlias: string): Promise<Array<{ content: string }>>;
}

type UpstreamCliSessionConstructor = new (options: {
  serverPubkey: string;
  relays: string[];
}) => UpstreamCliSession;

const upstreamCliSessionPath = process.env.CORDN_UPSTREAM_CLI_SESSION;
const upstreamInteropTest = upstreamCliSessionPath ? test : test.skip;

describe("pinned upstream Cordn CLI interoperability", () => {
  let relay: MockRelay | null = null;
  let running: RunningTransport | null = null;
  let host: ChatCoordinatorClient | null = null;
  let guest: UpstreamCliSession | null = null;

  afterEach(async () => {
    await host?.close();
    host = null;
    await guest?.disconnect();
    guest = null;
    running?.close();
    running = null;
    await relay?.close();
    relay = null;
  });

  upstreamInteropTest(
    "joins a CAHMLS coordinator room and exchanges encrypted messages",
    async () => {
      if (!upstreamCliSessionPath) {
        throw new Error("Missing pinned upstream CliSession module path");
      }
      const { CliSession } = await import(upstreamCliSessionPath) as {
        CliSession: UpstreamCliSessionConstructor;
      };

      relay = await startMockRelay(8768);
      const coordinatorKeys = KeyManager.generate();
      running = await transportFactory.create(
        coordinatorKeys.getSecretKeyBytes(),
        [relay.url],
        { announce: false, maxUsers: 64 },
        false,
      );

      const hostSigner = new BrowserNostrSigner(KeyManager.generate().getSecretKeyBytes());
      const hostPubkey = await hostSigner.getPublicKey();
      const hostKeyPackage = await createKeyPackage(hostPubkey);
      const hostState = await createRoomState(
        hostKeyPackage.keyPackage,
        hostKeyPackage.privateKeyPackage,
      );
      const roomId = groupId(hostState);
      host = new ChatCoordinatorClient({
        coordinatorPubkey: coordinatorKeys.identity.publicKeyHex,
        relayUrls: [relay.url],
      }, hostSigner);

      guest = new CliSession({
        serverPubkey: coordinatorKeys.identity.publicKeyHex,
        relays: [relay.url],
      });
      const guestKeyPackage = await guest.generateKeyPackage("guest", {
        lastResort: true,
      });
      await guest.storeJoinRequest(roomId, "guest");

      const [request] = await host.fetchJoinRequests(roomId);
      expect(request).toMatchObject({
        gid: roomId,
        pk: guest.stablePubkey,
        kp_ref: guestKeyPackage.keyPackageRef,
      });
      const consumed = await host.consumeKeyPackage(request.kp_ref);
      const publication = JSON.parse(
        (consumed?.event as { content: string }).content,
      ) as { params: { arguments: { kp_64: string } } };
      const admitted = await addMember(
        hostState,
        publication.params.arguments.kp_64,
      );
      const commit = await host.postGroupMessage(roomId, admitted.commitBase64);
      await host.storeWelcome(
        guest.stablePubkey,
        guestKeyPackage.keyPackageRef,
        admitted.welcomeBase64,
        commit.cursor,
      );

      await guest.fetchWelcomes();
      await guest.acceptWelcome(guestKeyPackage.keyPackageRef, "guest-room");

      await guest.sendMessage("guest-room", "hello from upstream Cordn");
      const [guestMessage] = await host.fetchMessages(roomId, commit.cursor);
      const receivedByHost = await decryptMessage(admitted.state, guestMessage.msg_64);
      expect(receivedByHost.envelope?.content).toBe("hello from upstream Cordn");

      const response = await encryptMessage(receivedByHost.state, {
        type: "message",
        id: crypto.randomUUID(),
        sender: hostPubkey,
        name: "CAHMLS host",
        content: "hello from CAHMLS",
        createdAt: Date.now(),
      });
      await host.postGroupMessage(roomId, response.opaqueBase64);
      const synced = await guest.syncGroup("guest-room");
      expect(synced.map((message) => message.content)).toContain("hello from CAHMLS");
    },
    30_000,
  );

  upstreamInteropTest(
    "accepts a direct CAHMLS invitation and exchanges encrypted messages",
    async () => {
      if (!upstreamCliSessionPath) {
        throw new Error("Missing pinned upstream CliSession module path");
      }
      const { CliSession } = await import(upstreamCliSessionPath) as {
        CliSession: UpstreamCliSessionConstructor;
      };

      relay = await startMockRelay(8768);
      const coordinatorKeys = KeyManager.generate();
      running = await transportFactory.create(
        coordinatorKeys.getSecretKeyBytes(),
        [relay.url],
        { announce: false, maxUsers: 64 },
        false,
      );

      const hostSigner = new BrowserNostrSigner(KeyManager.generate().getSecretKeyBytes());
      const hostPubkey = await hostSigner.getPublicKey();
      const hostKeyPackage = await createKeyPackage(hostPubkey);
      const hostState = await createRoomState(
        hostKeyPackage.keyPackage,
        hostKeyPackage.privateKeyPackage,
      );
      const roomId = groupId(hostState);
      host = new ChatCoordinatorClient({
        coordinatorPubkey: coordinatorKeys.identity.publicKeyHex,
        relayUrls: [relay.url],
      }, hostSigner);

      guest = new CliSession({
        serverPubkey: coordinatorKeys.identity.publicKeyHex,
        relays: [relay.url],
      });
      const guestKeyPackage = await guest.generateKeyPackage("guest", {
        lastResort: false,
      });

      const consumed = await host.consumeKeyPackage(guest.stablePubkey);
      expect(consumed?.kp_ref).toBe(guestKeyPackage.keyPackageRef);
      const publication = JSON.parse(
        (consumed?.event as { content: string }).content,
      ) as { params: { arguments: { kp_64: string } } };
      const admitted = await addMember(
        hostState,
        publication.params.arguments.kp_64,
      );
      const commit = await host.postGroupMessage(roomId, admitted.commitBase64);
      await host.storeWelcome(
        guest.stablePubkey,
        guestKeyPackage.keyPackageRef,
        admitted.welcomeBase64,
        commit.cursor,
      );

      const welcomes = await guest.fetchWelcomes();
      expect(welcomes.map((welcome) => welcome.kp_ref)).toContain(
        guestKeyPackage.keyPackageRef,
      );
      await guest.acceptWelcome(guestKeyPackage.keyPackageRef, "direct-invite");

      await guest.sendMessage("direct-invite", "direct invite accepted by Cordn");
      const [guestMessage] = await host.fetchMessages(roomId, commit.cursor);
      const receivedByHost = await decryptMessage(admitted.state, guestMessage.msg_64);
      expect(receivedByHost.envelope?.content).toBe("direct invite accepted by Cordn");

      const response = await encryptMessage(receivedByHost.state, {
        type: "message",
        id: crypto.randomUUID(),
        sender: hostPubkey,
        name: "CAHMLS host",
        content: "CAHMLS direct invitation works",
        createdAt: Date.now(),
      });
      await host.postGroupMessage(roomId, response.opaqueBase64);
      const synced = await guest.syncGroup("direct-invite");
      expect(synced.map((message) => message.content)).toContain(
        "CAHMLS direct invitation works",
      );
    },
    30_000,
  );

  upstreamInteropTest(
    "joins a direct upstream Cordn invitation and exchanges encrypted messages",
    async () => {
      if (!upstreamCliSessionPath) {
        throw new Error("Missing pinned upstream CliSession module path");
      }
      const { CliSession } = await import(upstreamCliSessionPath) as {
        CliSession: UpstreamCliSessionConstructor;
      };

      relay = await startMockRelay(8768);
      const coordinatorKeys = KeyManager.generate();
      running = await transportFactory.create(
        coordinatorKeys.getSecretKeyBytes(),
        [relay.url],
        { announce: false, maxUsers: 64 },
        false,
      );

      const cahmlsSigner = new BrowserNostrSigner(KeyManager.generate().getSecretKeyBytes());
      const cahmlsPubkey = await cahmlsSigner.getPublicKey();
      const cahmlsKeyPackage = await createKeyPackage(cahmlsPubkey);
      host = new ChatCoordinatorClient({
        coordinatorPubkey: coordinatorKeys.identity.publicKeyHex,
        relayUrls: [relay.url],
      }, cahmlsSigner);
      await host.publishKeyPackage(
        cahmlsKeyPackage.stored.reference,
        cahmlsKeyPackage.stored.publicBase64,
      );

      guest = new CliSession({
        serverPubkey: coordinatorKeys.identity.publicKeyHex,
        relays: [relay.url],
      });
      await guest.generateKeyPackage("cordn-host");
      await guest.createGroup("upstream-room", {
        keyPackageAlias: "cordn-host",
      });
      const invitation = await guest.addMember("upstream-room", cahmlsPubkey);
      expect(invitation.keyPackageReference).toBe(cahmlsKeyPackage.stored.reference);
      await guest.syncGroup("upstream-room");

      const welcomes = await host.fetchWelcomes();
      const welcome = welcomes.find(
        (candidate) => candidate.kp_ref === cahmlsKeyPackage.stored.reference,
      );
      expect(welcome).toBeDefined();
      const cahmlsState = await joinWelcome(
        welcome!.welcome_64,
        cahmlsKeyPackage.stored,
      );
      const roomId = groupId(cahmlsState);

      await guest.sendMessage("upstream-room", "hello from the Cordn inviter");
      const [cordnMessage] = await host.fetchMessages(roomId, welcome?.after);
      const receivedByCahmls = await decryptMessage(cahmlsState, cordnMessage.msg_64);
      expect(receivedByCahmls.envelope?.content).toBe("hello from the Cordn inviter");

      const response = await encryptMessage(receivedByCahmls.state, {
        type: "message",
        id: crypto.randomUUID(),
        sender: cahmlsPubkey,
        name: "CAHMLS invitee",
        content: "CAHMLS accepted the Cordn invitation",
        createdAt: Date.now(),
      });
      await host.postGroupMessage(roomId, response.opaqueBase64);
      const synced = await guest.syncGroup("upstream-room");
      expect(synced.map((message) => message.content)).toContain(
        "CAHMLS accepted the Cordn invitation",
      );
    },
    30_000,
  );
});
