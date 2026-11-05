import { Client } from "@contextvm/mcp-sdk/client";
import { NostrClientTransport } from "@contextvm/sdk/transport";
import { GiftWrapMode, type NostrSigner } from "@contextvm/sdk/core";
import { PrivateKeySigner } from "@contextvm/sdk";
import { createRequiredRelayPool, withRequiredLocalRelay } from "../lib/relay-pool";
import { CORDN_DEFAULT_RELAY_URLS } from "./invite";

export const CHAT_COORDINATOR_CONNECT_TIMEOUT_MS = 12_000;
export const CHAT_COORDINATOR_REQUEST_TIMEOUT_MS = 12_000;
const IDEMPOTENT_WRITE_RETRY_DELAYS_MS = [500, 1_000] as const;

type CoordinatorTransportKind = "stable" | "ephemeral";

export interface CoordinatorTarget {
  coordinatorPubkey: string;
  relayUrls: string[];
}

export interface RemoteGroupMessage {
  cursor: number;
  gid: string;
  msg_64: string;
  at: number;
}

export interface RemoteWelcome {
  kp_ref: string;
  welcome_64: string;
  at: number;
  after?: number;
}

export interface RemoteJoinRequest {
  gid?: string;
  pk: string;
  kp_ref: string;
  at: number;
  invite_token?: string;
}

/** Operations used by a room session, regardless of whether the coordinator
 * is reached over Nostr or through the same-tab host control plane. */
export interface ChatCoordinatorOperations {
  close(): Promise<void>;
  /** Same-tab host optimization. Remote clients continue to use polling. */
  subscribeJoinRequests?(groupId: string, listener: () => void | Promise<void>): () => void;
  publishKeyPackage(reference: string, keyPackageBase64: string): Promise<void>;
  /** Reports the references this identity currently has admission material for. */
  listOwnKeyPackageRefs(): Promise<string[]>;
  storeJoinRequest(groupId: string, keyPackageReference: string, inviteToken?: string): Promise<void>;
  fetchWelcomes(consumed?: Array<{ kp_ref: string; at: number }>): Promise<RemoteWelcome[]>;
  fetchJoinRequests(groupId: string, consumed?: Array<{ pk: string; at: number }>): Promise<RemoteJoinRequest[]>;
  consumeKeyPackage(identifier: string): Promise<{ pk: string; kp_ref: string; event: unknown } | null>;
  postGroupMessage(groupId: string, messageBase64: string): Promise<{ cursor: number; gid: string; at: number }>;
  storeWelcome(
    targetPubkey: string,
    keyPackageReference: string,
    welcomeBase64: string,
    after: number,
  ): Promise<void>;
  fetchMessages(groupId: string, after?: number): Promise<RemoteGroupMessage[]>;
}

export type ChatCoordinatorClientFactory = (
  target: CoordinatorTarget,
  signer: NostrSigner,
) => ChatCoordinatorOperations;

/** Minimal ContextVM client for the public coordinator contract. */
export class ChatCoordinatorClient implements ChatCoordinatorOperations {
  private readonly stableClient = new Client({ name: "CvmMlsDeliveryServiceClient", version: "1.0.0" });
  private readonly ephemeralClient = new Client({ name: "CvmMlsDeliveryServiceClientEphemeral", version: "1.0.0" });
  private readonly stableTransport: NostrClientTransport;
  private readonly ephemeralTransport: NostrClientTransport;
  private stableConnected: Promise<void> | null = null;
  private ephemeralConnected: Promise<void> | null = null;
  private readonly lifecycle = new AbortController();

