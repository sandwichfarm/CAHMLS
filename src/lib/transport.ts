import { McpServer } from "@contextvm/mcp-sdk/server/mcp";
import type { JSONRPCMessage } from "@contextvm/mcp-sdk/types";
import type { RelayHandler } from "@contextvm/sdk/core";
import { NostrServerTransport, type OpenStreamWriter } from "@contextvm/sdk/transport";
import type { NostrEvent } from "nostr-tools";
import type { BrowserCoordinatorOptions } from "../config/config.svelte";
import { createCoordinator, type Coordinator } from "../cordn/coordinator";
import { createBrowserCoordinatorStorage } from "../cordn/coordinator/storage/indexedDbSnapshotStorage";
import { BrowserNostrSigner } from "../crypto/browser-nostr-signer";
import {
  createRequiredRelayPool,
  type RelayPublishDiagnostic,
  withRequiredLocalRelay,
} from "./relay-pool";
import {
  CoordinatorAdapter,
  type AbuseProtectionOptions,
  type ResolveRequestEvent,
  registerCoordinatorMethods,
} from "../cordn/server/coordinatorMethods";
import { COORDINATOR_METHODS } from "../cordn/contracts";

export interface RunningTransport {
  server: McpServer;
  transport: NostrServerTransport;
  coordinator: Coordinator;
  adapter: CoordinatorAdapter;
  flush?: () => Promise<void>;
  close: () => void;
}

export type TransportStartupPhase = "opening-storage" | "preparing-runtime" | "connecting-relays";

export interface TransportDiagnostics {
  onStartupPhase?: (details: { phase: TransportStartupPhase }) => void;
  onStarted?: (details: { publicKeyHex: string; relayUrls: string[] }) => void;
  onNostrEvent?: (details: { summary: string }) => void;
  onInboundMessage?: (details: { method: string; clientPubkey: string; summary: string }) => void;
  onNostrPublish?: (details: { phase: "attempt" | "accepted"; summary: string }) => void;
  onRelayPublish?: (details: RelayPublishDiagnostic) => void;
  onOutboundMessage?: (details: { type: string; summary: string; error?: string }) => void;
  onOutboundError?: (error: Error) => void;
  onClosed?: () => void;
}

type LegacyBrowserCoordinatorOptions = Omit<BrowserCoordinatorOptions, "coordinatorName"> & {
  coordinatorName?: string;
};

interface InspectableNostrServerTransport {
  processIncomingEvent: (event: NostrEvent) => Promise<void>;
  publishEventToRelayUrls: (event: NostrEvent, relayUrls: string[]) => Promise<void>;
  getInternalStateForTesting: () => {
    correlationStore?: {
      getEventRoute: (eventId: string) => { originalRequestId: string | number } | undefined;
    };
    openStreamWriters: Map<string, OpenStreamWriter>;
  };
}

function closeIfPresent(value: unknown): void {
  const candidate = value as { close?: () => void } | null;
  if (typeof candidate?.close === "function") {
    candidate.close();
  }
}

function createBrowserAbuseProtection(options: Pick<BrowserCoordinatorOptions, "maxUsers">): AbuseProtectionOptions {
  return {
    rateLimit: {
      enabled: true,
      refillPerMinute: 500,
      burst: 160,
      idleTtlMs: 3_600_000,
    },
    keyPackageQuota: {
      maxPerIdentity: options.maxUsers,
      maxLastResortPerIdentity: 1,
    },
    logRejections: false,
  };
}

