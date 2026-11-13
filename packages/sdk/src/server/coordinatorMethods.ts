import { McpServer } from "@contextvm/mcp-sdk/server/mcp";
import type { OpenStreamWriter } from "@contextvm/sdk/transport";
import { verifyEvent, type NostrEvent } from "nostr-tools";
import type { z } from "zod";
import {
  isDefaultCredential,
  keyPackageDecoder,
  type KeyPackage,
  type Welcome,
} from "ts-mls";

import { isLastResortKeyPackage } from "../mls/lastResortKeyPackage.js";
import type { GroupMessageRecord } from "../coordinator/types.js";
import {
  Coordinator,
  type ActiveSubscriptionMetrics,
} from "../coordinator/coordinator.js";
import {
  consumeKeyPackageInputSchema,
  consumeKeyPackageOutputSchema,
  COORDINATOR_METHODS,
  fetchManyGroupMessagesInputSchema,
  fetchManyGroupMessagesOutputSchema,
  fetchManyPendingJoinRequestsInputSchema,
  fetchManyPendingJoinRequestsOutputSchema,
  fetchGroupMessagesInputSchema,
  fetchGroupMessagesOutputSchema,
  fetchPendingJoinRequestsInputSchema,
  fetchPendingJoinRequestsOutputSchema,
  fetchPendingWelcomesInputSchema,
  fetchPendingWelcomesOutputSchema,
  groupMessageSchema,
  listAvailableKeyPackagesInputSchema,
  listAvailableKeyPackagesOutputSchema,
  postGroupMessageInputSchema,
  postGroupMessageOutputSchema,
  publishKeyPackageInputSchema,
  publishKeyPackageOutputSchema,
  removeKeyPackagesInputSchema,
  removeKeyPackagesOutputSchema,
  storeJoinRequestInputSchema,
  storeJoinRequestOutputSchema,
  storeWelcomeInputSchema,
  storeWelcomeOutputSchema,
  subscribeManyGroupMessagesInputSchema,
  subscribeManyGroupMessagesOutputSchema,
  subscribeGroupMessagesInputSchema,
  subscribeGroupMessagesOutputSchema,
  type FetchManyGroupMessagesOutput,
  type FetchGroupMessagesOutput,
  type FetchPendingWelcomesOutput,
  type ListAvailableKeyPackagesOutput,
  type PostGroupMessageOutput,
  type PublishKeyPackageOutput,
  type RemoveKeyPackagesOutput,
  type StoreJoinRequestOutput,
  type StoreWelcomeOutput,
} from "../contracts/index.js";
import { decodeExact, decodeWelcome, encodeWelcome } from "../mls/mlsCodec.js";
import { assertNonEmptyBase64, encodeBase64 } from "./base64.js";
import {
  TokenBucketRateLimiter,
  type TokenBucketRateLimitConfig,
} from "./rateLimit.js";
import { consoleServerLogger, type ServerLogger } from "./logger.js";

type ToolExtra = {
  _meta?: Record<string, unknown>;
};
export type ResolveRequestEvent = (requestEventId: string) => NostrEvent | null;
const credentialIdentityDecoder = new TextDecoder();

export interface AbuseProtectionOptions {
  rateLimit: TokenBucketRateLimitConfig;
  keyPackageQuota: {
    maxPerIdentity: number;
    maxLastResortPerIdentity: number;
  };
  logRejections: boolean;
}

export interface CoordinatorTelemetrySink {
  recordOperation?: (methodName: string) => void;
  setSubscriptionMetrics?: (metrics: ActiveSubscriptionMetrics) => void;
  setActiveSubscriptions?: (count: number) => void;
}

function decodeKeyPackageBase64(kp_64: string): KeyPackage {
  try {
    return decodeExact(
      assertNonEmptyBase64(kp_64, "kp_64"),
      keyPackageDecoder,
      "kp_64",
    );
  } catch {
    throw new Error("Invalid kp_64");
  }
}

function decodeWelcomeBase64(welcome_64: string): Welcome {
  try {
    return decodeWelcome(
      assertNonEmptyBase64(welcome_64, "welcome_64"),
      "welcome_64",
    );
  } catch {
    throw new Error("Invalid welcome_64");
  }
}

function encodeWelcomeBase64(welcome: Welcome): string {
  return encodeBase64(encodeWelcome(welcome));
}

function parseSinceEpoch(sinceEpoch: string | undefined): bigint | undefined {
  if (sinceEpoch === undefined) {
    return undefined;
  }

  try {
    return BigInt(sinceEpoch);
  } catch {
    throw new Error(
      `Invalid since_epoch value: "${sinceEpoch}". Must be a non-negative integer string.`,
    );
  }
}

