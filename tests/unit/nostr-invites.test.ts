import { beforeEach, describe, expect, test, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event as NostrEvent } from "nostr-tools";

import {
  createGiftWrap,
  createLocalNip44Signer,
  unwrapGiftWrap,
} from "../../src/invites/nostr-envelope";
import {
  inviteEligibilityError,
  NostrSocialStore,
  shouldAcceptInvite,
} from "../../src/invites/nostr-social.svelte";
import {
  INVITATION_RESOLUTION_STORAGE_KEY,
  NotificationCenterStore,
} from "../../src/notifications/notification-center.svelte";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeContactPool {
  readonly querySync = vi.fn(async () => this.queries.shift() ?? [] as NostrEvent[]);
  readonly subscribeMany = vi.fn((_relays: readonly string[], _filters: unknown, handlers: { onevent(event: NostrEvent): void }) => {
    this.onContactEvent = handlers.onevent;
    return { close: this.close };
  });
  readonly publish = vi.fn(() => this.publications.shift() ?? [Promise.resolve("accepted")]);
  readonly destroy = vi.fn();
  readonly close = vi.fn();
  queries: Array<NostrEvent[] | Promise<NostrEvent[]>> = [];
  publications: Array<Array<Promise<string>>> = [];
  onContactEvent: ((event: NostrEvent) => void) | undefined;

  emit(event: NostrEvent): void {
    this.onContactEvent?.(event);
  }
}

function signedContact(secret: Uint8Array, createdAt: number, tags: string[][], content = ""): NostrEvent {
  return finalizeEvent({ kind: 3, created_at: createdAt, tags, content }, secret);
}

function contactTargets(event: NostrEvent): string[] {
  return event.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1] ?? "");
}

function publishedEvents(pool: FakeContactPool): NostrEvent[] {
  return (pool.publish.mock.calls as unknown as Array<[readonly string[], NostrEvent]>).map(([, event]) => event);
}

describe("private Nostr presence and invites", () => {
  beforeEach(() => localStorage.clear());

  test("round-trips a gift-wrapped invite without exposing its sender or payload", async () => {
    const sender = createLocalNip44Signer(generateSecretKey());
    const recipient = createLocalNip44Signer(generateSecretKey());
    const recipientPubkey = await recipient.getPublicKey();
    const senderPubkey = await sender.getPublicKey();

    const wrapped = await createGiftWrap(sender, recipientPubkey, 24134, {
      type: "cordn-room-invite",
      inviteUrl: "https://cordn.test/chat/secret",
    }, 1059);

    expect(wrapped.pubkey).not.toBe(senderPubkey);
    expect(wrapped.content).not.toContain("cordn-room-invite");
    expect(wrapped.content).not.toContain("/chat/secret");
    expect(wrapped.tags).toEqual([["p", recipientPubkey]]);

    const opened = await unwrapGiftWrap(recipient, wrapped);
    expect(opened.sender).toBe(senderPubkey);
    expect(opened.kind).toBe(24134);
    expect(opened.payload).toEqual({
      type: "cordn-room-invite",
      inviteUrl: "https://cordn.test/chat/secret",
    });
  });

  test("enforces mutual-online egress and followed-sender ingress", () => {
    const now = 10_000;
    expect(inviteEligibilityError("mutual", ["mutual"], [{ pubkey: "mutual", expiresAt: now + 1 }], now)).toBeNull();
    expect(inviteEligibilityError("stranger", ["mutual"], [], now)).toMatch(/mutual follows/);
    expect(inviteEligibilityError("mutual", ["mutual"], [{ pubkey: "mutual", expiresAt: now }], now)).toMatch(/not currently online/);

    expect(shouldAcceptInvite("followed", ["followed"])).toBe(true);
    expect(shouldAcceptInvite("stranger", ["followed"])).toBe(false);
  });

  test("resolves an invite before removing its live capability and persists no URL", () => {
    const social = new NostrSocialStore();
    social.incomingInvites = [{
      id: "handled-invite",
      from: "followed",
      fromName: "Alice",
      fromAvatar: "avatar",
      inviteUrl: "https://cordn.test/chat/room-secret-token",
      roomTitle: "Private room",
      createdAt: Date.now(),
    }];

    social.dismissInvite("handled-invite");

    expect(social.incomingInvites).toEqual([]);
    const persisted = localStorage.getItem(INVITATION_RESOLUTION_STORAGE_KEY) ?? "";
    expect(persisted).toContain("handled-invite");
    expect(persisted).not.toContain("room-secret-token");
    expect(new NotificationCenterStore().isInvitationResolved("handled-invite")).toBe(true);
  });

  test("suppresses replay of a trusted invite already resolved inside retention", async () => {
    const social = new NostrSocialStore();
    const internals = social as unknown as {
      socialGraphRefreshedAt: number;
      profiles: Map<string, unknown>;
      receiveInvite(sender: string, value: unknown): Promise<void>;
    };
    social.following = ["followed"];
    internals.socialGraphRefreshedAt = Date.now();
    internals.profiles.set("followed", { name: "Alice" });
    social.incomingInvites = [{
      id: "replayed-invite",
      from: "followed",
      fromName: "Alice",
      fromAvatar: "avatar",
      inviteUrl: "https://cordn.test/chat/another-secret",
      roomTitle: "Private room",
      createdAt: Date.now(),
    }];
    social.dismissInvite("replayed-invite");

    await internals.receiveInvite("followed", {
      type: "cordn-room-invite",
      id: "replayed-invite",
      inviteUrl: "https://cordn.test/chat/another-secret",
      roomTitle: "Private room",
      createdAt: Date.now(),
    });

    expect(social.incomingInvites).toEqual([]);
  });
});

