import type { RelayHandler } from "@contextvm/sdk/core";
import { ApplesauceRelayPool } from "@contextvm/sdk/relay";
import type { NostrEvent } from "nostr-tools";

/** A local relay is always part of the browser transport pool. */
export const REQUIRED_LOCAL_RELAY_URL = "ws://localhost:4870";
export const RELAY_PUBLISH_DIAGNOSTIC_EVENT = "cordn:relay-publish-diagnostic";

export const RELAY_PUBLISH_POLICY = {
  primaryAttemptTimeoutMs: 500,
  primaryMaxAttempts: 2,
  primaryRetryDelaysMs: [100] as readonly number[],
  localReadyTimeoutMs: 400,
  localReadyCacheMs: 5_000,
  localPublishTimeoutMs: 1_200,
} as const;

export type RelayPublishOutcome = "attempt" | "accepted" | "retrying" | "skipped" | "aborted" | "failed";

export interface RelayPublishDiagnostic {
  relayUrl: string;
  eventId: string;
  eventKind: number;
  operation: string;
  path: "primary" | "optional-local";
  attempt: number;
  elapsedMs: number;
  outcome: RelayPublishOutcome;
}

type RelayPoolLike = RelayHandler;

interface RelayPublishPolicy {
  primaryAttemptTimeoutMs: number;
  primaryMaxAttempts: number;
  primaryRetryDelaysMs: readonly number[];
  localReadyTimeoutMs: number;
  localReadyCacheMs: number;
  localPublishTimeoutMs: number;
}

export interface RequiredRelayPoolOptions {
  operation?: string;
  onPublishDiagnostic?: (diagnostic: RelayPublishDiagnostic) => void;
  policy?: Partial<RelayPublishPolicy>;
  createPool?: (relayUrls: string[], path: RelayPublishDiagnostic["path"]) => RelayPoolLike;
  probeRelay?: (relayUrl: string, signal: AbortSignal) => Promise<boolean>;
  now?: () => number;
}

class PublishAbortedError extends Error {
  constructor() {
    super("Relay publication aborted");
    this.name = "AbortError";
  }
}

/** Include the local relay exactly once in the operational transport pool. */
export function withRequiredLocalRelay(relayUrls: readonly string[]): string[] {
  return [...new Set([...relayUrls, REQUIRED_LOCAL_RELAY_URL])];
}

/**
 * Relay hints embedded in a portable invite must be reachable from a secure
 * third-party web client. In particular, advertising the browser-only local
 * relay makes https://cordn.net attempt an insecure localhost WebSocket and
 * can prevent its coordinator request from being published at all.
 */
export function shareableRelayUrls(relayUrls: readonly string[]): string[] {
  const result = new Set<string>();
  for (const value of relayUrls) {
    const trimmed = value.trim();
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "wss:") continue;
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") continue;
      result.add(trimmed);
    } catch {
      // Invalid relay configuration is handled by the config validator. Keep
      // invite construction defensive because stored rooms may predate it.
    }
  }
  return [...result];
}

/**
 * Keeps the mandatory local relay available without allowing its SDK-level
 * infinite publish retry to outlive the operation that created it.
 */