function decodeOpaqueMessageBase64(msg_64: string): Uint8Array {
  try {
    return assertNonEmptyBase64(msg_64, "msg_64");
  } catch {
    throw new Error("Invalid msg_64");
  }
}

function requireClientPubkey(extra: ToolExtra): string {
  const clientPubkey = extra._meta?.clientPubkey;
  if (typeof clientPubkey !== "string" || clientPubkey.length === 0) {
    throw new Error("Missing injected client pubkey");
  }

  return clientPubkey;
}

function getRequestEventId(extra: ToolExtra): string | null {
  const requestEventId = extra._meta?.requestEventId;
  return typeof requestEventId === "string" && requestEventId.length > 0
    ? requestEventId
    : null;
}

function readStablePubkeyFromCredential(keyPackage: KeyPackage): string {
  const credential = keyPackage.leafNode.credential;
  if (
    !isDefaultCredential(credential) ||
    credential.credentialType !== 1 ||
    !("identity" in credential)
  ) {
    throw new Error("Only BasicCredential key packages are supported");
  }

  return credentialIdentityDecoder.decode(credential.identity);
}

async function verifyPublishedKeyPackageBinding(params: {
  clientPubkey: string;
  publicationEvent: NostrEvent;
  keyPackage: KeyPackage;
}): Promise<string> {
  if (!verifyEvent(params.publicationEvent)) {
    throw new Error("Invalid publication event signature");
  }

  if (params.publicationEvent.pubkey !== params.clientPubkey) {
    throw new Error(
      "Publication event signer does not match injected client pubkey",
    );
  }

  const stablePubkey = readStablePubkeyFromCredential(params.keyPackage);
  if (stablePubkey !== params.publicationEvent.pubkey) {
    throw new Error(
      "Key package credential identity does not match publication event signer",
    );
  }

  return stablePubkey;
}

function mapAvailableKeyPackage(record: {
  stablePubkey: string;
  keyPackageRef: string;
  isLastResort: boolean;
  publishedAt: number;
}) {
  return {
    pk: record.stablePubkey,
    kp_ref: record.keyPackageRef,
    last_resort: record.isLastResort,
    at: record.publishedAt,
  };
}

function getOpenStreamWriter(extra: ToolExtra): OpenStreamWriter {
  const stream = (extra._meta as { stream?: OpenStreamWriter } | undefined)
    ?.stream;

  if (!stream) {
    throw new Error("Expected open stream writer in _meta.stream");
  }

  return stream;
}

/** Maps a GroupMessageRecord to the wire format, intentionally omitting
 *  epoch (clients extract it from the decrypted MLS plaintext). */
function mapGroupMessage(
  record: Pick<
    GroupMessageRecord,
    "cursor" | "groupId" | "opaqueMessage" | "createdAt"
  >,
): z.infer<typeof groupMessageSchema> {
  return {
    cursor: record.cursor,
    gid: record.groupId,
    msg_64: encodeBase64(record.opaqueMessage),
    at: record.createdAt,
  };
}

async function writeGroupMessage(
  stream: OpenStreamWriter,
  record: Parameters<typeof mapGroupMessage>[0],
): Promise<void> {
  await stream.write(JSON.stringify(mapGroupMessage(record)));
}

export class CoordinatorAdapter {
  private readonly coordinator: Coordinator;
  private readonly resolveRequestEvent?: ResolveRequestEvent;
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly abuseProtection: AbuseProtectionOptions;
  private readonly logger: ServerLogger;
  private telemetry?: CoordinatorTelemetrySink;
  private readonly metrics = new Map<string, number>();

  constructor(
    coordinator: Coordinator,
    resolveRequestEvent?: ResolveRequestEvent,
    abuseProtection?: AbuseProtectionOptions,
    logger: ServerLogger = consoleServerLogger,
    telemetry?: CoordinatorTelemetrySink,
  ) {
    this.coordinator = coordinator;
    this.resolveRequestEvent = resolveRequestEvent;
    this.abuseProtection = abuseProtection ?? {
      rateLimit: {
        enabled: true,
        refillPerMinute: 500,
        burst: 160,
        idleTtlMs: 3_600_000,
      },
      keyPackageQuota: {
        maxPerIdentity: 50,
        maxLastResortPerIdentity: 1,
      },
      logRejections: true,
    };
    this.rateLimiter = new TokenBucketRateLimiter(
      this.abuseProtection.rateLimit,
    );
    this.logger = logger;
    this.telemetry = telemetry;
  }

  close(): void {
    this.coordinator.close();
  }