  constructor(private readonly target: CoordinatorTarget, signer: NostrSigner) {
    const operationalRelays = target.relayUrls.length > 0
      ? target.relayUrls
      : CORDN_DEFAULT_RELAY_URLS;
    const websocketPool = withRequiredLocalRelay(operationalRelays);
    const transportBase = (operation: string) => ({
      serverPubkey: target.coordinatorPubkey,
      relayHandler: createRequiredRelayPool(websocketPool, { operation }),
      fallbackOperationalRelayUrls: [...CORDN_DEFAULT_RELAY_URLS],
      logLevel: "error" as const,
      isStateless: true,
      giftWrapMode: GiftWrapMode.EPHEMERAL,
      openStream: { enabled: true },
      oversizedTransfer: { enabled: true },
    });
    this.stableTransport = new NostrClientTransport({
      ...transportBase("chat-coordinator-stable-request"),
      signer,
    });
    this.ephemeralTransport = new NostrClientTransport({
      ...transportBase("chat-coordinator-ephemeral-request"),
      signer: new PrivateKeySigner(),
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled([
      this.stableClient.close(),
      this.ephemeralClient.close(),
    ]);
    await Promise.allSettled([
      this.stableTransport.close(),
      this.ephemeralTransport.close(),
    ]);
    this.lifecycle.abort();
    this.stableConnected = null;
    this.ephemeralConnected = null;
  }

  async publishKeyPackage(reference: string, keyPackageBase64: string): Promise<void> {
    await this.callIdempotentWrite("kp_publish", { kp_ref: reference, kp_64: keyPackageBase64 });
  }

  async listOwnKeyPackageRefs(): Promise<string[]> {
    const { keyPackages } = await this.call<{ keyPackages: Array<{ kp_ref: string }> }>(
      "stable",
      "kp_list",
      {},
    );
    return keyPackages.map(({ kp_ref }) => kp_ref);
  }

  async storeJoinRequest(groupId: string, keyPackageReference: string, inviteToken?: string): Promise<void> {
    await this.callIdempotentWrite("join_request_store", {
      gid: groupId,
      kp_ref: keyPackageReference,
      ...(inviteToken ? { invite_token: inviteToken } : {}),
    });
  }

  async fetchWelcomes(consumed?: Array<{ kp_ref: string; at: number }>): Promise<RemoteWelcome[]> {
    return (await this.call<{ welcomes: RemoteWelcome[] }>("stable", "welcome_take", {
      ...(consumed?.length ? { consumed } : {}),
    })).welcomes;
  }

  async fetchJoinRequests(
    groupId: string,
    consumed?: Array<{ pk: string; at: number }>,
  ): Promise<RemoteJoinRequest[]> {
    const { requests } = await this.call<{ requests: RemoteJoinRequest[] }>(
      "ephemeral",
      "join_request_take_many",
      {
        groups: [{ gid: groupId }],
        ...(consumed?.length
          ? { consumed: consumed.map((request) => ({ gid: groupId, ...request })) }
          : {}),
      },
    );
    return requests.filter((request) => request.gid === groupId);
  }

  async consumeKeyPackage(identifier: string): Promise<{ pk: string; kp_ref: string; event: unknown } | null> {
    return (await this.call<{ keyPackage: { pk: string; kp_ref: string; event: unknown } | null }>("ephemeral", "kp_take", { id: identifier })).keyPackage;
  }

  async postGroupMessage(groupId: string, messageBase64: string): Promise<{ cursor: number; gid: string; at: number }> {
    return this.call("ephemeral", "msg_post", { gid: groupId, msg_64: messageBase64 });
  }

  async storeWelcome(targetPubkey: string, keyPackageReference: string, welcomeBase64: string, after: number): Promise<void> {
    await this.call("ephemeral", "welcome_store", { target_pk: targetPubkey, kp_ref: keyPackageReference, welcome_64: welcomeBase64, after });
  }

  async fetchMessages(groupId: string, after?: number): Promise<RemoteGroupMessage[]> {
    return (await this.call<{ messages: RemoteGroupMessage[] }>("ephemeral", "msg_fetch_many", {
      groups: [{
        gid: groupId,
        ...(after ? { after } : {}),
      }],
    })).messages;
  }

  private async ensureConnected(kind: CoordinatorTransportKind): Promise<void> {
    const client = kind === "stable" ? this.stableClient : this.ephemeralClient;
    const transport = kind === "stable" ? this.stableTransport : this.ephemeralTransport;
    let connected = kind === "stable" ? this.stableConnected : this.ephemeralConnected;
    if (!connected) {
      connected = client.connect(transport, {
        timeout: CHAT_COORDINATOR_CONNECT_TIMEOUT_MS,
      });
      if (kind === "stable") this.stableConnected = connected;
      else this.ephemeralConnected = connected;
    }
    try {
      await connected;
    } catch (error) {
      if (kind === "stable") this.stableConnected = null;
      else this.ephemeralConnected = null;
      throw error;
    }
  }

  private async call<T>(kind: CoordinatorTransportKind, name: string, args: Record<string, unknown>): Promise<T> {
    await this.ensureConnected(kind);
    const client = kind === "stable" ? this.stableClient : this.ephemeralClient;
    const response = await client.callTool(
      { name, arguments: args },
      undefined,
      {
        timeout: CHAT_COORDINATOR_REQUEST_TIMEOUT_MS,
        signal: this.lifecycle.signal,
        onprogress: () => undefined,
        resetTimeoutOnProgress: true,
      },
    );
    if (response.isError) {
      const detail = (response.content as Array<{ text?: string }> | undefined)
        ?.map((part) => part.text ?? "")
        .filter(Boolean)
        .join("\n");
      throw new Error(detail || `Coordinator rejected ${name}`);
    }
    return response.structuredContent as T;
  }

  /**
   * Cordn retries the identity-bound publish/request pair because these are
   * commonly the first calls made through an extension or NIP-46 signer. Both
   * operations are idempotent at the coordinator, so a lost response can be
   * retried without creating another package or another pending request.
   */
  private async callIdempotentWrite<T>(name: string, args: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.call<T>("stable", name, args);
      } catch (error) {
        const delay = IDEMPOTENT_WRITE_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
