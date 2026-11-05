import { Client } from "@contextvm/mcp-sdk/client/index.js";
import { InMemoryTransport } from "@contextvm/mcp-sdk/inMemory.js";
import { McpServer } from "@contextvm/mcp-sdk/server/mcp";
import { OpenStreamWriter } from "@contextvm/sdk/transport";
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from "nostr-tools";
import { encode, keyPackageEncoder, mlsMessageEncoder, wireformats, type KeyPackage } from "ts-mls";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { ZodType } from "zod";

import { addMember, createKeyPackage, createRoomState } from "../src/client/protocol.js";
import * as contracts from "../src/contracts/index.js";
import { COORDINATOR_METHODS } from "../src/contracts/index.js";
import { Coordinator } from "../src/coordinator/index.js";
import { InMemoryCoordinatorStorage } from "../src/coordinator/storage/inMemoryStorage.js";
import { encodeBase64 } from "../src/server/base64.js";
import {
  CoordinatorAdapter,
  registerCoordinatorMethods,
  type AbuseProtectionOptions,
} from "../src/server/coordinatorMethods.js";
import { consoleServerLogger, type ServerLogger } from "../src/server/logger.js";

type Identity = { secretKey: Uint8Array; pubkey: string };
type GeneratedKeyPackage = Awaited<ReturnType<typeof createKeyPackage>>;
type LoggerMock = { [K in keyof ServerLogger]: ReturnType<typeof vi.fn<ServerLogger[K]>> };