  setTelemetrySink(telemetry?: CoordinatorTelemetrySink): void {
    this.telemetry = telemetry;
    this.recordSubscriptionCount();
  }

  private recordOperation(methodName: string): void {
    const count = (this.metrics.get(methodName) ?? 0) + 1;
    this.metrics.set(methodName, count);
    this.logger.info(
      { type: "operation", method: methodName, count },
      "cordn operation",
    );
    this.telemetry?.recordOperation?.(methodName);
  }

  private recordSubscriptionCount(): void {
    const metrics = this.coordinator.getActiveSubscriptionMetrics();
    this.telemetry?.setSubscriptionMetrics?.(metrics);
    this.telemetry?.setActiveSubscriptions?.(metrics.activeStreams);
  }

  private getSubscriptionLogMetrics(): ActiveSubscriptionMetrics {
    return this.coordinator.getActiveSubscriptionMetrics();
  }

  assertWithinRateLimit(extra: ToolExtra, methodName: string): void {
    const clientPubkey = requireClientPubkey(extra);
    if (this.rateLimiter.check(clientPubkey)) {
      return;
    }

    if (this.abuseProtection.logRejections) {
      this.logger.warn(
        {
          type: "rate_limit",
          method: methodName,
          clientPubkey: `${clientPubkey.slice(0, 12)}…`,
        },
        "cordn abuse protection rejection",
      );
    }

    throw new Error("Rate limit exceeded");
  }

  private enforceKeyPackageQuota(
    stablePubkey: string,
    incomingKeyPackage: KeyPackage,
  ): void {
    const records = this.coordinator.listKeyPackagesForIdentity(stablePubkey);
    const incomingIsLastResort = isLastResortKeyPackage(incomingKeyPackage);
    const maxPerIdentity = this.abuseProtection.keyPackageQuota.maxPerIdentity;
    const maxLastResortPerIdentity =
      this.abuseProtection.keyPackageQuota.maxLastResortPerIdentity;

    if (incomingIsLastResort) {
      const existingLastResortRecords = records.filter(
        (record) => record.isLastResort,
      );
      const retainedLastResortCount =
        maxLastResortPerIdentity > 0
          ? Math.min(
              existingLastResortRecords.length,
              maxLastResortPerIdentity - 1,
            )
          : existingLastResortRecords.length;
      const nonLastResortCount =
        records.length - existingLastResortRecords.length;

      // Decide before removing anything: a rejected publication must leave the
      // identity's current last-resort key package available.
      if (
        maxPerIdentity > 0 &&
        nonLastResortCount + retainedLastResortCount + 1 > maxPerIdentity
      ) {
        this.logQuotaRejection(
          stablePubkey,
          "max key packages per identity exceeded",
        );
        throw new Error("Key package quota exceeded");
      }

      const recordsToRemove = existingLastResortRecords.slice(
        0,
        existingLastResortRecords.length - retainedLastResortCount,
      );
      for (const record of recordsToRemove) {
        this.coordinator.removeKeyPackage(record.keyPackageRef);
      }

      return;
    }

    if (maxPerIdentity > 0 && records.length >= maxPerIdentity) {
      this.logQuotaRejection(
        stablePubkey,
        "max key packages per identity exceeded",
      );
      throw new Error("Key package quota exceeded");
    }
  }

  private logQuotaRejection(clientPubkey: string, reason: string): void {
    if (!this.abuseProtection.logRejections) {
      return;
    }

    this.logger.warn(
      {
        type: "key_package_quota",
        reason,
        clientPubkey: `${clientPubkey.slice(0, 12)}…`,
      },
      "cordn abuse protection rejection",
    );
  }

  async publishKeyPackage(
    input: z.infer<typeof publishKeyPackageInputSchema>,
    extra: ToolExtra,
  ): Promise<{ content: never[]; structuredContent: PublishKeyPackageOutput }> {
    const clientPubkey = requireClientPubkey(extra);
    const keyPackage = decodeKeyPackageBase64(input.kp_64);
    const requestEventId = getRequestEventId(extra);
    const publicationEvent = requestEventId
      ? this.resolveRequestEvent?.(requestEventId)
      : undefined;
    if (!publicationEvent) {
      throw new Error("Missing publication event");
    }

    const stablePubkey = await verifyPublishedKeyPackageBinding({
      clientPubkey,
      publicationEvent,
      keyPackage,
    });

    this.enforceKeyPackageQuota(stablePubkey, keyPackage);

    const record = this.coordinator.publishKeyPackage({
      stablePubkey,
      keyPackageRef: input.kp_ref,
      keyPackage,
      publicationEvent,
    });

    this.recordOperation("publishKeyPackage");

    return {
      content: [],
      structuredContent: {
        kp_ref: record.keyPackageRef,
        last_resort: record.isLastResort,
        at: record.publishedAt,
      },
    };
  }