describe("validated kind-3 contact lists", () => {
  beforeEach(() => localStorage.clear());

  test("accepts only the deterministic newest signed own kind-3 event", async () => {
    const ownerSecret = generateSecretKey();
    const foreignSecret = generateSecretKey();
    const owner = createLocalNip44Signer(ownerSecret);
    const pool = new FakeContactPool();
    const equalSecond = 1_700_000_000;
    const first = signedContact(ownerSecret, equalSecond, [["p", "a".repeat(64)]], "first");
    const second = signedContact(ownerSecret, equalSecond, [["p", "b".repeat(64)]], "second");
    const expected = [first, second].sort((left, right) => left.id.localeCompare(right.id))[0]!;
    const foreign = signedContact(foreignSecret, equalSecond + 10, [["p", "c".repeat(64)]]);
    const wrongKind = finalizeEvent({ kind: 1, created_at: equalSecond + 20, tags: [], content: "wrong" }, ownerSecret);
    const forged = { ...signedContact(ownerSecret, equalSecond + 30, [["p", "d".repeat(64)]]), id: "0".repeat(64) };
    const malformed = signedContact(ownerSecret, equalSecond + 40, [["p", "not-a-pubkey"]]);
    pool.queries.push([foreign, second, wrongKind, forged, malformed, first]);

    const social = new NostrSocialStore({ createPool: () => pool } as never);
    await social.startContactList(owner);

    expect(social.selectedContactEvent?.id).toBe(expected.id);
    expect(social.following).toEqual(contactTargets(expected));
    expect(social.contactStatus).toBe("ready");
  });

  test("keeps a live newer event when an older bounded query resolves later", async () => {
    const secret = generateSecretKey();
    const signer = createLocalNip44Signer(secret);
    const pool = new FakeContactPool();
    const query = deferred<NostrEvent[]>();
    const oldEvent = signedContact(secret, 10, [["p", "a".repeat(64)]]);
    const liveEvent = signedContact(secret, 11, [["p", "b".repeat(64)]]);
    pool.queries.push(query.promise);
    const social = new NostrSocialStore({ createPool: () => pool } as never);

    const started = social.startContactList(signer);
    await vi.waitFor(() => expect(pool.subscribeMany).toHaveBeenCalledOnce());
    pool.emit(liveEvent);
    query.resolve([oldEvent]);
    await started;

    expect(social.selectedContactEvent?.id).toBe(liveEvent.id);
    expect(social.following).toEqual(["b".repeat(64)]);
  });

  test("closes and invalidates an old identity before its query can mutate replacement state", async () => {
    const firstSecret = generateSecretKey();
    const secondSecret = generateSecretKey();
    const firstSigner = createLocalNip44Signer(firstSecret);
    const secondSigner = createLocalNip44Signer(secondSecret);
    const firstPool = new FakeContactPool();
    const secondPool = new FakeContactPool();
    const lateQuery = deferred<NostrEvent[]>();
    firstPool.queries.push(lateQuery.promise);
    secondPool.queries.push([]);
    const pools = [firstPool, secondPool];
    const social = new NostrSocialStore({ createPool: () => pools.shift()! } as never);

    const firstStart = social.startContactList(firstSigner);
    await social.startContactList(secondSigner);
    lateQuery.resolve([signedContact(firstSecret, 100, [["p", "a".repeat(64)]])]);
    await firstStart;

    expect(firstPool.close).toHaveBeenCalledOnce();
    expect(social.following).toEqual([]);
    expect(social.selectedContactEvent).toBeNull();
    expect(social.contactPubkey).toBe(getPublicKey(secondSecret));
  });

  test("derives an empty list from a successful empty query and retains validated state on refresh failure", async () => {
    const secret = generateSecretKey();
    const signer = createLocalNip44Signer(secret);
    const pool = new FakeContactPool();
    pool.queries.push([]);
    const social = new NostrSocialStore({ createPool: () => pool } as never);

    await social.startContactList(signer);
    expect(social.following).toEqual([]);

    pool.queries.push(Promise.reject(new Error("relay detail must not surface")));
    await social.refreshContactList();
    expect(social.following).toEqual([]);
    expect(social.contactStatus).toBe("reconnecting");
    expect(social.error).not.toContain("relay detail");
  });

  test("keeps contact-list state when the optional presence lifecycle stops", async () => {
    const secret = generateSecretKey();
    const signer = createLocalNip44Signer(secret);
    const pool = new FakeContactPool();
    const current = signedContact(secret, 10, [["p", "a".repeat(64)]]);
    pool.queries.push([current]);
    const social = new NostrSocialStore({ createPool: () => pool } as never);

    await social.startContactList(signer);
    social.disconnectPresence();

    expect(social.selectedContactEvent?.id).toBe(current.id);
    expect(social.following).toEqual(["a".repeat(64)]);
  });
});

