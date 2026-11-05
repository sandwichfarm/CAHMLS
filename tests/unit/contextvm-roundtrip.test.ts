/* @vitest-environment node */

import { Client } from "@contextvm/mcp-sdk/client";
import { NostrClientTransport } from "@contextvm/sdk/transport";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ConfigStore } from "../../src/config/config.svelte";
import { ChatCoordinatorClient } from "@cahmls/sdk/client";
import {
  addMember,
  createKeyPackage,
  createRoomState,
  decryptMessage,
  encryptMessage,
  groupId,
  joinWelcome,
} from "@cahmls/sdk/client";
import { BrowserNostrSigner } from "@cahmls/sdk/crypto";
import { KeyManager } from "@cahmls/sdk/crypto";
import {
  transportFactory,
  type RunningTransport,
  type TransportStartupPhase,
} from "@cahmls/sdk/server";
import { startMockRelay, type MockRelay } from "../../packages/sdk/tests/support/mock-relay";

describe("ContextVM client round trip", () => {
  let relay: MockRelay;
  let running: RunningTransport | null = null;

  beforeEach(async () => {
    relay = await startMockRelay(8766);
  });

  afterEach(async () => {
    running?.close();
    running = null;
    await relay.close();
  });

  test("reports the configured coordinator name during initialize and keeps the running constructor static", async () => {
    const keyManager = KeyManager.generate();
    const config = new ConfigStore();
    expect(config.completeSetup("  Núcleo 🌊  ")).toBe(true);
    config.setAnnouncement(true);
    const runtimeRevisionBeforeRename = config.runtimeRevision;
    const initialOptions = config.coordinatorOptions;
    const diagnostics: string[] = [];
    const startupPhases: TransportStartupPhase[] = [];
    running = await transportFactory.create(
      keyManager.getSecretKeyBytes(),
      [relay.url],
      { ...initialOptions, maxUsers: 64 },
      false,
      {
        onStartupPhase: ({ phase }) => startupPhases.push(phase),
        onNostrEvent: ({ summary }) => diagnostics.push(`raw:${summary}`),
        onInboundMessage: ({ method, summary }) => diagnostics.push(`inbound:${method}:${summary}`),
        onNostrPublish: ({ phase, summary }) => diagnostics.push(`publish:${phase}:${summary}`),
        onOutboundMessage: ({ type, summary }) => diagnostics.push(`outbound:${type}:${summary}`),
      },
    );
    expect(startupPhases).toEqual([
      "opening-storage",
      "preparing-runtime",
      "connecting-relays",
    ]);
    await expect.poll(() => relay.events()
      .find((event) => event.kind === 11316)
      ?.tags?.find((tag) => tag[0] === "name")?.[1]).toBe("Núcleo 🌊");

    const clientTransport = new NostrClientTransport({
      signer: new BrowserNostrSigner(KeyManager.generate().getSecretKeyBytes()),
      serverPubkey: keyManager.identity.publicKeyHex,
      relayHandler: [relay.url],
      logLevel: "error",
    });
    const client = new Client({ name: "cordn-browser-test", version: "0.1.0" });

    await client.connect(clientTransport, { timeout: 10_000 });
    expect(client.getServerVersion()?.name).toBe("Núcleo 🌊");
    expect(config.setCoordinatorName("Next coordinator")).toBe(true);
    expect(config.runtimeRevision).toBe(runtimeRevisionBeforeRename + 1);
    expect(client.getServerVersion()?.name).toBe("Núcleo 🌊");
    expect(config.coordinatorOptions.coordinatorName).toBe("Next coordinator");
    const tools = await client.listTools(undefined, { timeout: 10_000 });
    const toolsWithProgress = await client.listTools(undefined, {
      timeout: 10_000,
      onprogress: () => undefined,
    });

    expect(tools.tools.map(({ name }) => name)).toContain("kp_publish");
    expect(toolsWithProgress.tools.map(({ name }) => name)).toContain("kp_publish");
    const joinRequests = await client.callTool({
      name: "join_request_take_many",
      arguments: { groups: [{ gid: "canonical-room" }], consumed: [] },
    }, undefined, { timeout: 10_000 });
    const welcomes = await client.callTool({
      name: "welcome_take",
      arguments: { consumed: [] },
    }, undefined, { timeout: 10_000 });
    const messages = await client.callTool({
      name: "msg_fetch_many",
      arguments: { groups: [{ gid: "canonical-room" }] },
    }, undefined, { timeout: 10_000 });

    expect(joinRequests.isError).not.toBe(true);
    expect(joinRequests.structuredContent).toEqual({ requests: [] });
    expect(welcomes.isError).not.toBe(true);
    expect(welcomes.structuredContent).toEqual({ welcomes: [] });
    expect(messages.isError).not.toBe(true);
    expect(messages.structuredContent).toEqual({ messages: [] });
    expect(diagnostics.some((entry) => entry.startsWith("raw:kind="))).toBe(true);
    expect(diagnostics.some((entry) => entry.startsWith("inbound:initialize:"))).toBe(true);
    expect(diagnostics.some((entry) => entry.startsWith("inbound:tools/list:"))).toBe(true);
    expect(diagnostics.some((entry) => entry.startsWith("publish:accepted:kind="))).toBe(true);
    expect(diagnostics.some((entry) => entry.includes("disabled_unused_stream="))).toBe(true);
    expect(diagnostics.some((entry) => entry.startsWith("outbound:result response:"))).toBe(true);

    await client.close();
  }, 15_000);

  test("round-trips canonical admission for the exact requested KeyPackage over Nostr", async () => {
    const coordinatorKeys = KeyManager.generate();
    running = await transportFactory.create(
      coordinatorKeys.getSecretKeyBytes(),
      [relay.url],
      { announce: false, maxUsers: 64, coordinatorName: "My coordinator" },
      false,
    );

    const requesterSigner = new BrowserNostrSigner(KeyManager.generate().getSecretKeyBytes());
    const hostSigner = new BrowserNostrSigner(KeyManager.generate().getSecretKeyBytes());
    const requesterPubkey = await requesterSigner.getPublicKey();
    const hostPubkey = await hostSigner.getPublicKey();
    const requested = await createKeyPackage(requesterPubkey);
    const decoy = await createKeyPackage(requesterPubkey);
    const hostKeys = await createKeyPackage(hostPubkey);
    const hostState = await createRoomState(hostKeys.keyPackage, hostKeys.privateKeyPackage);
    const roomId = groupId(hostState);
    const target = {
      coordinatorPubkey: coordinatorKeys.identity.publicKeyHex,
      relayUrls: [relay.url],
    };
    const requester = new ChatCoordinatorClient(target, requesterSigner);
    const host = new ChatCoordinatorClient(target, hostSigner);

    try {
      await requester.publishKeyPackage(requested.stored.reference, requested.stored.publicBase64);
      await requester.publishKeyPackage(decoy.stored.reference, decoy.stored.publicBase64);
      await requester.storeJoinRequest(roomId, requested.stored.reference);

      const [joinRequest] = await host.fetchJoinRequests(roomId);
      expect(joinRequest).toMatchObject({
        gid: roomId,
        pk: requesterPubkey,
        kp_ref: requested.stored.reference,
      });
      const consumed = await host.consumeKeyPackage(joinRequest.kp_ref);
      expect(consumed).toMatchObject({
        pk: requesterPubkey,
        kp_ref: requested.stored.reference,
      });
      const published = JSON.parse((consumed?.event as { content: string }).content) as {
        params: { arguments: { kp_64: string } };
      };
      const added = await addMember(hostState, published.params.arguments.kp_64);
      const posted = await host.postGroupMessage(roomId, added.commitBase64);
      await host.storeWelcome(
        requesterPubkey,
        requested.stored.reference,
        added.welcomeBase64,
        posted.cursor,
      );

      const welcomes = await requester.fetchWelcomes();
      expect(welcomes).toHaveLength(1);
      expect(welcomes[0]).toMatchObject({
        kp_ref: requested.stored.reference,
        after: posted.cursor,
      });
      expect(groupId(await joinWelcome(welcomes[0].welcome_64, requested.stored))).toBe(roomId);
    } finally {
      await Promise.allSettled([requester.close(), host.close()]);
    }
  }, 25_000);

  test("round-trips Cordn identity admission and an encrypted message over Nostr", async () => {
    const coordinatorKeys = KeyManager.generate();
    running = await transportFactory.create(
      coordinatorKeys.getSecretKeyBytes(),
      [relay.url],
      { announce: false, maxUsers: 64, coordinatorName: "My coordinator" },
      false,
    );

    const requesterSigner = new BrowserNostrSigner(KeyManager.generate().getSecretKeyBytes());
    const hostSigner = new BrowserNostrSigner(KeyManager.generate().getSecretKeyBytes());
    const requesterPubkey = await requesterSigner.getPublicKey();
    const hostPubkey = await hostSigner.getPublicKey();
    const staleOrdinary = await createKeyPackage(requesterPubkey);
    const lastResort = await createKeyPackage(requesterPubkey, { lastResort: true });
    const hostKeys = await createKeyPackage(hostPubkey);
    const hostState = await createRoomState(hostKeys.keyPackage, hostKeys.privateKeyPackage);
    const roomId = groupId(hostState);
    const target = {
      coordinatorPubkey: coordinatorKeys.identity.publicKeyHex,
      relayUrls: [relay.url],
    };
    const requester = new ChatCoordinatorClient(target, requesterSigner);
    const host = new ChatCoordinatorClient(target, hostSigner);

    try {
      await requester.publishKeyPackage(staleOrdinary.stored.reference, staleOrdinary.stored.publicBase64);
      await requester.publishKeyPackage(lastResort.stored.reference, lastResort.stored.publicBase64);
      await requester.storeJoinRequest(roomId, lastResort.stored.reference);

      const [joinRequest] = await host.fetchJoinRequests(roomId);
      const consumed = await host.consumeKeyPackage(joinRequest.pk);
      expect(consumed).toMatchObject({
        pk: requesterPubkey,
        kp_ref: staleOrdinary.stored.reference,
      });
      const published = JSON.parse((consumed?.event as { content: string }).content) as {
        params: { arguments: { kp_64: string } };
      };
      const added = await addMember(hostState, published.params.arguments.kp_64);
      const commit = await host.postGroupMessage(roomId, added.commitBase64);
      await host.storeWelcome(requesterPubkey, staleOrdinary.stored.reference, added.welcomeBase64, commit.cursor);

      const [welcome] = await requester.fetchWelcomes();
      let guestState = await joinWelcome(welcome.welcome_64, staleOrdinary.stored);
      expect(groupId(guestState)).toBe(roomId);

      const encrypted = await encryptMessage(added.state, {
        type: "message",
        id: crypto.randomUUID(),
        sender: hostPubkey,
        name: "Host",
        content: "Cordn interoperable",
        createdAt: Date.now(),
      });
      const posted = await host.postGroupMessage(roomId, encrypted.opaqueBase64);
      const messages = await requester.fetchMessages(roomId, commit.cursor);
      expect(messages).toHaveLength(1);
      expect(messages[0].cursor).toBe(posted.cursor);
      const decrypted = await decryptMessage(guestState, messages[0].msg_64, {
        expectedHostPubkey: hostPubkey,
      });
      guestState = decrypted.state;
      expect(groupId(guestState)).toBe(roomId);
      expect(decrypted.envelope).toMatchObject({
        sender: hostPubkey,
        name: "Host",
        content: "Cordn interoperable",
      });
    } finally {
      await Promise.allSettled([requester.close(), host.close()]);
    }
  }, 25_000);
});