  consumeKeyPackage(input: z.infer<typeof consumeKeyPackageInputSchema>): {
    content: never[];
    structuredContent: {
      keyPackage: {
        pk: string;
        kp_ref: string;
        last_resort: boolean;
        at: number;
        event: NostrEvent;
      } | null;
    };
  } {
    // no extra available here; enforced in registration wrapper
    const record = this.coordinator.consumeKeyPackage(input.id);

    this.recordOperation("consumeKeyPackage");

    return {
      content: [],
      structuredContent: {
        keyPackage: record
          ? {
              pk: record.stablePubkey,
              kp_ref: record.keyPackageRef,
              last_resort: record.isLastResort,
              at: record.publishedAt,
              event: record.publicationEvent,
            }
          : null,
      },
    };
  }

  listAvailableKeyPackages(
    _input: z.infer<typeof listAvailableKeyPackagesInputSchema>,
  ): { content: never[]; structuredContent: ListAvailableKeyPackagesOutput } {
    // no extra available here; enforced in registration wrapper
    void _input;
    const records = this.coordinator.listAllKeyPackages();

    return {
      content: [],
      structuredContent: {
        keyPackages: records.map(mapAvailableKeyPackage),
      },
    };
  }

  removeKeyPackages(
    input: z.infer<typeof removeKeyPackagesInputSchema>,
    extra: ToolExtra,
  ): { content: never[]; structuredContent: RemoveKeyPackagesOutput } {
    const clientPubkey = requireClientPubkey(extra);
    const records = input.kp_refs.map((kp_ref) => {
      const record = this.coordinator.getKeyPackage(kp_ref);
      if (!record) {
        throw new Error(`Unknown key package ref: ${kp_ref}`);
      }

      if (record.stablePubkey !== clientPubkey) {
        throw new Error(`Unauthorized key package ref: ${kp_ref}`);
      }

      return record;
    });

    this.recordOperation("removeKeyPackages");

    return {
      content: [],
      structuredContent: {
        kp_refs: records.map((record) => {
          return (
            this.coordinator.removeKeyPackage(record.keyPackageRef)
              ?.keyPackageRef ?? record.keyPackageRef
          );
        }),
      },
    };
  }

  fetchPendingWelcomes(
    input: z.infer<typeof fetchPendingWelcomesInputSchema>,
    extra: ToolExtra,
  ): { content: never[]; structuredContent: FetchPendingWelcomesOutput } {
    const clientPubkey = requireClientPubkey(extra);
    const records = this.coordinator.fetchPendingWelcomes(
      clientPubkey,
      input.consumed?.map((entry) => ({
        keyPackageReference: entry.kp_ref,
        createdAt: entry.at,
      })),
    );
    return {
      content: [],
      structuredContent: {
        welcomes: records.map((record) => ({
          kp_ref: record.keyPackageReference,
          welcome_64: encodeWelcomeBase64(record.welcome),
          at: record.createdAt,
          ...(record.joinAfterCursor ? { after: record.joinAfterCursor } : {}),
        })),
      },
    };
  }

  storeWelcome(input: z.infer<typeof storeWelcomeInputSchema>): { content: never[]; structuredContent: StoreWelcomeOutput } {
    // no extra available here; enforced in registration wrapper
    const record = this.coordinator.storeWelcome({
      targetStablePubkey: input.target_pk,
      keyPackageReference: input.kp_ref,
      welcome: decodeWelcomeBase64(input.welcome_64),
      joinAfterCursor: input.after,
    });

    this.recordOperation("storeWelcome");

    return {
      content: [],
      structuredContent: {
        at: record.createdAt,
      },
    };
  }

  async storeJoinRequest(
    input: z.infer<typeof storeJoinRequestInputSchema>,
    extra: ToolExtra,
  ): Promise<{ content: never[]; structuredContent: StoreJoinRequestOutput }> {
    const clientPubkey = requireClientPubkey(extra);

    const keyPackageRecord = this.coordinator.getKeyPackage(input.kp_ref);
    if (!keyPackageRecord) {
      throw new Error("Unknown key package ref");
    }

    if (keyPackageRecord.stablePubkey !== clientPubkey) {
      throw new Error("Unauthorized key package ref");
    }

    const record = this.coordinator.storeJoinRequest({
      groupId: input.gid,
      requesterStablePubkey: clientPubkey,
      keyPackageRef: input.kp_ref,
      inviteToken: input.invite_token,
    });
    await this.coordinator.waitForJoinRequestNotifications(record);
    this.recordOperation("storeJoinRequest");

    return {
      content: [],
      structuredContent: {
        at: record.createdAt,
      },
    };
  }