export function createRequiredRelayPool(
  relayUrls: readonly string[],
  options: RequiredRelayPoolOptions = {},
): RelayHandler {
  const websocketPool = withRequiredLocalRelay(relayUrls);
  const remoteUrls = websocketPool.filter((url) => url !== REQUIRED_LOCAL_RELAY_URL);
  const policy: RelayPublishPolicy = { ...RELAY_PUBLISH_POLICY, ...options.policy };
  const createPool = options.createPool ?? ((urls: string[], path: RelayPublishDiagnostic["path"]) =>
    new ApplesauceRelayPool(urls, {
      publishOptions: {
        timeout: Math.max(250, (path === "primary" ? policy.primaryAttemptTimeoutMs : policy.localPublishTimeoutMs) - 250),
        retries: 0,
      },
    }));
  const primaryUrls = remoteUrls.length > 0 ? remoteUrls : [REQUIRED_LOCAL_RELAY_URL];
  const primaryPool = createPool(primaryUrls, "primary");
  const localPool = remoteUrls.length > 0 ? createPool([REQUIRED_LOCAL_RELAY_URL], "optional-local") : null;
  const operation = options.operation ?? "contextvm";
  const now = options.now ?? Date.now;
  const probeRelay = options.probeRelay ?? probeRelayWebSocket;
  const onPublishDiagnostic = options.onPublishDiagnostic ?? dispatchRelayPublishDiagnostic;
  const lifecycle = new AbortController();
  const inFlight = new Set<AbortController>();
  const localTasks = new Set<Promise<void>>();
  let localReadyUntil = 0;
  let disconnected = false;

  const emit = (
    urls: readonly string[],
    event: NostrEvent,
    path: RelayPublishDiagnostic["path"],
    attempt: number,
    startedAt: number,
    outcome: RelayPublishOutcome,
  ) => {
    for (const relayUrl of urls) {
      onPublishDiagnostic({
        relayUrl,
        eventId: event.id,
        eventKind: event.kind,
        operation,
        path,
        attempt,
        elapsedMs: Math.max(0, now() - startedAt),
        outcome,
      });
    }
  };

  const publishAttempt = async (
    pool: RelayPoolLike,
    urls: readonly string[],
    event: NostrEvent,
    publishOptions: { abortSignal?: AbortSignal } | undefined,
    path: RelayPublishDiagnostic["path"],
    attempt: number,
    timeoutMs: number,
  ): Promise<void> => {
    const startedAt = now();
    const controller = new AbortController();
    const unlink = linkAbortSignals(controller, [lifecycle.signal, publishOptions?.abortSignal]);
    const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    inFlight.add(controller);
    emit(urls, event, path, attempt, startedAt, "attempt");
    try {
      const publication = pool.publish(event, { abortSignal: controller.signal });
      const aborted = new Promise<never>((_resolve, reject) => {
        if (controller.signal.aborted) {
          reject(new PublishAbortedError());
          return;
        }
        controller.signal.addEventListener("abort", () => reject(new PublishAbortedError()), { once: true });
      });
      await Promise.race([publication, aborted]);
      if (controller.signal.aborted) throw new PublishAbortedError();
      emit(urls, event, path, attempt, startedAt, "accepted");
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        emit(urls, event, path, attempt, startedAt, "aborted");
        throw new PublishAbortedError();
      }
      emit(urls, event, path, attempt, startedAt, "failed");
      throw error;
    } finally {
      globalThis.clearTimeout(timer);
      unlink();
      inFlight.delete(controller);
    }
  };

  const publishPrimary = async (
    event: NostrEvent,
    publishOptions?: { abortSignal?: AbortSignal },
  ): Promise<void> => {
    const startedAt = now();
    let lastError: unknown = new Error("Relay publication failed");
    for (let attempt = 1; attempt <= policy.primaryMaxAttempts; attempt += 1) {
      if (disconnected || lifecycle.signal.aborted || publishOptions?.abortSignal?.aborted) {
        throw new PublishAbortedError();
      }
      try {
        await publishAttempt(
          primaryPool,
          primaryUrls,
          event,
          publishOptions,
          "primary",
          attempt,
          policy.primaryAttemptTimeoutMs,
        );
        return;
      } catch (error) {
        lastError = error;
        if (disconnected || lifecycle.signal.aborted || publishOptions?.abortSignal?.aborted) throw error;
        if (attempt >= policy.primaryMaxAttempts) break;
        emit(primaryUrls, event, "primary", attempt, startedAt, "retrying");
        await abortableDelay(policy.primaryRetryDelaysMs[attempt - 1] ?? 0, [lifecycle.signal, publishOptions?.abortSignal]);
      }
    }
    throw lastError;
  };

  const publishOptionalLocal = async (
    event: NostrEvent,
    publishOptions?: { abortSignal?: AbortSignal },
  ): Promise<void> => {
    if (!localPool || disconnected || lifecycle.signal.aborted || publishOptions?.abortSignal?.aborted) return;
    const startedAt = now();
    if (localReadyUntil <= now()) {
      const controller = new AbortController();
      const unlink = linkAbortSignals(controller, [lifecycle.signal, publishOptions?.abortSignal]);
      const timer = globalThis.setTimeout(() => controller.abort(), policy.localReadyTimeoutMs);
      inFlight.add(controller);
      let ready: boolean;
      try {
        ready = await probeRelay(REQUIRED_LOCAL_RELAY_URL, controller.signal);
      } catch {
        ready = false;
      } finally {
        globalThis.clearTimeout(timer);
        unlink();
        inFlight.delete(controller);
      }
      if (!ready || controller.signal.aborted) {
        emit([REQUIRED_LOCAL_RELAY_URL], event, "optional-local", 0, startedAt, "skipped");
        return;
      }
      localReadyUntil = now() + policy.localReadyCacheMs;
    }
    try {
      await publishAttempt(
        localPool,
        [REQUIRED_LOCAL_RELAY_URL],
        event,
        publishOptions,
        "optional-local",
        1,
        policy.localPublishTimeoutMs,
      );
    } catch {
      localReadyUntil = 0;
      // Optional local delivery never changes primary publication success.
    }
  };

  const trackLocal = (task: Promise<void>) => {
    localTasks.add(task);
    void task.finally(() => localTasks.delete(task));
  };

  return {
    connect: async () => {
      if (disconnected) throw new PublishAbortedError();
      await primaryPool.connect();
      if (localPool) void localPool.connect().catch(() => undefined);
    },
    disconnect: async () => {
      if (!disconnected) {
        disconnected = true;
        lifecycle.abort();
        for (const controller of inFlight) controller.abort();
      }
      await Promise.allSettled([
        ...localTasks,
        primaryPool.disconnect(),
        ...(localPool ? [localPool.disconnect()] : []),
      ]);
    },
    publish: async (event, publishOptions) => {
      if (localPool) trackLocal(publishOptionalLocal(event, publishOptions));
      await publishPrimary(event, publishOptions);
    },
    subscribe: async (filters, onEvent, onEose) => {
      if (disconnected) throw new PublishAbortedError();
      const unsubscribePrimary = await primaryPool.subscribe(filters, onEvent, onEose);
      let unsubscribeLocal: (() => void) | undefined;
      let subscriptionClosed = false;
      if (localPool) {
        const localSubscription = (async () => {
          const controller = new AbortController();
          const unlink = linkAbortSignals(controller, [lifecycle.signal]);
          const timer = globalThis.setTimeout(() => controller.abort(), policy.localReadyTimeoutMs);
          inFlight.add(controller);
          try {
            const ready = await probeRelay(REQUIRED_LOCAL_RELAY_URL, controller.signal);
            if (!ready || controller.signal.aborted || subscriptionClosed) return;
            unsubscribeLocal = await localPool.subscribe(filters, onEvent, onEose);
            if (subscriptionClosed) unsubscribeLocal();
          } catch {
            // Optional localhost subscriptions never delay or fail the primary path.
          } finally {
            globalThis.clearTimeout(timer);
            unlink();
            inFlight.delete(controller);
          }
        })();
        trackLocal(localSubscription);
      }
      return () => {
        subscriptionClosed = true;
        unsubscribePrimary();
        unsubscribeLocal?.();
      };
    },
    unsubscribe: () => {
      primaryPool.unsubscribe();
      localPool?.unsubscribe();
    },
    getRelayUrls: () => websocketPool,
  };
}