describe("serialized kind-3 follows", () => {
  beforeEach(() => localStorage.clear());

  test("preserves exact content and unrelated tags while deduplicating and appending contacts", async () => {
    const secret = generateSecretKey();
    const signer = createLocalNip44Signer(secret);
    const targetA = "a".repeat(64);
    const targetB = "b".repeat(64);
    const targetC = "c".repeat(64);
    const base = signedContact(secret, 100, [["t", "topic"], ["p", targetA], ["p", targetB], ["p", targetA], ["client", "exact"]], "keep this exact");
    const pool = new FakeContactPool();
    pool.queries.push([base], [base]);
    const social = new NostrSocialStore({ createPool: () => pool, now: () => 99_000 } as never);

    await social.startContactList(signer);
    await social.follow(targetC);

    const published = publishedEvents(pool)[0]!;
    expect(published.content).toBe("keep this exact");
    expect(published.created_at).toBe(101);
    expect(published.tags).toEqual([["t", "topic"], ["p", targetA], ["p", targetB], ["client", "exact"], ["p", targetC]]);
    expect(social.following).toEqual([targetA, targetB, targetC]);
    expect(social.followStatus).toBe("success");
  });

  test("serializes concurrent follows so each accepted replacement retains prior targets", async () => {
    const secret = generateSecretKey();
    const signer = createLocalNip44Signer(secret);
    const targetA = "a".repeat(64);
    const targetB = "b".repeat(64);
    const pool = new FakeContactPool();
    pool.queries.push([], [], []);
    const social = new NostrSocialStore({ createPool: () => pool, now: () => 10_000 } as never);

    await social.startContactList(signer);
    await Promise.all([social.follow(targetA), social.follow(targetB)]);

    const published = publishedEvents(pool);
    expect(published).toHaveLength(2);
    expect(contactTargets(published[0]!)).toEqual([targetA]);
    expect(contactTargets(published[1]!)).toEqual([targetA, targetB]);
    expect(social.following).toEqual([targetA, targetB]);
  });

  test("waits for relay acceptance and suppresses only its own pending subscription echo", async () => {
    const secret = generateSecretKey();
    const signer = createLocalNip44Signer(secret);
    const target = "a".repeat(64);
    const base = signedContact(secret, 10, [], "existing");
    const accepted = deferred<string>();
    const pool = new FakeContactPool();
    pool.queries.push([base], [base]);
    pool.publications.push([accepted.promise]);
    const social = new NostrSocialStore({ createPool: () => pool, now: () => 11_000 } as never);

    await social.startContactList(signer);
    const following = social.follow(target);
    await vi.waitFor(() => expect(pool.publish).toHaveBeenCalledOnce());
    const pending = publishedEvents(pool)[0]!;
    pool.emit(pending);

    expect(social.selectedContactEvent?.id).toBe(base.id);
    expect(social.followStatus).toBe("pending");
    const independent = signedContact(secret, 12, [["p", "b".repeat(64)]], "newer device state");
    pool.emit(independent);
    expect(social.selectedContactEvent?.id).toBe(independent.id);
    accepted.resolve("accepted");
    await following;

    expect(social.selectedContactEvent?.id).toBe(independent.id);
    expect(social.followStatus).toBe("success");
  });

  test("leaves state retryable when every relay rejects or signer output is invalid", async () => {
    const secret = generateSecretKey();
    const foreignSecret = generateSecretKey();
    const signer = createLocalNip44Signer(secret);
    const target = "a".repeat(64);
    const base = signedContact(secret, 10, [], "existing");
    const pool = new FakeContactPool();
    const rejected = deferred<string>();
    pool.queries.push([base], [base]);
    pool.publications.push([rejected.promise]);
    const social = new NostrSocialStore({ createPool: () => pool, now: () => 11_000 } as never);

    await social.startContactList(signer);
    const following = social.follow(target);
    await vi.waitFor(() => expect(pool.publish).toHaveBeenCalledOnce());
    rejected.reject(new Error("relay diagnostic"));
    await expect(following).rejects.toThrow("Unable to follow on Nostr. Try again.");
    expect(social.selectedContactEvent?.id).toBe(base.id);
    expect(social.followStatus).toBe("error");
    expect(social.followError).toBe("Unable to follow on Nostr. Try again.");

    const invalidPool = new FakeContactPool();
    invalidPool.queries.push([base], [base]);
    const invalidSigner = {
      getPublicKey: signer.getPublicKey,
      signEvent: async (event: Pick<NostrEvent, "kind" | "created_at" | "tags" | "content">) => finalizeEvent(event, foreignSecret),
    };
    const invalidSocial = new NostrSocialStore({ createPool: () => invalidPool, now: () => 11_000 } as never);
    await invalidSocial.startContactList(invalidSigner as never);
    await expect(invalidSocial.follow(target)).rejects.toThrow("Unable to follow on Nostr. Try again.");
    expect(invalidPool.publish).not.toHaveBeenCalled();
    expect(invalidSocial.selectedContactEvent?.id).toBe(base.id);
  });

  test("does not let an accepted old-generation follow alter a replacement identity", async () => {
    const firstSecret = generateSecretKey();
    const secondSecret = generateSecretKey();
    const firstSigner = createLocalNip44Signer(firstSecret);
    const secondSigner = createLocalNip44Signer(secondSecret);
    const accepted = deferred<string>();
    const firstPool = new FakeContactPool();
    const secondPool = new FakeContactPool();
    firstPool.queries.push([], []);
    firstPool.publications.push([accepted.promise]);
    secondPool.queries.push([]);
    const pools = [firstPool, secondPool];
    const social = new NostrSocialStore({ createPool: () => pools.shift()!, now: () => 10_000 } as never);

    await social.startContactList(firstSigner);
    const following = social.follow("a".repeat(64));
    const queuedFollowing = social.follow("b".repeat(64));
    await vi.waitFor(() => expect(firstPool.publish).toHaveBeenCalledOnce());
    await social.startContactList(secondSigner);
    accepted.resolve("accepted");

    await expect(following).rejects.toThrow("Unable to follow on Nostr. Try again.");
    await expect(queuedFollowing).rejects.toThrow("Unable to follow on Nostr. Try again.");
    expect(social.contactPubkey).toBe(getPublicKey(secondSecret));
    expect(social.selectedContactEvent).toBeNull();
    expect(social.followStatus).toBe("idle");
    expect(secondPool.publish).not.toHaveBeenCalled();
  });

  test("does not let a hung old-generation follow block a replacement identity", async () => {
    const firstSecret = generateSecretKey();
    const secondSecret = generateSecretKey();
    const firstSigner = createLocalNip44Signer(firstSecret);
    const secondSigner = createLocalNip44Signer(secondSecret);
    const neverAccepted = deferred<string>();
    const firstPool = new FakeContactPool();
    const secondPool = new FakeContactPool();
    firstPool.queries.push([], []);
    firstPool.publications.push([neverAccepted.promise]);
    secondPool.queries.push([], []);
    const pools = [firstPool, secondPool];
    const social = new NostrSocialStore({ createPool: () => pools.shift()!, now: () => 10_000 } as never);

    await social.startContactList(firstSigner);
    void social.follow("a".repeat(64));
    await vi.waitFor(() => expect(firstPool.publish).toHaveBeenCalledOnce());

    await social.startContactList(secondSigner);
    await social.follow("b".repeat(64));

    expect(secondPool.publish).toHaveBeenCalledOnce();
    expect(contactTargets(publishedEvents(secondPool)[0]!)).toEqual(["b".repeat(64)]);
    expect(social.contactPubkey).toBe(getPublicKey(secondSecret));
  });
});