  fetchPendingJoinRequests(
    input: z.infer<typeof fetchPendingJoinRequestsInputSchema>,
  ): {
    content: never[];
    structuredContent: {
      requests: {
        pk: string;
        kp_ref: string;
        at: number;
        invite_token: string | undefined;
      }[];
    };
  } {
    // no extra available here; enforced in registration wrapper
    const records = this.coordinator.fetchPendingJoinRequests(input.gid);

    this.recordOperation("fetchPendingJoinRequests");

    return {
      content: [],
      structuredContent: {
        requests: records.map((record) => ({
          pk: record.requesterStablePubkey,
          kp_ref: record.keyPackageRef,
          at: record.createdAt,
          invite_token: record.inviteToken,
        })),
      },
    };
  }

  fetchManyPendingJoinRequests(
    input: z.infer<typeof fetchManyPendingJoinRequestsInputSchema>,
  ): {
    content: never[];
    structuredContent: {
      requests: {
        gid: string;
        pk: string;
        kp_ref: string;
        at: number;
        invite_token: string | undefined;
      }[];
    };
  } {
    // no extra available here; enforced in registration wrapper
    const records = this.coordinator.fetchManyPendingJoinRequests({
      groups: input.groups.map((group) => ({ groupId: group.gid })),
      consumed: input.consumed?.map((entry) => ({
        groupId: entry.gid,
        requesterStablePubkey: entry.pk,
        createdAt: entry.at,
      })),
    });

    this.recordOperation("fetchManyPendingJoinRequests");

    return {
      content: [],
      structuredContent: {
        requests: records.map((record) => ({
          gid: record.groupId,
          pk: record.requesterStablePubkey,
          kp_ref: record.keyPackageRef,
          at: record.createdAt,
          invite_token: record.inviteToken,
        })),
      },
    };
  }

  postGroupMessage(
    input: z.infer<typeof postGroupMessageInputSchema>,
    extra: ToolExtra,
  ): { content: never[]; structuredContent: PostGroupMessageOutput } {
    const clientPubkey = requireClientPubkey(extra);

    try {
      const record = this.coordinator.postGroupMessage({
        ephemeralSenderPubkey: clientPubkey,
        opaqueMessage: decodeOpaqueMessageBase64(input.msg_64),
        groupId: input.gid,
      });

      this.recordOperation("postGroupMessage");

      return {
        content: [],
        structuredContent: {
          cursor: record.cursor,
          gid: record.groupId,
          at: record.createdAt,
        },
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Rejected stale handshake")
      ) {
        this.logger.warn(
          {
            type: "stale_handshake",
            clientPubkey: `${clientPubkey.slice(0, 12)}…`,
            error: error.message,
          },
          "stale handshake rejected",
        );
      }

      throw error;
    }
  }

  fetchGroupMessages(input: z.infer<typeof fetchGroupMessagesInputSchema>): { content: never[]; structuredContent: FetchGroupMessagesOutput } {
    // no extra available here; enforced in registration wrapper
    const records = this.coordinator.fetchGroupMessages({
      groupId: input.gid,
      afterCursor: input.after,
      sinceEpoch: parseSinceEpoch(input.since_epoch),
    });

    this.recordOperation("fetchGroupMessages");

    return {
      content: [],
      structuredContent: {
        messages: records.map(mapGroupMessage),
      },
    };
  }

  fetchManyGroupMessages(
    input: z.infer<typeof fetchManyGroupMessagesInputSchema>,
  ): { content: never[]; structuredContent: FetchManyGroupMessagesOutput } {
    const records = this.coordinator.fetchManyGroupMessages({
      groups: input.groups.map((group) => ({
        groupId: group.gid,
        afterCursor: group.after,
        sinceEpoch: parseSinceEpoch(group.since_epoch),
      })),
    });

    this.recordOperation("fetchManyGroupMessages");

    return {
      content: [],
      structuredContent: {
        messages: records.map(mapGroupMessage),
      },
    };
  }