async function probeRelayWebSocket(relayUrl: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let socket: WebSocket | null = null;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
      resolve(ready);
    };
    const abort = () => finish(false);
    signal.addEventListener("abort", abort, { once: true });
    try {
      socket = new WebSocket(relayUrl);
      socket.addEventListener("open", () => finish(true), { once: true });
      socket.addEventListener("error", () => finish(false), { once: true });
      socket.addEventListener("close", () => finish(false), { once: true });
    } catch {
      finish(false);
    }
  });
}

function linkAbortSignals(controller: AbortController, signals: Array<AbortSignal | undefined>): () => void {
  const removers: Array<() => void> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort();
      break;
    }
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    removers.push(() => signal.removeEventListener("abort", abort));
  }
  return () => removers.forEach((remove) => remove());
}

function abortableDelay(delayMs: number, signals: Array<AbortSignal | undefined>): Promise<void> {
  if (signals.some((signal) => signal?.aborted)) return Promise.reject(new PublishAbortedError());
  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(finish, delayMs);
    const removers: Array<() => void> = [];
    function finish() {
      removers.forEach((remove) => remove());
      resolve();
    }
    function abort() {
      globalThis.clearTimeout(timer);
      removers.forEach((remove) => remove());
      reject(new PublishAbortedError());
    }
    for (const signal of signals) {
      if (!signal) continue;
      signal.addEventListener("abort", abort, { once: true });
      removers.push(() => signal.removeEventListener("abort", abort));
    }
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message === "Publish aborted");
}

function dispatchRelayPublishDiagnostic(diagnostic: RelayPublishDiagnostic): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(RELAY_PUBLISH_DIAGNOSTIC_EVENT, { detail: diagnostic }));
}