export class TransportFactory {
  async create(
    privateKey: Uint8Array,
    relayUrls: string[],
    options: BrowserCoordinatorOptions,
    persistent: boolean,
    diagnostics?: TransportDiagnostics,
  ): Promise<RunningTransport>;
  async create(
    privateKey: Uint8Array,
    relayUrls: string[],
    options: LegacyBrowserCoordinatorOptions,
    persistent: boolean,
    diagnostics?: TransportDiagnostics,
  ): Promise<RunningTransport>;
  async create(
    privateKey: Uint8Array,
    relayUrls: string[],
    options: LegacyBrowserCoordinatorOptions,
    persistent: boolean,
    diagnostics?: TransportDiagnostics,
  ): Promise<RunningTransport> {
    const websocketPool = withRequiredLocalRelay(relayUrls);
    if (websocketPool.length === 0) {
      throw new Error("At least one enabled relay is required");
    }

    const signer = new BrowserNostrSigner(privateKey);
    const coordinatorPubkey = await signer.getPublicKey();
    const coordinatorName = options.coordinatorName ?? "cordn-browser";
    const server = new McpServer({
      name: coordinatorName,
      version: "0.1.0",
    });
    diagnostics?.onStartupPhase?.({ phase: "opening-storage" });
    const storage = await createBrowserCoordinatorStorage(persistent, coordinatorPubkey);
    diagnostics?.onStartupPhase?.({ phase: "preparing-runtime" });
    const coordinator = createCoordinator({
      storage,
    });

    const relayHandler = createInstrumentedRelayHandler(websocketPool, diagnostics);
    const transport = new NostrServerTransport({
      signer,
      relayHandler,
      serverInfo: {
        name: coordinatorName,
        about: `Cordn coordinator running in a browser tab; key package quota ${options.maxUsers} per identity`,
      },
      isAnnouncedServer: options.announce,
      injectClientPubkey: true,
      injectRequestEventId: true,
      oversizedTransfer: { enabled: true },
      openStream: { enabled: true },
    });
    const inspectableTransport = transport as unknown as InspectableNostrServerTransport;
    // The SDK's discoverability path otherwise creates a fresh relay pool with
    // its own long retry loop. Keep metadata/announcement delivery on the same
    // bounded, lifecycle-owned path as every other coordinator publication.
    inspectableTransport.publishEventToRelayUrls = (event) => relayHandler.publish(event);
    const processIncomingEvent = inspectableTransport.processIncomingEvent.bind(transport);
    inspectableTransport.processIncomingEvent = async (event) => {
      diagnostics?.onNostrEvent?.({
        summary: summarizeNostrEvent(event),
      });
      await processIncomingEvent(event);
    };
    transport.addInboundMiddleware(async (message, ctx, forward) => {
      const disabledStreamId = disableUnusedOpenStream(inspectableTransport, message);
      const cancelledStreamId = await abortCancelledOpenStream(inspectableTransport, message);
      diagnostics?.onInboundMessage?.({
        method: getJsonRpcMethod(message),
        clientPubkey: ctx.clientPubkey,
        summary: summarizeJsonRpcMessage(message, disabledStreamId, cancelledStreamId),
      });
      await forward(message);
    });
    const send = transport.send.bind(transport);
    transport.send = async (message) => {
      try {
        await send(message);
        diagnostics?.onOutboundMessage?.({
          type: getJsonRpcMessageType(message),
          summary: summarizeJsonRpcMessage(message),
          error: getJsonRpcErrorMessage(message),
        });
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        diagnostics?.onOutboundError?.(normalizedError);
        throw error;
      }
    };
    transport.onerror = (error) => diagnostics?.onOutboundError?.(error);
    transport.onclose = () => diagnostics?.onClosed?.();
    const resolveRequestEvent: ResolveRequestEvent = (requestEventId) =>
      transport.getNostrRequestEvent(requestEventId) ?? null;
    const adapter = new CoordinatorAdapter(
      coordinator,
      resolveRequestEvent,
      createBrowserAbuseProtection(options),
    );

    registerCoordinatorMethods(server, adapter);

    diagnostics?.onStartupPhase?.({ phase: "connecting-relays" });
    await server.connect(transport);
    diagnostics?.onStarted?.({
      publicKeyHex: coordinatorPubkey,
      relayUrls: websocketPool,
    });

    return {
      server,
      transport,
      coordinator,
      adapter,
      flush: () => storage.flush(),
      close: () => {
        adapter.close();
        closeIfPresent(transport);
        closeIfPresent(server);
        storage.close();
      },
    };
  }
}

function createInstrumentedRelayHandler(
  relayUrls: string[],
  diagnostics?: TransportDiagnostics,
): RelayHandler {
  const relayPool = createRequiredRelayPool(relayUrls, {
    operation: "coordinator-response",
    onPublishDiagnostic: diagnostics?.onRelayPublish,
  });

  return {
    connect: () => relayPool.connect(),
    disconnect: () => relayPool.disconnect(),
    publish: async (event, options) => {
      diagnostics?.onNostrPublish?.({
        phase: "attempt",
        summary: summarizeNostrEvent(event),
      });
      await relayPool.publish(event, options);
      diagnostics?.onNostrPublish?.({
        phase: "accepted",
        summary: summarizeNostrEvent(event),
      });
    },
    subscribe: (filters, onEvent, onEose) => relayPool.subscribe(filters, onEvent, onEose),
    unsubscribe: () => relayPool.unsubscribe(),
    getRelayUrls: () => relayPool.getRelayUrls(),
  };
}

function getJsonRpcMethod(message: JSONRPCMessage): string {
  if ("method" in message) {
    return message.method;
  }

  return "response";
}

function getJsonRpcMessageType(message: JSONRPCMessage): string {
  if ("method" in message) {
    return message.method;
  }

  if ("error" in message) {
    return "error response";
  }

  return "result response";
}

function getJsonRpcErrorMessage(message: JSONRPCMessage): string | undefined {
  if (!("error" in message)) {
    return undefined;
  }

  return message.error.message;
}

function summarizeNostrEvent(event: NostrEvent): string {
  const tags = event.tags.map((tag) => tag.slice(0, 2).join("=")).slice(0, 6).join(" ");
  const parts = [
    `kind=${event.kind}`,
    `id=${abbreviateHex(event.id)}`,
    `pubkey=${abbreviateHex(event.pubkey)}`,
  ];
  if (tags) {
    parts.push(`tags=${tags}`);
  }

  if (event.content.length > 0) {
    parts.push(`content=${truncateForLog(event.content)}`);
  }

  return parts.join(" ");
}