  async subscribeGroupMessages(
    input: z.infer<typeof subscribeGroupMessagesInputSchema>,
    extra: ToolExtra,
  ): Promise<{
    content: never[];
    structuredContent: { subscribed: boolean };
  }> {
    const stream = getOpenStreamWriter(extra);
    const clientPubkey = extra._meta?.clientPubkey;
    const groupId = input.gid;

    const sinceEpoch = parseSinceEpoch(input.since_epoch);

    const subscription = this.coordinator.subscribeGroupMessages({
      groupId,
      afterCursor: input.after,
      sinceEpoch,
    });
    let backlog: GroupMessageRecord[];
    try {
      backlog = this.coordinator.fetchGroupMessages({
        groupId,
        afterCursor: input.after,
        sinceEpoch,
      });
    } catch (error) {
      subscription.unsubscribe();
      throw error;
    }
    let lastEmittedCursor = input.after ?? 0;
    const originalAbort = stream.abort.bind(stream);
    const clientPubkeyLabel =
      typeof clientPubkey === "string" && clientPubkey.length > 0
        ? `${clientPubkey.slice(0, 12)}…`
        : undefined;
    let cleanedUp = false;

    this.logger.info(
      {
        type: "subscription_start",
        groupId,
        ...this.getSubscriptionLogMetrics(),
        clientPubkey: clientPubkeyLabel,
      },
      "group message subscription started",
    );
    this.recordSubscriptionCount();

    const cleanupSubscription = (reason: string): void => {
      if (cleanedUp) {
        return;
      }

      cleanedUp = true;
      subscription.unsubscribe();
      this.recordSubscriptionCount();

      this.logger.info(
        {
          type: "subscription_end",
          groupId,
          reason,
          ...this.getSubscriptionLogMetrics(),
          clientPubkey: clientPubkeyLabel,
        },
        "group message subscription ended",
      );
    };

    stream.abort = async (reason?: string): Promise<void> => {
      cleanupSubscription(reason ?? "abort");
      await originalAbort(reason);
    };

    // Transport teardown disposes the writer without calling abort(), and a
    // client can cancel before this handler runs. Either would otherwise leave
    // the loop below waiting on a queue nothing will ever close.
    const releaseInactiveStream = (): void =>
      cleanupSubscription("stream inactive");
    stream.signal?.addEventListener("abort", releaseInactiveStream, {
      once: true,
    });

    try {
      await stream.start();
      if (!stream.isActive) {
        releaseInactiveStream();
      }

      for (const record of backlog) {
        const message = mapGroupMessage(record);
        await stream.write(JSON.stringify(message));
        lastEmittedCursor = record.cursor;
      }

      for await (const record of subscription.messages) {
        if (record.cursor <= lastEmittedCursor) {
          continue;
        }

        const message = mapGroupMessage(record);
        await stream.write(JSON.stringify(message));
        lastEmittedCursor = record.cursor;
      }

      stream.signal?.removeEventListener("abort", releaseInactiveStream);
      if (stream.isActive) {
        await stream.close();
      }
      cleanupSubscription("complete");
    } catch (error) {
      try {
        await stream.abort(
          error instanceof Error ? error.message : "Stream aborted",
        );
      } catch {
        // Ignore secondary abort cleanup failures.
      }
      throw error;
    } finally {
      stream.abort = originalAbort;
      cleanupSubscription("finally");
    }

    this.recordOperation("subscribeGroupMessages");

    return {
      content: [],
      structuredContent: {
        subscribed: true,
      },
    };
  }