function identity(): Identity {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

function signedEvent(signer: Identity, content = "publication"): NostrEvent {
  return finalizeEvent({ kind: 1059, created_at: 1_700_000_000, tags: [], content }, signer.secretKey);
}

function logger(): LoggerMock {
  return {
    info: vi.fn<ServerLogger["info"]>(),
    warn: vi.fn<ServerLogger["warn"]>(),
    error: vi.fn<ServerLogger["error"]>(),
  };
}

function abuse(overrides: Partial<AbuseProtectionOptions> = {}): AbuseProtectionOptions {
  return {
    rateLimit: { enabled: false, refillPerMinute: 0, burst: 0, idleTtlMs: 0 },
    keyPackageQuota: { maxPerIdentity: 0, maxLastResortPerIdentity: 1 },
    logRejections: true,
    ...overrides,
  };
}

function harness(options: { abuse?: AbuseProtectionOptions; events?: Map<string, NostrEvent> } = {}) {
  const storage = new InMemoryCoordinatorStorage();
  const coordinator = new Coordinator({ storage, welcomeCleanupIntervalMs: 0 });
  const log = logger();
  const events = options.events ?? new Map<string, NostrEvent>();
  const adapter = new CoordinatorAdapter(
    coordinator,
    (id) => events.get(id) ?? null,
    options.abuse ?? abuse(),
    log,
  );
  let nextEvent = 0;
  /** Publish `generated` as `signer`, through the same path as a verified inbound request. */
  const publish = (generated: GeneratedKeyPackage, signer: Identity) => {
    const id = `request-${(nextEvent += 1)}`;
    events.set(id, signedEvent(signer));
    return adapter.publishKeyPackage(
      { kp_ref: generated.stored.reference, kp_64: generated.stored.publicBase64 },
      { _meta: { clientPubkey: signer.pubkey, requestEventId: id } },
    );
  };
  return { storage, coordinator, adapter, log, events, publish };
}

function opaqueMessage(byte = 7): string {
  return encodeBase64(Uint8Array.from([byte, 2, 3]));
}

function fakeStream(overrides: Partial<Record<"start" | "write" | "close" | "abort", () => Promise<void>>> = {}) {
  const written: string[] = [];
  const stream = {
    isActive: true,
    start: vi.fn(overrides.start ?? (async () => undefined)),
    write: vi.fn(overrides.write ?? (async (chunk: string) => {
      written.push(chunk);
    })),
    close: vi.fn(overrides.close ?? (async () => {
      stream.isActive = false;
    })),
    abort: vi.fn<(reason?: string) => Promise<void>>(overrides.abort ?? (async () => {
      stream.isActive = false;
    })),
  };
  return { stream, written, parsed: () => written.map((chunk) => JSON.parse(chunk) as { cursor: number; gid: string }) };
}

function streamExtra(stream: unknown, clientPubkey: unknown = "subscriber-pubkey-long-enough") {
  return { _meta: { clientPubkey, stream } } as never;
}

function logged(log: LoggerMock, type: string) {
  return log.info.mock.calls.map(([bindings]) => bindings).filter((bindings) => bindings.type === type);
}

const alice = identity();
const bob = identity();
let aliceKeys: GeneratedKeyPackage[];
let aliceLastResort: GeneratedKeyPackage[];
let bobKeys: GeneratedKeyPackage;

beforeAll(async () => {
  aliceKeys = await Promise.all([1, 2, 3].map(() => createKeyPackage(alice.pubkey)));
  aliceLastResort = await Promise.all([1, 2, 3].map(() => createKeyPackage(alice.pubkey, { lastResort: true })));
  bobKeys = await createKeyPackage(bob.pubkey);
});

afterEach(() => vi.restoreAllMocks());

describe("kp_publish identity binding", () => {
  function setup() {
    const context = harness();
    const generated = aliceKeys[0]!;
    const input = { kp_ref: generated.stored.reference, kp_64: generated.stored.publicBase64 };
    const extra = (event: NostrEvent | null, clientPubkey = alice.pubkey) => {
      if (event) context.events.set("request", event);
      return { _meta: { clientPubkey, requestEventId: "request" } };
    };
    return { ...context, generated, input, extra };
  }

  test("stores a key package whose credential, signer and client all match", async () => {
    const { adapter, coordinator, input, extra } = setup();
    const event = signedEvent(alice);

    const result = await adapter.publishKeyPackage(input, extra(event));

    expect(result.content).toEqual([]);
    expect(result.structuredContent).toEqual({
      kp_ref: input.kp_ref,
      last_resort: false,
      at: expect.any(Number),
    });
    expect(contracts.publishKeyPackageOutputSchema.safeParse(result.structuredContent).success).toBe(true);
    expect(coordinator.getKeyPackage(input.kp_ref)).toMatchObject({
      stablePubkey: alice.pubkey,
      publicationEvent: event,
    });
  });

  test("reports a last-resort key package as such", async () => {
    const { publish } = harness();

    const result = await publish(aliceLastResort[0]!, alice);

    expect(result.structuredContent.last_resort).toBe(true);
  });

  test.each([
    ["no metadata", {}],
    ["no client pubkey", { _meta: {} }],
    ["an empty client pubkey", { _meta: { clientPubkey: "" } }],
    ["a non-string client pubkey", { _meta: { clientPubkey: 42 } }],
  ])("requires the transport-injected pubkey: %s", async (_label, extra) => {
    const { adapter, input } = setup();

    await expect(adapter.publishKeyPackage(input, extra as never)).rejects.toThrow("Missing injected client pubkey");
  });

  test.each([
    ["not base64", "***"],
    ["bytes that are not a key package", encodeBase64(Uint8Array.from([1, 2, 3]))],
  ])("rejects a kp_64 that is %s", async (_label, kp_64) => {
    const { adapter, input, extra } = setup();

    await expect(adapter.publishKeyPackage({ ...input, kp_64 }, extra(signedEvent(alice)))).rejects.toThrow("Invalid kp_64");
  });

  test("rejects a key package followed by trailing bytes", async () => {
    const { adapter, input, extra } = setup();
    const bytes = Uint8Array.from(atob(input.kp_64), (char) => char.charCodeAt(0));
    const kp_64 = encodeBase64(Uint8Array.from([...bytes, 0]));

    await expect(adapter.publishKeyPackage({ ...input, kp_64 }, extra(signedEvent(alice)))).rejects.toThrow("Invalid kp_64");
  });

  test.each([
    ["no request event id", { clientPubkey: alice.pubkey }],
    ["an empty request event id", { clientPubkey: alice.pubkey, requestEventId: "" }],
    ["a non-string request event id", { clientPubkey: alice.pubkey, requestEventId: 1 }],
    ["an event the transport no longer holds", { clientPubkey: alice.pubkey, requestEventId: "unknown" }],
  ])("requires the publication event: %s", async (_label, meta) => {
    const { adapter, input } = setup();

    await expect(adapter.publishKeyPackage(input, { _meta: meta })).rejects.toThrow("Missing publication event");
  });

  test("requires a request event resolver", async () => {
    const { input } = setup();
    const adapter = new CoordinatorAdapter(new Coordinator({ welcomeCleanupIntervalMs: 0 }));

    await expect(
      adapter.publishKeyPackage(input, { _meta: { clientPubkey: alice.pubkey, requestEventId: "request" } }),
    ).rejects.toThrow("Missing publication event");
  });

  test("rejects a tampered publication event and stores nothing", async () => {
    const { adapter, coordinator, input, extra } = setup();
    // Round-trip through JSON as an inbound event would, dropping nostr-tools' cached verification.
    const tampered = { ...(JSON.parse(JSON.stringify(signedEvent(alice))) as NostrEvent), content: "something else" };

    await expect(adapter.publishKeyPackage(input, extra(tampered))).rejects.toThrow("Invalid publication event signature");
    expect(coordinator.listAllKeyPackages()).toEqual([]);
  });

  test("rejects a publication signed by someone other than the injected client", async () => {
    const { adapter, input, extra } = setup();

    await expect(adapter.publishKeyPackage(input, extra(signedEvent(bob), alice.pubkey))).rejects.toThrow(
      "Publication event signer does not match injected client pubkey",
    );
  });

  test("rejects a key package whose credential names a different identity", async () => {
    const { adapter, input, extra } = setup();

    await expect(adapter.publishKeyPackage(input, extra(signedEvent(bob), bob.pubkey))).rejects.toThrow(
      "Key package credential identity does not match publication event signer",
    );
  });

  test.each([
    ["X.509", { credentialType: 2, certificates: [Uint8Array.from([1])] }],
    ["a custom", { credentialType: 0xf0f0, data: Uint8Array.from([1]) }],
  ])("rejects %s credential", async (_label, credential) => {
    const { adapter, generated, input, extra } = setup();
    const altered: KeyPackage = {
      ...generated.keyPackage,
      leafNode: { ...generated.keyPackage.leafNode, credential },
    } as never;
    const kp_64 = encodeBase64(encode(keyPackageEncoder, altered));

    await expect(adapter.publishKeyPackage({ ...input, kp_64 }, extra(signedEvent(alice)))).rejects.toThrow(
      "Only BasicCredential key packages are supported",
    );
  });
});

describe("key package quota", () => {
  const quota = (maxPerIdentity: number, maxLastResortPerIdentity = 1, logRejections = true) =>
    harness({ abuse: abuse({ keyPackageQuota: { maxPerIdentity, maxLastResortPerIdentity }, logRejections }) });

  const refs = (context: ReturnType<typeof harness>) =>
    context.coordinator.listKeyPackagesForIdentity(alice.pubkey).map((record) => record.keyPackageRef);

  test("rejects an ordinary key package over the quota and logs only a pubkey prefix", async () => {
    const context = quota(1);
    await context.publish(aliceKeys[0]!, alice);

    await expect(context.publish(aliceKeys[1]!, alice)).rejects.toThrow("Key package quota exceeded");

    expect(refs(context)).toEqual([aliceKeys[0]!.stored.reference]);
    expect(context.log.warn).toHaveBeenCalledWith(
      {
        type: "key_package_quota",
        reason: "max key packages per identity exceeded",
        clientPubkey: `${alice.pubkey.slice(0, 12)}…`,
      },
      "cordn abuse protection rejection",
    );
  });

  test("does not log rejections when logging is disabled", async () => {
    const context = quota(1, 1, false);
    await context.publish(aliceKeys[0]!, alice);

    await expect(context.publish(aliceKeys[1]!, alice)).rejects.toThrow("Key package quota exceeded");

    expect(context.log.warn).not.toHaveBeenCalled();
  });

  test("applies the quota per identity", async () => {
    const context = quota(1);
    await context.publish(aliceKeys[0]!, alice);

    await expect(context.publish(bobKeys, bob)).resolves.toBeDefined();
  });

  test("a quota of zero means unlimited", async () => {
    const context = quota(0, 0);
    for (const generated of [...aliceKeys, ...aliceLastResort]) {
      await context.publish(generated, alice);
    }

    expect(refs(context)).toHaveLength(6);
  });

  test("replaces the existing last-resort key package", async () => {
    const context = quota(2);
    await context.publish(aliceKeys[0]!, alice);
    await context.publish(aliceLastResort[0]!, alice);

    await context.publish(aliceLastResort[1]!, alice);

    expect(refs(context)).toEqual([aliceKeys[0]!.stored.reference, aliceLastResort[1]!.stored.reference]);
  });

  test("rejects a last-resort key package with no room left beside the ordinary ones", async () => {
    const context = quota(1);
    await context.publish(aliceKeys[0]!, alice);

    await expect(context.publish(aliceLastResort[0]!, alice)).rejects.toThrow("Key package quota exceeded");

    expect(context.log.warn).toHaveBeenCalledOnce();
    expect(refs(context)).toEqual([aliceKeys[0]!.stored.reference]);
  });

  test("a rejected last-resort publication keeps the existing last-resort key package", async () => {
    // Reachable when a persistent host restarts with a lower maxUsers.
    const context = quota(0);
    await context.publish(aliceKeys[0]!, alice);
    await context.publish(aliceKeys[1]!, alice);
    await context.publish(aliceLastResort[0]!, alice);
    const lowered = new CoordinatorAdapter(
      context.coordinator,
      (id) => context.events.get(id) ?? null,
      abuse({ keyPackageQuota: { maxPerIdentity: 2, maxLastResortPerIdentity: 1 } }),
      context.log,
    );
    context.events.set("late", signedEvent(alice));

    await expect(
      lowered.publishKeyPackage(
        { kp_ref: aliceLastResort[1]!.stored.reference, kp_64: aliceLastResort[1]!.stored.publicBase64 },
        { _meta: { clientPubkey: alice.pubkey, requestEventId: "late" } },
      ),
    ).rejects.toThrow("Key package quota exceeded");

    expect(refs(context)).toContain(aliceLastResort[0]!.stored.reference);
  });

  test("keeps the newest last-resort key packages when several are allowed", async () => {
    const context = quota(0, 2);
    await context.publish(aliceLastResort[0]!, alice);
    await context.publish(aliceLastResort[1]!, alice);

    await context.publish(aliceLastResort[2]!, alice);

    expect(refs(context)).toEqual([aliceLastResort[1]!.stored.reference, aliceLastResort[2]!.stored.reference]);
  });

  test("counts a retained last-resort key package against the identity quota", async () => {
    const tight = quota(2, 2);
    await tight.publish(aliceKeys[0]!, alice);
    await tight.publish(aliceLastResort[0]!, alice);
    await expect(tight.publish(aliceLastResort[1]!, alice)).rejects.toThrow("Key package quota exceeded");
    expect(refs(tight)).toEqual([aliceKeys[0]!.stored.reference, aliceLastResort[0]!.stored.reference]);

    const roomy = quota(3, 2);
    await roomy.publish(aliceKeys[0]!, alice);
    await roomy.publish(aliceLastResort[0]!, alice);
    await expect(roomy.publish(aliceLastResort[1]!, alice)).resolves.toBeDefined();
    expect(refs(roomy)).toHaveLength(3);
  });

  test("with no last-resort limit, every last-resort key package counts against the quota", async () => {
    const context = quota(2, 0);
    await context.publish(aliceLastResort[0]!, alice);
    await context.publish(aliceLastResort[1]!, alice);

    await expect(context.publish(aliceLastResort[2]!, alice)).rejects.toThrow("Key package quota exceeded");

    expect(refs(context)).toEqual([aliceLastResort[0]!.stored.reference, aliceLastResort[1]!.stored.reference]);
  });

  test("uses the built-in abuse protection defaults", async () => {
    const events = new Map<string, NostrEvent>();
    const log = logger();
    const adapter = new CoordinatorAdapter(
      new Coordinator({ welcomeCleanupIntervalMs: 0 }),
      (id) => events.get(id) ?? null,
      undefined,
      log,
    );
    const publishLastResort = (generated: GeneratedKeyPackage, id: string) => {
      events.set(id, signedEvent(alice));
      return adapter.publishKeyPackage(
        { kp_ref: generated.stored.reference, kp_64: generated.stored.publicBase64 },
        { _meta: { clientPubkey: alice.pubkey, requestEventId: id } },
      );
    };

    await publishLastResort(aliceLastResort[0]!, "first");
    await publishLastResort(aliceLastResort[1]!, "second");
    expect(adapter.listAvailableKeyPackages({}).structuredContent.keyPackages.map((entry) => entry.kp_ref)).toEqual([
      aliceLastResort[1]!.stored.reference,
    ]);

    const extra = { _meta: { clientPubkey: "default-client" } };
    for (let request = 0; request < 160; request += 1) {
      adapter.assertWithinRateLimit(extra, "kp_list");
    }
    expect(() => adapter.assertWithinRateLimit(extra, "kp_list")).toThrow("Rate limit exceeded");
    expect(log.warn).toHaveBeenCalledOnce();
  });
});

describe("key package tools", () => {
  test("kp_list reports the public fields of every available key package", async () => {
    const { adapter, publish } = harness();
    await publish(aliceKeys[0]!, alice);
    await publish(bobKeys, bob);

    const { structuredContent } = adapter.listAvailableKeyPackages({});

    expect(structuredContent.keyPackages).toEqual([
      { pk: alice.pubkey, kp_ref: aliceKeys[0]!.stored.reference, last_resort: false, at: expect.any(Number) },
      { pk: bob.pubkey, kp_ref: bobKeys.stored.reference, last_resort: false, at: expect.any(Number) },
    ]);
    expect(contracts.listAvailableKeyPackagesOutputSchema.safeParse(structuredContent).success).toBe(true);
  });

  test("kp_take returns null for an unknown identifier", () => {
    const { adapter } = harness();

    expect(adapter.consumeKeyPackage({ id: "unknown" }).structuredContent).toEqual({ keyPackage: null });
  });

  test("kp_take consumes an ordinary key package with its publication event", async () => {
    const { adapter, publish, coordinator, events } = harness();
    await publish(aliceKeys[0]!, alice);
    const event = [...events.values()][0];

    const { structuredContent } = adapter.consumeKeyPackage({ id: aliceKeys[0]!.stored.reference });

    expect(structuredContent.keyPackage).toEqual({
      pk: alice.pubkey,
      kp_ref: aliceKeys[0]!.stored.reference,
      last_resort: false,
      at: expect.any(Number),
      event,
    });
    expect(contracts.consumeKeyPackageOutputSchema.safeParse(structuredContent).success).toBe(true);
    expect(coordinator.getKeyPackage(aliceKeys[0]!.stored.reference)).toBeNull();
  });

  test("kp_take leaves a last-resort key package available", async () => {
    const { adapter, publish, coordinator } = harness();
    await publish(aliceLastResort[0]!, alice);

    const { structuredContent } = adapter.consumeKeyPackage({ id: aliceLastResort[0]!.stored.reference });

    expect(structuredContent.keyPackage?.last_resort).toBe(true);
    expect(coordinator.getKeyPackage(aliceLastResort[0]!.stored.reference)).not.toBeNull();
  });

  test("kp_remove removes only the caller's own key packages", async () => {
    const { adapter, publish, coordinator } = harness();
    await publish(aliceKeys[0]!, alice);
    await publish(bobKeys, bob);
    const extra = { _meta: { clientPubkey: alice.pubkey } };

    expect(adapter.removeKeyPackages({ kp_refs: [aliceKeys[0]!.stored.reference] }, extra).structuredContent).toEqual({
      kp_refs: [aliceKeys[0]!.stored.reference],
    });
    expect(coordinator.getKeyPackage(aliceKeys[0]!.stored.reference)).toBeNull();
    expect(coordinator.getKeyPackage(bobKeys.stored.reference)).not.toBeNull();
  });

  test("kp_remove is all-or-nothing when any reference is unauthorized or unknown", async () => {
    const { adapter, publish, coordinator } = harness();
    await publish(aliceKeys[0]!, alice);
    await publish(bobKeys, bob);
    const extra = { _meta: { clientPubkey: alice.pubkey } };
    const mine = aliceKeys[0]!.stored.reference;

    expect(() => adapter.removeKeyPackages({ kp_refs: [mine, bobKeys.stored.reference] }, extra)).toThrow(
      `Unauthorized key package ref: ${bobKeys.stored.reference}`,
    );
    expect(() => adapter.removeKeyPackages({ kp_refs: [mine, "missing"] }, extra)).toThrow(
      "Unknown key package ref: missing",
    );
    expect(coordinator.getKeyPackage(mine)).not.toBeNull();
  });

  test("kp_remove reports a reference listed twice both times", async () => {
    const { adapter, publish } = harness();
    await publish(aliceKeys[0]!, alice);
    const ref = aliceKeys[0]!.stored.reference;

    expect(
      adapter.removeKeyPackages({ kp_refs: [ref, ref] }, { _meta: { clientPubkey: alice.pubkey } }).structuredContent.kp_refs,
    ).toEqual([ref, ref]);
  });

  test("kp_remove requires the injected pubkey", () => {
    const { adapter } = harness();

    expect(() => adapter.removeKeyPackages({ kp_refs: ["any"] }, {})).toThrow("Missing injected client pubkey");
  });
});

describe("welcome tools", () => {
  let welcome_64: string;

  beforeAll(async () => {
    const host = await createKeyPackage("11".repeat(32));
    const guest = await createKeyPackage(bob.pubkey);
    const state = await createRoomState(host.keyPackage, host.privateKeyPackage);
    welcome_64 = (await addMember(state, guest.stored.publicBase64)).welcomeBase64;
  });

  test("delivers a stored welcome only to its target and returns its replay cursor", () => {
    const { adapter } = harness();

    const stored = adapter.storeWelcome({ target_pk: bob.pubkey, kp_ref: "kp", welcome_64, after: 9 });
    expect(contracts.storeWelcomeOutputSchema.safeParse(stored.structuredContent).success).toBe(true);

    expect(adapter.fetchPendingWelcomes({}, { _meta: { clientPubkey: alice.pubkey } }).structuredContent.welcomes).toEqual([]);

    const taken = adapter.fetchPendingWelcomes({}, { _meta: { clientPubkey: bob.pubkey } }).structuredContent;
    expect(taken.welcomes).toEqual([
      { kp_ref: "kp", welcome_64, at: stored.structuredContent.at, after: 9 },
    ]);
    expect(contracts.fetchPendingWelcomesOutputSchema.safeParse(taken).success).toBe(true);
  });

  test("omits the replay cursor when the welcome has none", () => {
    const { adapter } = harness();
    adapter.storeWelcome({ target_pk: bob.pubkey, kp_ref: "kp", welcome_64 });

    const [welcome] = adapter.fetchPendingWelcomes({}, { _meta: { clientPubkey: bob.pubkey } }).structuredContent.welcomes;

    expect(welcome).not.toHaveProperty("after");
  });

  test("acknowledged welcomes are passed to the coordinator as consumed", () => {
    const { adapter, coordinator } = harness();
    const fetch = vi.spyOn(coordinator, "fetchPendingWelcomes");

    adapter.fetchPendingWelcomes({ consumed: [{ kp_ref: "kp", at: 5 }] }, { _meta: { clientPubkey: bob.pubkey } });

    expect(fetch).toHaveBeenCalledWith(bob.pubkey, [{ keyPackageReference: "kp", createdAt: 5 }]);
  });

  test("welcome_take requires the injected pubkey", () => {
    const { adapter } = harness();

    expect(() => adapter.fetchPendingWelcomes({}, {})).toThrow("Missing injected client pubkey");
  });

  test.each([
    ["not base64", "***"],
    ["undecodable bytes", encodeBase64(Uint8Array.from([1, 2, 3]))],
    ["a valid MLS message of the wrong type", encodeBase64(encode(mlsMessageEncoder, {
      version: 1,
      wireformat: wireformats.mls_private_message,
      privateMessage: {
        groupId: Uint8Array.from([1]),
        epoch: 1n,
        contentType: 1,
        authenticatedData: new Uint8Array(),
        encryptedSenderData: new Uint8Array(),
        ciphertext: Uint8Array.from([1]),
      },
    }))],
  ])("welcome_store rejects %s", (_label, invalid) => {
    const { adapter, coordinator } = harness();

    expect(() => adapter.storeWelcome({ target_pk: bob.pubkey, kp_ref: "kp", welcome_64: invalid })).toThrow("Invalid welcome_64");
    expect(coordinator.fetchPendingWelcomes(bob.pubkey)).toEqual([]);
  });
});

describe("join request tools", () => {
  const extra = { _meta: { clientPubkey: alice.pubkey } };

  test("requires the injected pubkey", async () => {
    const { adapter } = harness();

    await expect(adapter.storeJoinRequest({ gid: "g", kp_ref: "kp" }, {})).rejects.toThrow("Missing injected client pubkey");
  });

  test("rejects an unknown key package", async () => {
    const { adapter } = harness();

    await expect(adapter.storeJoinRequest({ gid: "g", kp_ref: "kp" }, extra)).rejects.toThrow("Unknown key package ref");
  });

  test("rejects another identity's key package", async () => {
    const { adapter, publish } = harness();
    await publish(bobKeys, bob);

    await expect(adapter.storeJoinRequest({ gid: "g", kp_ref: bobKeys.stored.reference }, extra)).rejects.toThrow(
      "Unauthorized key package ref",
    );
  });

  test("stores the request under the injected identity and returns it to the host once", async () => {
    const { adapter, publish } = harness();
    await publish(aliceKeys[0]!, alice);
    const ref = aliceKeys[0]!.stored.reference;

    const stored = await adapter.storeJoinRequest({ gid: "g", kp_ref: ref, invite_token: "token" }, extra);

    expect(contracts.storeJoinRequestOutputSchema.safeParse(stored.structuredContent).success).toBe(true);
    const taken = adapter.fetchPendingJoinRequests({ gid: "g" }).structuredContent;
    expect(taken.requests).toEqual([
      { pk: alice.pubkey, kp_ref: ref, at: stored.structuredContent.at, invite_token: "token" },
    ]);
    expect(contracts.fetchPendingJoinRequestsOutputSchema.safeParse(taken).success).toBe(true);
  });

  test("responds only after same-process join listeners finish", async () => {
    const { adapter, publish, coordinator } = harness();
    await publish(aliceKeys[0]!, alice);
    let finishListener: () => void = () => undefined;
    coordinator.subscribeJoinRequests("g", () => new Promise<void>((resolve) => {
      finishListener = resolve;
    }));
    let settled = false;

    const pending = adapter.storeJoinRequest({ gid: "g", kp_ref: aliceKeys[0]!.stored.reference }, extra).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    finishListener();
    await pending;
    expect(settled).toBe(true);
  });

  test("join_request_take_many maps groups and acknowledgements", async () => {
    const { adapter, publish, coordinator } = harness();
    await publish(aliceKeys[0]!, alice);
    const ref = aliceKeys[0]!.stored.reference;
    const stored = await adapter.storeJoinRequest({ gid: "g", kp_ref: ref }, extra);
    const fetch = vi.spyOn(coordinator, "fetchManyPendingJoinRequests");

    const taken = adapter.fetchManyPendingJoinRequests({ groups: [{ gid: "g" }, { gid: "empty" }] }).structuredContent;
    expect(taken.requests).toEqual([
      { gid: "g", pk: alice.pubkey, kp_ref: ref, at: stored.structuredContent.at, invite_token: undefined },
    ]);
    expect(contracts.fetchManyPendingJoinRequestsOutputSchema.safeParse(taken).success).toBe(true);
    expect(fetch).toHaveBeenLastCalledWith({ groups: [{ groupId: "g" }, { groupId: "empty" }], consumed: undefined });

    adapter.fetchManyPendingJoinRequests({
      groups: [{ gid: "g" }],
      consumed: [{ gid: "g", pk: alice.pubkey, at: 1 }],
    });
    expect(fetch).toHaveBeenLastCalledWith({
      groups: [{ groupId: "g" }],
      consumed: [{ groupId: "g", requesterStablePubkey: alice.pubkey, createdAt: 1 }],
    });
  });
});

describe("group message tools", () => {
  const extra = { _meta: { clientPubkey: "sender-pubkey-long-enough" } };

  test("posts an opaque message and fetches it back after a cursor", () => {
    const { adapter } = harness();

    const first = adapter.postGroupMessage({ gid: "g", msg_64: opaqueMessage(1) }, extra);
    const second = adapter.postGroupMessage({ gid: "g", msg_64: opaqueMessage(2) }, extra);

    expect(first.structuredContent).toEqual({ cursor: 1, gid: "g", at: expect.any(Number) });
    expect(contracts.postGroupMessageOutputSchema.safeParse(first.structuredContent).success).toBe(true);
    const fetched = adapter.fetchGroupMessages({ gid: "g", after: 1 }).structuredContent;
    expect(fetched.messages).toEqual([
      { cursor: 2, gid: "g", msg_64: opaqueMessage(2), at: second.structuredContent.at },
    ]);
    expect(contracts.fetchGroupMessagesOutputSchema.safeParse(fetched).success).toBe(true);
    expect(fetched.messages[0]).not.toHaveProperty("epoch");
  });

  test("msg_post requires the injected pubkey and a non-empty base64 payload", () => {
    const { adapter, coordinator } = harness();

    expect(() => adapter.postGroupMessage({ gid: "g", msg_64: opaqueMessage() }, {})).toThrow("Missing injected client pubkey");
    expect(() => adapter.postGroupMessage({ gid: "g", msg_64: "***" }, extra)).toThrow("Invalid msg_64");
    expect(coordinator.fetchGroupMessages({ groupId: "g" })).toEqual([]);
  });

  test("logs a stale handshake rejection without the full client pubkey", () => {
    const { adapter, storage, log } = harness();
    vi.spyOn(storage, "appendGroupMessage").mockImplementation(() => {
      throw new Error("Rejected stale handshake at epoch 3");
    });

    expect(() => adapter.postGroupMessage({ gid: "g", msg_64: opaqueMessage() }, extra)).toThrow("Rejected stale handshake");

    expect(log.warn).toHaveBeenCalledWith(
      { type: "stale_handshake", clientPubkey: "sender-pubke…", error: "Rejected stale handshake at epoch 3" },
      "stale handshake rejected",
    );
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(extra._meta.clientPubkey);
  });

  test.each([
    ["an unrelated error", new Error("disk full")],
    ["a non-Error value", "disk full"],
  ])("does not log %s as a stale handshake", (_label, failure) => {
    const { adapter, storage, log } = harness();
    vi.spyOn(storage, "appendGroupMessage").mockImplementation(() => {
      throw failure;
    });

    expect(() => adapter.postGroupMessage({ gid: "g", msg_64: opaqueMessage() }, extra)).toThrow();

    expect(log.warn).not.toHaveBeenCalled();
  });

  test("passes a parsed since_epoch to the coordinator", () => {
    const { adapter, coordinator } = harness();
    const fetch = vi.spyOn(coordinator, "fetchGroupMessages");

    adapter.fetchGroupMessages({ gid: "g", since_epoch: "18446744073709551616" });
    adapter.fetchGroupMessages({ gid: "g" });

    expect(fetch).toHaveBeenNthCalledWith(1, { groupId: "g", afterCursor: undefined, sinceEpoch: 18446744073709551616n });
    expect(fetch).toHaveBeenNthCalledWith(2, { groupId: "g", afterCursor: undefined, sinceEpoch: undefined });
  });

  test("rejects a since_epoch that is not an integer", () => {
    const { adapter } = harness();
    const message = 'Invalid since_epoch value: "abc". Must be a non-negative integer string.';

    expect(() => adapter.fetchGroupMessages({ gid: "g", since_epoch: "abc" })).toThrow(message);
    expect(() => adapter.fetchManyGroupMessages({ groups: [{ gid: "g", since_epoch: "abc" }] })).toThrow(message);
  });

  test("msg_fetch_many applies an independent cursor to each group", () => {
    const { adapter } = harness();
    adapter.postGroupMessage({ gid: "a", msg_64: opaqueMessage(1) }, extra);
    adapter.postGroupMessage({ gid: "a", msg_64: opaqueMessage(2) }, extra);
    adapter.postGroupMessage({ gid: "b", msg_64: opaqueMessage(3) }, extra);

    const fetched = adapter.fetchManyGroupMessages({ groups: [{ gid: "a", after: 1 }, { gid: "b" }] }).structuredContent;

    expect(fetched.messages.map(({ gid, msg_64 }) => [gid, msg_64])).toEqual([
      ["a", opaqueMessage(2)],
      ["b", opaqueMessage(3)],
    ]);
    expect(contracts.fetchManyGroupMessagesOutputSchema.safeParse(fetched).success).toBe(true);
  });
});

describe("msg_sub", () => {
  const extra = { _meta: { clientPubkey: "sender-pubkey-long-enough" } };

  async function subscribed(context: ReturnType<typeof harness>, input: { gid: string; after?: number; since_epoch?: string }, stream: unknown, client?: unknown) {
    const pending = context.adapter.subscribeGroupMessages(input, streamExtra(stream, client));
    pending.catch(() => undefined);
    await vi.waitFor(() => expect((stream as { start: ReturnType<typeof vi.fn> }).start).toHaveBeenCalled());
    return pending;
  }

  test("requires an open stream writer", async () => {
    const { adapter, coordinator } = harness();

    await expect(adapter.subscribeGroupMessages({ gid: "g" }, extra)).rejects.toThrow("Expected open stream writer in _meta.stream");
    await expect(adapter.subscribeGroupMessages({ gid: "g" }, {})).rejects.toThrow("Expected open stream writer in _meta.stream");
    expect(coordinator.getActiveSubscriptionMetrics().activeStreams).toBe(0);
  });

  test("rejects an invalid since_epoch before subscribing", async () => {
    const { adapter, coordinator } = harness();
    const { stream } = fakeStream();

    await expect(adapter.subscribeGroupMessages({ gid: "g", since_epoch: "abc" }, streamExtra(stream))).rejects.toThrow("Invalid since_epoch");

    expect(stream.start).not.toHaveBeenCalled();
    expect(coordinator.getActiveSubscriptionMetrics().activeStreams).toBe(0);
  });

  test("refuses a deleted room", async () => {
    const { adapter, coordinator } = harness();
    coordinator.deleteGroup("g");
    const { stream } = fakeStream();

    await expect(adapter.subscribeGroupMessages({ gid: "g" }, streamExtra(stream))).rejects.toThrow("Room deleted by host");
    expect(stream.start).not.toHaveBeenCalled();
  });

  test("releases the subscription when the backlog cannot be read", async () => {
    const { adapter, coordinator, storage } = harness();
    vi.spyOn(storage, "fetchGroupMessages").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const { stream } = fakeStream();

    await expect(adapter.subscribeGroupMessages({ gid: "g" }, streamExtra(stream))).rejects.toThrow("storage unavailable");

    expect(coordinator.getActiveSubscriptionMetrics()).toEqual({ activeStreams: 0, groupLegs: 0 });
  });

  test("replays the backlog after the cursor, then streams live messages without duplicates", async () => {
    const context = harness();
    const { adapter, coordinator } = context;
    adapter.postGroupMessage({ gid: "g", msg_64: opaqueMessage(1) }, extra);
    adapter.postGroupMessage({ gid: "g", msg_64: opaqueMessage(2) }, extra);
    const { stream, parsed } = fakeStream();
    const originalAbort = stream.abort;

    const pending = subscribed(context, { gid: "g", after: 1 }, stream);
    await vi.waitFor(() => expect(parsed().map((message) => message.cursor)).toEqual([2]));

    adapter.postGroupMessage({ gid: "g", msg_64: opaqueMessage(3) }, extra);
    await vi.waitFor(() => expect(parsed().map((message) => message.cursor)).toEqual([2, 3]));
    expect(parsed()[1]).toEqual({ cursor: 3, gid: "g", msg_64: opaqueMessage(3), at: expect.any(Number) });

    coordinator.deleteGroup("g");
    const result = await pending;

    expect(result.structuredContent).toEqual({ subscribed: true });
    expect(stream.close).toHaveBeenCalledOnce();
    expect(originalAbort).not.toHaveBeenCalled();
    expect(coordinator.getActiveSubscriptionMetrics().activeStreams).toBe(0);
  });

  test("does not re-emit a backlog message that is also on the live queue", async () => {
    const context = harness();
    const { adapter, coordinator, storage } = context;
    // Post during the backlog read: it is both returned by the read and queued live.
    const fetchBacklog = storage.fetchGroupMessages.bind(storage);
    vi.spyOn(storage, "fetchGroupMessages").mockImplementationOnce((input) => {
      adapter.postGroupMessage({ gid: "g", msg_64: opaqueMessage(1) }, extra);
      return fetchBacklog(input);
    });
    const { stream, parsed } = fakeStream();

    const pending = subscribed(context, { gid: "g" }, stream);
    await vi.waitFor(() => expect(parsed()).toHaveLength(1));
    adapter.postGroupMessage({ gid: "g", msg_64: opaqueMessage(2) }, extra);
    await vi.waitFor(() => expect(parsed()).toHaveLength(2));
    coordinator.deleteGroup("g");
    await pending;

    expect(parsed().map((message) => message.cursor)).toEqual([1, 2]);
  });

  test("logs lifecycle with a pubkey prefix and message-free bindings", async () => {
    const context = harness();
    const { adapter, coordinator, log } = context;
    adapter.postGroupMessage({ gid: "g", msg_64: opaqueMessage(9) }, extra);
    const { stream } = fakeStream();
    const client = "subscriber-pubkey-long-enough";

    const pending = subscribed(context, { gid: "g" }, stream, client);
    await vi.waitFor(() => expect(stream.write).toHaveBeenCalled());
    coordinator.deleteGroup("g");
    await pending;

    expect(logged(log, "subscription_start")).toEqual([
      { type: "subscription_start", groupId: "g", activeStreams: 1, groupLegs: 1, clientPubkey: "subscriber-p…" },
    ]);
    expect(logged(log, "subscription_end")).toEqual([
      { type: "subscription_end", groupId: "g", reason: "complete", activeStreams: 0, groupLegs: 0, clientPubkey: "subscriber-p…" },
    ]);
    const output = JSON.stringify(log.info.mock.calls);
    expect(output).not.toContain(client);
    expect(output).not.toContain(opaqueMessage(9));
  });

  test.each([
    ["missing", undefined],
    ["empty", ""],
    ["non-string", 42],
  ])("omits the log label when the client pubkey is %s", async (_label, client) => {
    const context = harness();
    const { stream } = fakeStream();

    const pending = context.adapter.subscribeGroupMessages({ gid: "g" }, { _meta: { clientPubkey: client, stream } } as never);
    await vi.waitFor(() => expect(stream.start).toHaveBeenCalled());
    context.coordinator.deleteGroup("g");
    await pending;

    expect(logged(context.log, "subscription_start")[0]?.clientPubkey).toBeUndefined();
  });

  test("an external abort ends the subscription, records its reason and restores the writer", async () => {
    const context = harness();
    const { coordinator, log } = context;
    const { stream } = fakeStream();
    const originalAbort = stream.abort;

    const pending = subscribed(context, { gid: "g" }, stream);
    await vi.waitFor(() => expect(coordinator.getActiveSubscriptionMetrics().activeStreams).toBe(1));
    expect(stream.abort).not.toBe(originalAbort);

    await stream.abort("client cancelled");
    await stream.abort("client cancelled again");
    const result = await pending;

    expect(result.structuredContent).toEqual({ subscribed: true });
    expect(originalAbort).toHaveBeenCalledWith("client cancelled");
    expect(stream.close).not.toHaveBeenCalled();
    expect(logged(log, "subscription_end")).toEqual([
      expect.objectContaining({ reason: "client cancelled" }),
    ]);
    expect(coordinator.getActiveSubscriptionMetrics().activeStreams).toBe(0);
    await stream.abort("after completion");
    expect(logged(log, "subscription_end")).toHaveLength(1);
  });

  test("an abort without a reason is logged as abort", async () => {
    const context = harness();
    const { stream } = fakeStream();

    const pending = subscribed(context, { gid: "g" }, stream);
    await vi.waitFor(() => expect(stream.start).toHaveBeenCalled());
    await stream.abort();
    await pending;

    expect(logged(context.log, "subscription_end")[0]?.reason).toBe("abort");
  });

  test.each([
    ["start", { start: async () => { throw new Error("relay down"); } }],
    ["close", { close: async () => { throw new Error("relay down"); } }],
  ])("a failing stream %s aborts the stream and surfaces the error", async (operation, overrides) => {
    const context = harness();
    const { coordinator } = context;
    const { stream } = fakeStream(overrides);
    const originalAbort = stream.abort;

    const pending = context.adapter.subscribeGroupMessages({ gid: "g" }, streamExtra(stream));
    pending.catch(() => undefined);
    if (operation === "close") {
      await vi.waitFor(() => expect(stream.start).toHaveBeenCalled());
      coordinator.deleteGroup("g");
    }
    await expect(pending).rejects.toThrow("relay down");

    expect(originalAbort).toHaveBeenCalledWith("relay down");
    expect(coordinator.getActiveSubscriptionMetrics().activeStreams).toBe(0);
    expect(logged(context.log, "subscription_end")[0]?.reason).toBe("relay down");
  });

  test("a failing backlog write aborts the stream", async () => {
    const context = harness();
    context.adapter.postGroupMessage({ gid: "g", msg_64: opaqueMessage(1) }, extra);
    const { stream } = fakeStream({ write: async () => { throw new Error("write failed"); } });

    await expect(context.adapter.subscribeGroupMessages({ gid: "g" }, streamExtra(stream))).rejects.toThrow("write failed");

    expect(context.coordinator.getActiveSubscriptionMetrics().activeStreams).toBe(0);
  });

  test("a failing live write aborts the stream", async () => {
    const context = harness();
    const { stream } = fakeStream({ write: async () => { throw new Error("write failed"); } });

    const pending = subscribed(context, { gid: "g" }, stream);
    await vi.waitFor(() => expect(context.coordinator.getActiveSubscriptionMetrics().activeStreams).toBe(1));
    context.adapter.postGroupMessage({ gid: "g", msg_64: opaqueMessage(1) }, extra);

    await expect(pending).rejects.toThrow("write failed");
    expect(context.coordinator.getActiveSubscriptionMetrics().activeStreams).toBe(0);
  });

  test("a non-Error failure aborts with a generic reason, and a failing abort keeps the original error", async () => {
    const context = harness();
    const { stream } = fakeStream({
      start: () => Promise.reject("not an error"),
      abort: () => Promise.reject(new Error("abort also failed")),
    });
    const originalAbort = stream.abort;

    await expect(context.adapter.subscribeGroupMessages({ gid: "g" }, streamExtra(stream))).rejects.toBe("not an error");

    expect(originalAbort).toHaveBeenCalledWith("Stream aborted");
    expect(logged(context.log, "subscription_end")[0]?.reason).toBe("Stream aborted");
  });

  test("a writer torn down without an abort still releases the subscription", async () => {
    const context = harness();
    const setSubscriptionMetrics = vi.fn();
    context.adapter.setTelemetrySink({ setSubscriptionMetrics });
    const writer = new OpenStreamWriter({ progressToken: "token", publishFrame: vi.fn(async () => undefined) });

    const pending = context.adapter.subscribeGroupMessages({ gid: "g" }, streamExtra(writer));
    await vi.waitFor(() => expect(writer.hasStarted).toBe(true));
    expect(context.coordinator.getActiveSubscriptionMetrics().activeStreams).toBe(1);

    writer.dispose();
    await pending;

    expect(context.coordinator.getActiveSubscriptionMetrics().activeStreams).toBe(0);
    expect(setSubscriptionMetrics).toHaveBeenLastCalledWith({ activeStreams: 0, groupLegs: 0 });
    expect(logged(context.log, "subscription_end")[0]?.reason).toBe("stream inactive");
  });

  test("a writer already inactive when the handler runs does not leave the subscription waiting", async () => {
    const context = harness();
    const writer = new OpenStreamWriter({ progressToken: "token", publishFrame: vi.fn(async () => undefined) });
    await writer.abort("cancelled before the tool ran");

    await context.adapter.subscribeGroupMessages({ gid: "g" }, streamExtra(writer));

    expect(context.coordinator.getActiveSubscriptionMetrics().activeStreams).toBe(0);
    expect(logged(context.log, "subscription_end")[0]?.reason).toBe("stream inactive");
  });

  test("a completing real writer publishes its close frame and logs completion", async () => {
    const context = harness();
    const publishFrame = vi.fn(async () => undefined);
    const writer = new OpenStreamWriter({ progressToken: "token", publishFrame });

    const pending = context.adapter.subscribeGroupMessages({ gid: "g" }, streamExtra(writer));
    await vi.waitFor(() => expect(writer.hasStarted).toBe(true));
    context.coordinator.deleteGroup("g");
    await pending;

    expect(writer.isActive).toBe(false);
    expect(publishFrame).toHaveBeenCalledTimes(2);
    expect(logged(context.log, "subscription_end")[0]?.reason).toBe("complete");
  });
});

describe("msg_sub_many", () => {
  const extra = { _meta: { clientPubkey: "sender-pubkey-long-enough" } };
  const groups = [{ gid: "a", after: 1 }, { gid: "b" }];

  function open(context: ReturnType<typeof harness>, stream: unknown, input: { groups: Array<{ gid: string; after?: number; since_epoch?: string }> } = { groups }, client?: unknown) {
    const pending = context.adapter.subscribeManyGroupMessages(input, streamExtra(stream, client));
    pending.catch(() => undefined);
    return pending;
  }

  test("requires an open stream writer", async () => {
    const { adapter } = harness();

    await expect(adapter.subscribeManyGroupMessages({ groups }, extra)).rejects.toThrow("Expected open stream writer in _meta.stream");
  });

  test("rejects an invalid since_epoch or a deleted room before subscribing", async () => {
    const { adapter, coordinator } = harness();
    coordinator.deleteGroup("deleted");
    const { stream } = fakeStream();

    await expect(adapter.subscribeManyGroupMessages({ groups: [{ gid: "a", since_epoch: "x" }] }, streamExtra(stream))).rejects.toThrow("Invalid since_epoch");
    await expect(adapter.subscribeManyGroupMessages({ groups: [{ gid: "a" }, { gid: "deleted" }] }, streamExtra(stream))).rejects.toThrow("Room deleted by host");

    expect(stream.start).not.toHaveBeenCalled();
    expect(coordinator.getActiveSubscriptionMetrics().groupLegs).toBe(0);
  });

  test("replays each group's backlog and streams live messages until the rooms close", async () => {
    const context = harness();
    const { adapter, coordinator } = context;
    adapter.postGroupMessage({ gid: "a", msg_64: opaqueMessage(1) }, extra);
    adapter.postGroupMessage({ gid: "a", msg_64: opaqueMessage(2) }, extra);
    adapter.postGroupMessage({ gid: "b", msg_64: opaqueMessage(3) }, extra);
    const { stream, parsed } = fakeStream();

    const pending = open(context, stream, { groups: [{ gid: "a", after: 1, since_epoch: "0" }, { gid: "b" }] });
    await vi.waitFor(() => expect(parsed().map(({ gid, cursor }) => [gid, cursor])).toEqual([["a", 2], ["b", 1]]));

    adapter.postGroupMessage({ gid: "b", msg_64: opaqueMessage(4) }, extra);
    await vi.waitFor(() => expect(parsed()).toHaveLength(3));

    coordinator.deleteGroup("a");
    const result = await pending;

    expect(result.structuredContent).toEqual({ subscribed: true, groups: ["a", "b"] });
    expect(contracts.subscribeManyGroupMessagesOutputSchema.safeParse(result.structuredContent).success).toBe(true);
    expect(stream.close).toHaveBeenCalledOnce();
    expect(coordinator.getActiveSubscriptionMetrics()).toEqual({ activeStreams: 0, groupLegs: 0 });
  });

  test("logs its lifecycle once, with a pubkey prefix and no message bytes", async () => {
    const context = harness();
    const { stream } = fakeStream();
    context.adapter.postGroupMessage({ gid: "b", msg_64: opaqueMessage(5) }, extra);

    const pending = open(context, stream, { groups }, "subscriber-pubkey-long-enough");
    await vi.waitFor(() => expect(stream.write).toHaveBeenCalled());
    context.coordinator.deleteGroup("b");
    await pending;

    expect(logged(context.log, "subscription_start")).toEqual([
      { type: "subscription_start", groupIds: ["a", "b"], groupCount: 2, activeStreams: 1, groupLegs: 2, clientPubkey: "subscriber-p…" },
    ]);
    expect(logged(context.log, "subscription_end")).toEqual([
      { type: "subscription_end", groupIds: ["a", "b"], groupCount: 2, reason: "complete", activeStreams: 0, groupLegs: 0, clientPubkey: "subscriber-p…" },
    ]);
    const output = JSON.stringify(context.log.info.mock.calls);
    expect(output).not.toContain("subscriber-pubkey-long-enough");
    expect(output).not.toContain(opaqueMessage(5));
  });

  test.each([
    ["missing", undefined],
    ["empty", ""],
  ])("omits the log label when the client pubkey is %s", async (_label, client) => {
    const context = harness();
    const { stream } = fakeStream();

    const pending = context.adapter.subscribeManyGroupMessages({ groups }, { _meta: { clientPubkey: client, stream } } as never);
    await vi.waitFor(() => expect(stream.start).toHaveBeenCalled());
    await stream.abort("done");
    await pending;

    expect(logged(context.log, "subscription_start")[0]?.clientPubkey).toBeUndefined();
  });

  test("an external abort is logged once with its reason and restores the writer", async () => {
    const context = harness();
    const { stream } = fakeStream();
    const originalAbort = stream.abort;

    const pending = open(context, stream);
    await vi.waitFor(() => expect(stream.start).toHaveBeenCalled());
    await stream.abort("client cancelled");
    await stream.abort("again");
    await pending;

    expect(originalAbort).toHaveBeenCalledWith("client cancelled");
    expect(stream.close).not.toHaveBeenCalled();
    expect(logged(context.log, "subscription_end").map((entry) => entry.reason)).toEqual(["client cancelled"]);
    await stream.abort("after completion");
    expect(logged(context.log, "subscription_end")).toHaveLength(1);
  });

  test("an abort without a reason is logged as abort", async () => {
    const context = harness();
    const { stream } = fakeStream();

    const pending = open(context, stream);
    await vi.waitFor(() => expect(stream.start).toHaveBeenCalled());
    await stream.abort();
    await pending;

    expect(logged(context.log, "subscription_end")[0]?.reason).toBe("abort");
  });

  test("stops writing once the stream has gone inactive", async () => {
    const context = harness();
    const { stream } = fakeStream();

    const pending = open(context, stream);
    await vi.waitFor(() => expect(context.coordinator.getActiveSubscriptionMetrics().activeStreams).toBe(1));
    await vi.waitFor(() => expect(stream.start).toHaveBeenCalled());
    stream.isActive = false;
    context.adapter.postGroupMessage({ gid: "b", msg_64: opaqueMessage(1) }, extra);
    await pending;

    expect(stream.write).not.toHaveBeenCalled();
    expect(stream.close).not.toHaveBeenCalled();
    expect(context.coordinator.getActiveSubscriptionMetrics().activeStreams).toBe(0);
  });

  test("a failing write aborts the stream and surfaces the error", async () => {
    const context = harness();
    context.adapter.postGroupMessage({ gid: "b", msg_64: opaqueMessage(1) }, extra);
    const { stream } = fakeStream({ write: async () => { throw new Error("write failed"); } });
    const originalAbort = stream.abort;

    await expect(open(context, stream)).rejects.toThrow("write failed");

    expect(originalAbort).toHaveBeenCalledWith("write failed");
    expect(context.coordinator.getActiveSubscriptionMetrics().activeStreams).toBe(0);
  });

  test("a non-Error failure aborts with a generic reason, and a failing abort keeps the original error", async () => {
    const context = harness();
    const { stream } = fakeStream({
      start: () => Promise.reject("not an error"),
      abort: () => Promise.reject(new Error("abort also failed")),
    });
    const originalAbort = stream.abort;

    await expect(open(context, stream)).rejects.toBe("not an error");

    expect(originalAbort).toHaveBeenCalledWith("Stream aborted");
    expect(logged(context.log, "subscription_end")[0]?.reason).toBe("Stream aborted");
  });

  test("a writer torn down without an abort still releases every leg", async () => {
    const context = harness();
    const writer = new OpenStreamWriter({ progressToken: "token", publishFrame: vi.fn(async () => undefined) });

    const pending = context.adapter.subscribeManyGroupMessages({ groups }, streamExtra(writer));
    await vi.waitFor(() => expect(writer.hasStarted).toBe(true));
    expect(context.coordinator.getActiveSubscriptionMetrics().groupLegs).toBe(2);

    writer.dispose();
    await pending;

    expect(context.coordinator.getActiveSubscriptionMetrics()).toEqual({ activeStreams: 0, groupLegs: 0 });
    expect(logged(context.log, "subscription_end")[0]?.reason).toBe("stream inactive");
  });

  test("a writer already inactive when the handler runs does not leave the subscription waiting", async () => {
    const context = harness();
    const writer = new OpenStreamWriter({ progressToken: "token", publishFrame: vi.fn(async () => undefined) });
    await writer.abort("cancelled before the tool ran");

    await context.adapter.subscribeManyGroupMessages({ groups }, streamExtra(writer));

    expect(context.coordinator.getActiveSubscriptionMetrics()).toEqual({ activeStreams: 0, groupLegs: 0 });
    expect(logged(context.log, "subscription_end")[0]?.reason).toBe("stream inactive");
  });

  test("a completing real writer logs completion, not the inactive transition", async () => {
    const context = harness();
    const writer = new OpenStreamWriter({ progressToken: "token", publishFrame: vi.fn(async () => undefined) });

    const pending = context.adapter.subscribeManyGroupMessages({ groups }, streamExtra(writer));
    await vi.waitFor(() => expect(writer.hasStarted).toBe(true));
    context.coordinator.deleteGroup("a");
    await pending;

    expect(logged(context.log, "subscription_end")[0]?.reason).toBe("complete");
  });
});

describe("telemetry and metrics", () => {
  const extra = { _meta: { clientPubkey: "sender-pubkey-long-enough" } };

  test("counts each operation per method in logs and telemetry", () => {
    const { adapter, log } = harness();
    const recordOperation = vi.fn();
    adapter.setTelemetrySink({ recordOperation });

    adapter.postGroupMessage({ gid: "g", msg_64: opaqueMessage() }, extra);
    adapter.postGroupMessage({ gid: "g", msg_64: opaqueMessage() }, extra);
    adapter.fetchGroupMessages({ gid: "g" });

    expect(recordOperation.mock.calls.map(([method]) => method)).toEqual([
      "postGroupMessage",
      "postGroupMessage",
      "fetchGroupMessages",
    ]);
    expect(logged(log, "operation")).toEqual([
      { type: "operation", method: "postGroupMessage", count: 1 },
      { type: "operation", method: "postGroupMessage", count: 2 },
      { type: "operation", method: "fetchGroupMessages", count: 1 },
    ]);
  });

  test("records each handler's operation name", async () => {
    const { adapter, publish, coordinator } = harness();
    const recordOperation = vi.fn();
    adapter.setTelemetrySink({ recordOperation });
    const owner = { _meta: { clientPubkey: alice.pubkey } };

    await publish(aliceKeys[0]!, alice);
    await publish(aliceKeys[1]!, alice);
    adapter.consumeKeyPackage({ id: aliceKeys[0]!.stored.reference });
    await adapter.storeJoinRequest({ gid: "g", kp_ref: aliceKeys[1]!.stored.reference }, owner);
    adapter.fetchPendingJoinRequests({ gid: "g" });
    adapter.fetchManyPendingJoinRequests({ groups: [{ gid: "g" }] });
    adapter.removeKeyPackages({ kp_refs: [aliceKeys[1]!.stored.reference] }, owner);
    adapter.fetchManyGroupMessages({ groups: [{ gid: "g" }] });

    const single = fakeStream().stream;
    const firstStream = adapter.subscribeGroupMessages({ gid: "x" }, streamExtra(single));
    await vi.waitFor(() => expect(single.start).toHaveBeenCalled());
    coordinator.deleteGroup("x");
    await firstStream;

    const many = fakeStream().stream;
    const secondStream = adapter.subscribeManyGroupMessages({ groups: [{ gid: "y" }] }, streamExtra(many));
    await vi.waitFor(() => expect(many.start).toHaveBeenCalled());
    coordinator.deleteGroup("y");
    await secondStream;

    expect(recordOperation.mock.calls.map(([method]) => method)).toEqual([
      "publishKeyPackage",
      "publishKeyPackage",
      "consumeKeyPackage",
      "storeJoinRequest",
      "fetchPendingJoinRequests",
      "fetchManyPendingJoinRequests",
      "removeKeyPackages",
      "fetchManyGroupMessages",
      "subscribeGroupMessages",
      "subscribeManyGroupMessages",
    ]);
  });

  test("a failed operation is not counted", () => {
    const { adapter, log } = harness();

    expect(() => adapter.postGroupMessage({ gid: "g", msg_64: "***" }, extra)).toThrow();

    expect(logged(log, "operation")).toEqual([]);
  });

  test("a sink with only some callbacks, or none, is safe", async () => {
    const { adapter, coordinator } = harness();

    adapter.setTelemetrySink({});
    adapter.postGroupMessage({ gid: "g", msg_64: opaqueMessage() }, extra);
    adapter.setTelemetrySink(undefined);
    adapter.postGroupMessage({ gid: "g", msg_64: opaqueMessage() }, extra);

    expect(coordinator.fetchGroupMessages({ groupId: "g" })).toHaveLength(2);
  });

  test("setting a sink immediately reports the current subscription counts", async () => {
    const context = harness();
    const { stream } = fakeStream();
    const pending = context.adapter.subscribeGroupMessages({ gid: "g" }, streamExtra(stream));
    await vi.waitFor(() => expect(stream.start).toHaveBeenCalled());
    const setActiveSubscriptions = vi.fn();
    const setSubscriptionMetrics = vi.fn();

    context.adapter.setTelemetrySink({ setActiveSubscriptions, setSubscriptionMetrics });

    expect(setActiveSubscriptions).toHaveBeenCalledWith(1);
    expect(setSubscriptionMetrics).toHaveBeenCalledWith({ activeStreams: 1, groupLegs: 1 });

    context.coordinator.deleteGroup("g");
    await pending;
    expect(setActiveSubscriptions).toHaveBeenLastCalledWith(0);
  });

  test("accepts a telemetry sink at construction", () => {
    const recordOperation = vi.fn();
    const adapter = new CoordinatorAdapter(
      new Coordinator({ welcomeCleanupIntervalMs: 0 }),
      undefined,
      abuse(),
      logger(),
      { recordOperation },
    );

    adapter.fetchGroupMessages({ gid: "g" });

    expect(recordOperation).toHaveBeenCalledWith("fetchGroupMessages");
  });

  test("closing the adapter closes the coordinator's storage", () => {
    const { adapter, storage } = harness();
    const close = vi.spyOn(storage, "close");

    adapter.close();

    expect(close).toHaveBeenCalledOnce();
  });

  test("the default logger writes nothing, so request metadata cannot reach the console", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));
    const adapter = new CoordinatorAdapter(new Coordinator({ welcomeCleanupIntervalMs: 0 }), undefined, abuse());

    adapter.postGroupMessage({ gid: "g", msg_64: opaqueMessage() }, extra);
    consoleServerLogger.info({ secret: "value" }, "info");
    consoleServerLogger.warn({ secret: "value" }, "warn");
    consoleServerLogger.error({ secret: "value" }, "error");

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("rate limit gate", () => {
  test("rejects with a logged, abbreviated pubkey after the burst", () => {
    const { adapter, log } = harness({
      abuse: abuse({ rateLimit: { enabled: true, refillPerMinute: 0, burst: 1, idleTtlMs: 0 } }),
    });
    const extra = { _meta: { clientPubkey: alice.pubkey } };

    adapter.assertWithinRateLimit(extra, "kp_list");
    expect(() => adapter.assertWithinRateLimit(extra, "kp_list")).toThrow("Rate limit exceeded");

    expect(log.warn).toHaveBeenCalledWith(
      { type: "rate_limit", method: "kp_list", clientPubkey: `${alice.pubkey.slice(0, 12)}…` },
      "cordn abuse protection rejection",
    );
  });

  test("does not log rejections when logging is disabled", () => {
    const { adapter, log } = harness({
      abuse: abuse({ logRejections: false, rateLimit: { enabled: true, refillPerMinute: 0, burst: 1, idleTtlMs: 0 } }),
    });
    const extra = { _meta: { clientPubkey: alice.pubkey } };

    adapter.assertWithinRateLimit(extra, "kp_list");
    expect(() => adapter.assertWithinRateLimit(extra, "kp_list")).toThrow("Rate limit exceeded");

    expect(log.warn).not.toHaveBeenCalled();
  });

  test("limits each client independently", () => {
    const { adapter } = harness({
      abuse: abuse({ rateLimit: { enabled: true, refillPerMinute: 0, burst: 1, idleTtlMs: 0 } }),
    });

    adapter.assertWithinRateLimit({ _meta: { clientPubkey: "a" } }, "kp_list");
    expect(() => adapter.assertWithinRateLimit({ _meta: { clientPubkey: "b" } }, "kp_list")).not.toThrow();
  });
});

describe("registered tools", () => {
  type Handler = (input: unknown, extra: unknown) => unknown;
  type Definition = { description: string; inputSchema: ZodType; outputSchema: ZodType };

  function registered(context: ReturnType<typeof harness>) {
    const tools = new Map<string, { definition: Definition; handler: Handler }>();
    const server = {
      registerTool: (name: string, definition: Definition, handler: Handler) => {
        tools.set(name, { definition, handler });
      },
    };
    registerCoordinatorMethods(server as unknown as McpServer, context.adapter);
    return tools;
  }

  const client = { _meta: { clientPubkey: alice.pubkey } };

  test("every tool declares a description and its input and output schemas", () => {
    const tools = registered(harness());
    const expected: Record<string, [ZodType, ZodType]> = {
      [COORDINATOR_METHODS.publishKeyPackage]: [contracts.publishKeyPackageInputSchema, contracts.publishKeyPackageOutputSchema],
      [COORDINATOR_METHODS.listAvailableKeyPackages]: [contracts.listAvailableKeyPackagesInputSchema, contracts.listAvailableKeyPackagesOutputSchema],
      [COORDINATOR_METHODS.removeKeyPackages]: [contracts.removeKeyPackagesInputSchema, contracts.removeKeyPackagesOutputSchema],
      [COORDINATOR_METHODS.consumeKeyPackage]: [contracts.consumeKeyPackageInputSchema, contracts.consumeKeyPackageOutputSchema],
      [COORDINATOR_METHODS.fetchPendingWelcomes]: [contracts.fetchPendingWelcomesInputSchema, contracts.fetchPendingWelcomesOutputSchema],
      [COORDINATOR_METHODS.storeWelcome]: [contracts.storeWelcomeInputSchema, contracts.storeWelcomeOutputSchema],
      [COORDINATOR_METHODS.storeJoinRequest]: [contracts.storeJoinRequestInputSchema, contracts.storeJoinRequestOutputSchema],
      [COORDINATOR_METHODS.fetchPendingJoinRequests]: [contracts.fetchPendingJoinRequestsInputSchema, contracts.fetchPendingJoinRequestsOutputSchema],
      [COORDINATOR_METHODS.fetchManyPendingJoinRequests]: [contracts.fetchManyPendingJoinRequestsInputSchema, contracts.fetchManyPendingJoinRequestsOutputSchema],
      [COORDINATOR_METHODS.postGroupMessage]: [contracts.postGroupMessageInputSchema, contracts.postGroupMessageOutputSchema],
      [COORDINATOR_METHODS.fetchGroupMessages]: [contracts.fetchGroupMessagesInputSchema, contracts.fetchGroupMessagesOutputSchema],
      [COORDINATOR_METHODS.fetchManyGroupMessages]: [contracts.fetchManyGroupMessagesInputSchema, contracts.fetchManyGroupMessagesOutputSchema],
      [COORDINATOR_METHODS.subscribeGroupMessages]: [contracts.subscribeGroupMessagesInputSchema, contracts.subscribeGroupMessagesOutputSchema],
      [COORDINATOR_METHODS.subscribeManyGroupMessages]: [contracts.subscribeManyGroupMessagesInputSchema, contracts.subscribeManyGroupMessagesOutputSchema],
    };

    expect([...tools.keys()].sort()).toEqual(Object.keys(expected).sort());
    for (const [name, [input, output]] of Object.entries(expected)) {
      const tool = tools.get(name)!;
      expect(tool.definition.description.length).toBeGreaterThan(0);
      expect(tool.definition.inputSchema).toBe(input);
      expect(tool.definition.outputSchema).toBe(output);
    }
  });

  test.each(Object.values(COORDINATOR_METHODS))("%s requires the injected pubkey before doing any work", (name) => {
    const context = harness();
    const tool = registered(context).get(name)!;
    const assertion = vi.spyOn(context.adapter, "assertWithinRateLimit");

    expect(() => tool.handler({}, { _meta: {} })).toThrow("Missing injected client pubkey");
    expect(assertion).toHaveBeenCalledWith({ _meta: {} }, name);
  });

  test.each(Object.values(COORDINATOR_METHODS))("%s is rate limited", (name) => {
    const context = harness({
      abuse: abuse({ rateLimit: { enabled: true, refillPerMinute: 0, burst: 0, idleTtlMs: 0 } }),
    });
    const tool = registered(context).get(name)!;

    expect(() => tool.handler({}, client)).toThrow("Rate limit exceeded");
    expect(context.log.warn).toHaveBeenCalledWith(expect.objectContaining({ type: "rate_limit", method: name }), expect.any(String));
  });

  test("each handler delegates to its adapter method with the right arguments", async () => {
    const context = harness();
    const tools = registered(context);
    const expectations: Array<[string, keyof CoordinatorAdapter, boolean]> = [
      [COORDINATOR_METHODS.publishKeyPackage, "publishKeyPackage", true],
      [COORDINATOR_METHODS.listAvailableKeyPackages, "listAvailableKeyPackages", false],
      [COORDINATOR_METHODS.removeKeyPackages, "removeKeyPackages", true],
      [COORDINATOR_METHODS.consumeKeyPackage, "consumeKeyPackage", false],
      [COORDINATOR_METHODS.fetchPendingWelcomes, "fetchPendingWelcomes", true],
      [COORDINATOR_METHODS.storeWelcome, "storeWelcome", false],
      [COORDINATOR_METHODS.storeJoinRequest, "storeJoinRequest", true],
      [COORDINATOR_METHODS.fetchPendingJoinRequests, "fetchPendingJoinRequests", false],
      [COORDINATOR_METHODS.fetchManyPendingJoinRequests, "fetchManyPendingJoinRequests", false],
      [COORDINATOR_METHODS.postGroupMessage, "postGroupMessage", true],
      [COORDINATOR_METHODS.fetchGroupMessages, "fetchGroupMessages", false],
      [COORDINATOR_METHODS.fetchManyGroupMessages, "fetchManyGroupMessages", false],
      [COORDINATOR_METHODS.subscribeGroupMessages, "subscribeGroupMessages", true],
      [COORDINATOR_METHODS.subscribeManyGroupMessages, "subscribeManyGroupMessages", true],
    ];

    for (const [name, method, takesExtra] of expectations) {
      const spy = vi.spyOn(context.adapter as unknown as Record<string, () => unknown>, method).mockReturnValue("delegated");
      const input = { marker: name };

      expect(await tools.get(name)!.handler(input, client)).toBe("delegated");

      expect(spy).toHaveBeenCalledWith(...(takesExtra ? [input, client] : [input]));
    }
  });
});

describe("tools over a real MCP server", () => {
  const sender = "ab".repeat(32);

  async function connect() {
    const context = harness();
    const server = new McpServer({ name: "test-coordinator", version: "0.0.0" });
    registerCoordinatorMethods(server, context.adapter);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await server.connect(serverSide);
    await client.connect(clientSide);
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args, _meta: { clientPubkey: sender } });
    return { ...context, client, server, call };
  }

  test("advertises the Cordn tool names", async () => {
    const { client, server } = await connect();

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.values(COORDINATOR_METHODS).sort());
    await server.close();
  });

  test("message tools validate input and satisfy their declared output schemas", async () => {
    const { call, server } = await connect();

    const posted = await call(COORDINATOR_METHODS.postGroupMessage, { gid: "g", msg_64: opaqueMessage() });
    expect(posted.isError).toBeFalsy();
    expect(posted.structuredContent).toMatchObject({ cursor: 1, gid: "g" });

    const fetched = await call(COORDINATOR_METHODS.fetchGroupMessages, { gid: "g", since_epoch: "0" });
    expect((fetched.structuredContent as { messages: unknown[] }).messages).toHaveLength(1);

    const negativeEpoch = await call(COORDINATOR_METHODS.fetchGroupMessages, { gid: "g", since_epoch: "-1" });
    expect(negativeEpoch.isError).toBe(true);
    expect(JSON.stringify(negativeEpoch.content)).toContain("since_epoch must be a non-negative integer string");

    const missingGroup = await call(COORDINATOR_METHODS.postGroupMessage, { msg_64: opaqueMessage() });
    expect(missingGroup.isError).toBe(true);

    await server.close();
  });

  test("handler failures reach the client as tool errors", async () => {
    const { call, server } = await connect();

    const result = await call(COORDINATOR_METHODS.storeJoinRequest, { gid: "g", kp_ref: "missing" });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Unknown key package ref");
    await server.close();
  });

  test("the injected pubkey, not a client argument, decides identity", async () => {
    const { call, coordinator, server } = await connect();

    await call(COORDINATOR_METHODS.postGroupMessage, { gid: "g", msg_64: opaqueMessage(), pk: "forged", clientPubkey: "forged" });

    expect(coordinator.fetchGroupMessages({ groupId: "g" })[0]?.ephemeralSenderPubkey).toBe(sender);
    await server.close();
  });
});
