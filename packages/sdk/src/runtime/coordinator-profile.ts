import { SimplePool, verifyEvent, type Event as NostrEvent } from "nostr-tools";
import { finalizeEvent } from "nostr-tools/pure";

import { normalizeCoordinatorName } from "./config-validator.js";

const PROFILE_QUERY_MAX_WAIT_MS = 4_000;
const PROFILE_QUERY_LIMIT = 20;
const MAX_PROFILE_CONTENT_LENGTH = 16_384;
const MAX_METADATA_DEPTH = 16;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface CoordinatorProfilePool {
  querySync(
    relayUrls: string[],
    filter: { kinds: number[]; authors: string[]; limit: number },
    options: { maxWait: number },
  ): Promise<NostrEvent[]>;
  publish(relayUrls: string[], event: NostrEvent): readonly Promise<unknown>[];
  destroy(): void;
}

export interface CoordinatorProfilePublisherInput {
  name: string;
  coordinatorPubkey: string;
  getSecretKeyBytes(): Uint8Array;
  relayUrls: readonly string[];
}

export interface CoordinatorProfilePublisherDeps {
  createPool?: () => CoordinatorProfilePool;
  now?: () => number;
}

export class CoordinatorProfilePublicationError extends Error {
  constructor() {
    super("Coordinator profile publication failed");
    this.name = "CoordinatorProfilePublicationError";
  }
}

export function parseCoordinatorProfileMetadata(content: string): Record<string, JsonValue> | null {
  if (content.length > MAX_PROFILE_CONTENT_LENGTH) return null;

  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isJsonObject(parsed) || !isJsonSafe(parsed, 0)) return null;
    return copyJsonObject(parsed);
  } catch {
    return null;
  }
}

export function mergeCoordinatorProfileMetadata(content: string | null, name: string): Record<string, JsonValue> {
  const existing = content === null ? null : parseCoordinatorProfileMetadata(content);
  return { ...(existing ?? {}), name };
}

export async function publishCoordinatorProfile(
  input: CoordinatorProfilePublisherInput,
  deps: CoordinatorProfilePublisherDeps = {},
): Promise<NostrEvent> {
  const name = normalizeCoordinatorName(input.name);
  const relayUrls = [...input.relayUrls];
  if (name === null || relayUrls.length === 0) throw new CoordinatorProfilePublicationError();

  const pool = (deps.createPool ?? (() => new SimplePool()))();
  let secretKey: Uint8Array | null = null;

  try {
    const existingMetadata = await newestUsableMetadata(pool, relayUrls, input.coordinatorPubkey);
    secretKey = input.getSecretKeyBytes();
    const event = finalizeEvent({
      kind: 0,
      created_at: Math.floor((deps.now ?? Date.now)() / 1_000),
      tags: [],
      content: JSON.stringify({ ...(existingMetadata ?? {}), name }),
    }, secretKey);

    if (event.pubkey !== input.coordinatorPubkey || !verifyEvent(event)) {
      throw new CoordinatorProfilePublicationError();
    }

    const acknowledgements = pool.publish(relayUrls, event);
    const results = await Promise.allSettled(acknowledgements);
    if (!results.some(isRelayAcknowledgement)) {
      throw new CoordinatorProfilePublicationError();
    }

    return event;
  } catch (error) {
    if (error instanceof CoordinatorProfilePublicationError) throw error;
    throw new CoordinatorProfilePublicationError();
  } finally {
    secretKey?.fill(0);
    pool.destroy();
  }
}

function isRelayAcknowledgement(result: PromiseSettledResult<unknown>): boolean {
  if (result.status !== "fulfilled") return false;
  return typeof result.value !== "string" || !result.value.startsWith("connection failure:");
}

async function newestUsableMetadata(
  pool: CoordinatorProfilePool,
  relayUrls: string[],
  coordinatorPubkey: string,
): Promise<Record<string, JsonValue> | null> {
  try {
    const events = await pool.querySync(relayUrls, {
      kinds: [0],
      authors: [coordinatorPubkey],
      limit: PROFILE_QUERY_LIMIT,
    }, { maxWait: PROFILE_QUERY_MAX_WAIT_MS });

    for (const event of [...events].sort((left, right) => right.created_at - left.created_at)) {
      if (event.pubkey.toLowerCase() !== coordinatorPubkey.toLowerCase()) continue;
      const metadata = parseCoordinatorProfileMetadata(event.content);
      if (metadata) return metadata;
    }
  } catch {
    // Existing public metadata is optional; a new signed name remains publishable.
  }
  return null;
}

function isJsonObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonSafe(value: unknown, depth: number): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= MAX_METADATA_DEPTH || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.every((entry) => isJsonSafe(entry, depth + 1));
  return Object.values(value).every((entry) => isJsonSafe(entry, depth + 1));
}

function copyJsonObject(value: { [key: string]: unknown }): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(result, key, {
      value: copyJsonValue(entry as JsonValue),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function copyJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(copyJsonValue);
  if (isJsonObject(value)) return copyJsonObject(value);
  return value;
}