  async subscribeManyGroupMessages(
    input: z.infer<typeof subscribeManyGroupMessagesInputSchema>,
    extra: ToolExtra,
  ): Promise<{
    content: never[];
    structuredContent: { subscribed: boolean; groups: string[] };
  }> {
    const stream = getOpenStreamWriter(extra);
    const clientPubkey = extra._meta?.clientPubkey;
    const clientPubkeyLabel =
      typeof clientPubkey === "string" && clientPubkey.length > 0
        ? `${clientPubkey.slice(0, 12)}…`
        : undefined;
    const subscription = this.coordinator.subscribeManyGroupMessages({
      groups: input.groups.map((group) => ({
        groupId: group.gid,
        afterCursor: group.after,
        sinceEpoch: parseSinceEpoch(group.since_epoch),
      })),
    });
    const originalAbort = stream.abort.bind(stream);
    let cleanedUp = false;
    let endLogged = false;

    this.logger.info(
      {
        type: "subscription_start",
        groupIds: input.groups.map((group) => group.gid),
        groupCount: input.groups.length,
        ...this.getSubscriptionLogMetrics(),
        clientPubkey: clientPubkeyLabel,
      },
      "multi-group message subscription started",
    );
    this.recordSubscriptionCount();

    const cleanupSubscriptions = (reason: string): void => {
      if (!cleanedUp) {
        cleanedUp = true;
        subscription.unsubscribe();
        this.recordSubscriptionCount();
      }

      if (endLogged) {
        return;
      }

      endLogged = true;
      this.logger.info(
        {
          type: "subscription_end",
          groupIds: input.groups.map((group) => group.gid),
          groupCount: input.groups.length,
          reason,
          ...this.getSubscriptionLogMetrics(),
          clientPubkey: clientPubkeyLabel,
        },
        "multi-group message subscription ended",
      );
    };

    stream.abort = async (reason?: string): Promise<void> => {
      cleanupSubscriptions(reason ?? "abort");
      await originalAbort(reason);
    };

    // See subscribeGroupMessages: not every way a writer ends calls abort().
    const releaseInactiveStream = (): void =>
      cleanupSubscriptions("stream inactive");
    stream.signal?.addEventListener("abort", releaseInactiveStream, {
      once: true,
    });

    try {
      await stream.start();
      if (!stream.isActive) {
        releaseInactiveStream();
      }

      for await (const record of subscription.messages) {
        if (!stream.isActive) {
          break;
        }

        await writeGroupMessage(stream, record);
      }

      stream.signal?.removeEventListener("abort", releaseInactiveStream);
      if (stream.isActive) {
        await stream.close();
      }
      cleanupSubscriptions("complete");
    } catch (error) {
      try {
        await stream.abort(
          error instanceof Error ? error.message : "Stream aborted",
        );
      } catch {
        // Ignore secondary abort cleanup failures.
      }
      throw error;
    } finally {
      stream.abort = originalAbort;
      cleanupSubscriptions("finally");
    }

    this.recordOperation("subscribeManyGroupMessages");

    return {
      content: [],
      structuredContent: {
        subscribed: true,
        groups: input.groups.map((group) => group.gid),
      },
    };
  }
}