function disableUnusedOpenStream(
  transport: InspectableNostrServerTransport,
  message: JSONRPCMessage,
): string | undefined {
  if (!("method" in message)) {
    return undefined;
  }

  const params = getRecord(message.params ?? {});
  const toolName = params.name;
  const isStreamingTool =
    message.method === "tools/call" &&
    (
      toolName === COORDINATOR_METHODS.subscribeGroupMessages ||
      toolName === COORDINATOR_METHODS.subscribeManyGroupMessages
    );
  if (isStreamingTool) {
    return undefined;
  }

  const meta = params._meta;
  if (typeof meta !== "object" || meta === null) {
    return undefined;
  }

  const requestEventId = getRecord(meta).requestEventId;
  if (typeof requestEventId !== "string") {
    return undefined;
  }

  const writers = transport.getInternalStateForTesting().openStreamWriters;
  if (!writers.has(requestEventId)) {
    return undefined;
  }

  writers.delete(requestEventId);
  return requestEventId;
}

function summarizeJsonRpcMessage(
  message: JSONRPCMessage,
  disabledStreamId?: string,
  cancelledStreamId?: string,
): string {
  const parts = [`type=${getJsonRpcMessageType(message)}`];
  if ("id" in message) {
    parts.push(`id=${String(message.id)}`);
  }

  if ("params" in message && typeof message.params === "object" && message.params !== null) {
    parts.push(`params=${Object.keys(message.params).slice(0, 8).join(",")}`);
    const params = getRecord(message.params);
    if (message.method === "notifications/cancelled") {
      const requestId = params.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        parts.push(`requestId=${String(requestId)}`);
      }

      const reason = params.reason;
      if (typeof reason === "string" && reason.length > 0) {
        parts.push(`reason=${truncateForLog(reason)}`);
      }
    }

    const toolName = params.name;
    if (message.method === "tools/call" && typeof toolName === "string") {
      parts.push(`tool=${toolName}`);
      const toolArguments = params.arguments;
      if (typeof toolArguments === "object" && toolArguments !== null) {
        parts.push(`args=${summarizeObjectKeys(toolArguments)}`);
      }
    }
  }

  if ("result" in message && typeof message.result === "object" && message.result !== null) {
    parts.push(`result=${summarizeObjectKeys(message.result)}`);
    const structuredContent = getRecord(message.result).structuredContent;
    if (typeof structuredContent === "object" && structuredContent !== null) {
      parts.push(`structured=${summarizeObjectKeys(structuredContent)}`);
      const structuredRecord = getRecord(structuredContent);
      for (const key of ["cursor", "gid", "at"]) {
        const value = structuredRecord[key];
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          parts.push(`${key}=${String(value)}`);
        }
      }
    }
  }

  if ("error" in message) {
    parts.push(`error=${truncateForLog(message.error.message)}`);
  }

  if (disabledStreamId) {
    parts.push(`disabled_unused_stream=${abbreviateHex(disabledStreamId)}`);
  }

  if (cancelledStreamId) {
    parts.push(`cancelled_stream=${abbreviateHex(cancelledStreamId)}`);
  }

  return parts.join(" ");
}

function summarizeObjectKeys(value: object): string {
  return Object.keys(value).slice(0, 8).join(",");
}

function getRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

export async function abortCancelledOpenStream(
  transport: Pick<InspectableNostrServerTransport, "getInternalStateForTesting">,
  message: JSONRPCMessage,
): Promise<string | undefined> {
  if (!("method" in message) || message.method !== "notifications/cancelled") {
    return undefined;
  }

  const params = typeof message.params === "object" && message.params !== null ? getRecord(message.params) : {};
  const requestId = params.requestId;
  if (typeof requestId !== "string" && typeof requestId !== "number") {
    return undefined;
  }

  const state = transport.getInternalStateForTesting();
  const requestIdLabel = String(requestId);
  const eventId = findOpenStreamEventId(state, requestIdLabel);
  if (!eventId) {
    return undefined;
  }

  const writer = state.openStreamWriters.get(eventId);
  if (!writer?.isActive) {
    return undefined;
  }

  const reason = typeof params.reason === "string" && params.reason.length > 0 ? params.reason : "cancelled";
  await writer.abort(reason);
  return eventId;
}

function findOpenStreamEventId(
  state: ReturnType<InspectableNostrServerTransport["getInternalStateForTesting"]>,
  requestId: string,
): string | undefined {
  if (state.openStreamWriters.has(requestId)) {
    return requestId;
  }

  for (const eventId of state.openStreamWriters.keys()) {
    const route = state.correlationStore?.getEventRoute(eventId);
    if (route && String(route.originalRequestId) === requestId) {
      return eventId;
    }
  }

  return undefined;
}

function truncateForLog(value: string): string {
  return value.length > 180 ? `${value.slice(0, 180)}...` : value;
}

function abbreviateHex(value: string): string {
  if (value.length <= 16) {
    return value;
  }

  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

export const transportFactory = new TransportFactory();