export function registerCoordinatorMethods(
  server: McpServer,
  adapter: CoordinatorAdapter,
): void {
  const withRateLimit = <TInput, TOutput>(
    methodName: string,
    handler: (input: TInput, extra: ToolExtra) => TOutput | Promise<TOutput>,
  ) => {
    return (input: TInput, extra: ToolExtra) => {
      (
        adapter as CoordinatorAdapter & {
          assertWithinRateLimit(extra: ToolExtra, methodName: string): void;
        }
      ).assertWithinRateLimit(extra, methodName);
      return handler(input, extra);
    };
  };

  // TODO: Store the entire key package publish event
  server.registerTool(
    COORDINATOR_METHODS.publishKeyPackage,
    {
      description:
        "Publish an MLS key package for the injected caller identity.",
      inputSchema: publishKeyPackageInputSchema,
      outputSchema: publishKeyPackageOutputSchema,
    },
    withRateLimit(COORDINATOR_METHODS.publishKeyPackage, (input, extra) =>
      adapter.publishKeyPackage(input, extra),
    ),
  );

  server.registerTool(
    COORDINATOR_METHODS.listAvailableKeyPackages,
    {
      description:
        "List currently available published MLS key packages discoverable on the coordinator.",
      inputSchema: listAvailableKeyPackagesInputSchema,
      outputSchema: listAvailableKeyPackagesOutputSchema,
    },
    withRateLimit(
      COORDINATOR_METHODS.listAvailableKeyPackages,
      (input, extra) => {
        void extra;
        return adapter.listAvailableKeyPackages(input);
      },
    ),
  );

  server.registerTool(
    COORDINATOR_METHODS.removeKeyPackages,
    {
      description:
        "Remove published MLS key packages owned by the injected caller identity.",
      inputSchema: removeKeyPackagesInputSchema,
      outputSchema: removeKeyPackagesOutputSchema,
    },
    withRateLimit(COORDINATOR_METHODS.removeKeyPackages, (input, extra) =>
      adapter.removeKeyPackages(input, extra),
    ),
  );
  // TODO: Return the entire key package publish event
  server.registerTool(
    COORDINATOR_METHODS.consumeKeyPackage,
    {
      description:
        "Consume the next published MLS key package by stable identity or exact key package ref.",
      inputSchema: consumeKeyPackageInputSchema,
      outputSchema: consumeKeyPackageOutputSchema,
    },
    withRateLimit(COORDINATOR_METHODS.consumeKeyPackage, (input, extra) => {
      void extra;
      return adapter.consumeKeyPackage(input);
    }),
  );

  server.registerTool(
    COORDINATOR_METHODS.fetchPendingWelcomes,
    {
      description:
        "Fetch pending welcomes queued for the injected caller identity.",
      inputSchema: fetchPendingWelcomesInputSchema,
      outputSchema: fetchPendingWelcomesOutputSchema,
    },
    withRateLimit(COORDINATOR_METHODS.fetchPendingWelcomes, (input, extra) =>
      adapter.fetchPendingWelcomes(input, extra),
    ),
  );

  server.registerTool(
    COORDINATOR_METHODS.storeWelcome,
    {
      description: "Store an MLS welcome for a target stable identity.",
      inputSchema: storeWelcomeInputSchema,
      outputSchema: storeWelcomeOutputSchema,
    },
    withRateLimit(COORDINATOR_METHODS.storeWelcome, (input, extra) => {
      void extra;
      return adapter.storeWelcome(input);
    }),
  );

  server.registerTool(
    COORDINATOR_METHODS.storeJoinRequest,
    {
      description:
        "Store a join request for a group from the injected caller identity.",
      inputSchema: storeJoinRequestInputSchema,
      outputSchema: storeJoinRequestOutputSchema,
    },
    withRateLimit(COORDINATOR_METHODS.storeJoinRequest, (input, extra) =>
      adapter.storeJoinRequest(input, extra),
    ),
  );

  server.registerTool(
    COORDINATOR_METHODS.fetchPendingJoinRequests,
    {
      description: "Fetch pending join requests for a group.",
      inputSchema: fetchPendingJoinRequestsInputSchema,
      outputSchema: fetchPendingJoinRequestsOutputSchema,
    },
    withRateLimit(
      COORDINATOR_METHODS.fetchPendingJoinRequests,
      (input, extra) => {
        void extra;
        return adapter.fetchPendingJoinRequests(input);
      },
    ),
  );

  server.registerTool(
    COORDINATOR_METHODS.fetchManyPendingJoinRequests,
    {
      description:
        "Fetch pending join requests for multiple groups in a single call.",
      inputSchema: fetchManyPendingJoinRequestsInputSchema,
      outputSchema: fetchManyPendingJoinRequestsOutputSchema,
    },
    withRateLimit(
      COORDINATOR_METHODS.fetchManyPendingJoinRequests,
      (input, extra) => {
        void extra;
        return adapter.fetchManyPendingJoinRequests(input);
      },
    ),
  );

  server.registerTool(
    COORDINATOR_METHODS.postGroupMessage,
    {
      description:
        "Queue an MLS opaque group message for the injected caller identity.",
      inputSchema: postGroupMessageInputSchema,
      outputSchema: postGroupMessageOutputSchema,
    },
    withRateLimit(COORDINATOR_METHODS.postGroupMessage, (input, extra) =>
      adapter.postGroupMessage(input, extra),
    ),
  );

  server.registerTool(
    COORDINATOR_METHODS.fetchGroupMessages,
    {
      description:
        "Fetch queued MLS opaque group messages by group and optional cursor.",
      inputSchema: fetchGroupMessagesInputSchema,
      outputSchema: fetchGroupMessagesOutputSchema,
    },
    withRateLimit(COORDINATOR_METHODS.fetchGroupMessages, (input, extra) => {
      void extra;
      return adapter.fetchGroupMessages(input);
    }),
  );

  server.registerTool(
    COORDINATOR_METHODS.fetchManyGroupMessages,
    {
      description:
        "Fetch queued MLS opaque group messages for multiple groups with independent optional cursors.",
      inputSchema: fetchManyGroupMessagesInputSchema,
      outputSchema: fetchManyGroupMessagesOutputSchema,
    },
    withRateLimit(
      COORDINATOR_METHODS.fetchManyGroupMessages,
      (input, extra) => {
        void extra;
        return adapter.fetchManyGroupMessages(input);
      },
    ),
  );

  server.registerTool(
    COORDINATOR_METHODS.subscribeGroupMessages,
    {
      description:
        "Replay and stream MLS opaque group messages by group and optional cursor.",
      inputSchema: subscribeGroupMessagesInputSchema,
      outputSchema: subscribeGroupMessagesOutputSchema,
    },
    withRateLimit(COORDINATOR_METHODS.subscribeGroupMessages, (input, extra) =>
      adapter.subscribeGroupMessages(input, extra),
    ),
  );

  server.registerTool(
    COORDINATOR_METHODS.subscribeManyGroupMessages,
    {
      description:
        "Replay and stream MLS opaque group messages for multiple groups with independent optional cursors.",
      inputSchema: subscribeManyGroupMessagesInputSchema,
      outputSchema: subscribeManyGroupMessagesOutputSchema,
    },
    withRateLimit(
      COORDINATOR_METHODS.subscribeManyGroupMessages,
      (input, extra) => adapter.subscribeManyGroupMessages(input, extra),
    ),
  );
}
