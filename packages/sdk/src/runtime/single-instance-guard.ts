import { SimplePool, type Event as NostrEvent } from "nostr-tools";
import { finalizeEvent } from "nostr-tools/pure";

export const INSTANCE_RUNNING_MESSAGE = "cordn already running";
export const INSTANCE_HEARTBEAT_KIND = 30382;

const BROADCAST_CHANNEL_NAME = "cordn-browser:v1:instances";
const HEARTBEAT_D_TAG = "cordn-browser-instance";
const LEASE_KEY_PREFIX = "cordn:v1:instance:";
const STOPPED_TOKEN_KEY_PREFIX = "cordn:v1:stopped-instance:";
const DEFAULT_LEASE_DURATION_MS = 45_000;
const DEFAULT_LEASE_RENEW_MS = 15_000;
const DEFAULT_BROADCAST_PROBE_MS = 120;
const DEFAULT_NOSTR_PROBE_MS = 1_500;
const HEARTBEAT_RENEW_MS = 5_000;
const HEARTBEAT_FRESH_SECONDS = 12;
const HEARTBEAT_EXPIRATION_SECONDS = 20;
const latestHeartbeatCreatedAtByPubkey: Record<string, number> = {};

export interface DebugSink {
  (level: "info" | "warn" | "error", message: string, details?: string): void;
}

interface BrowserLockManager {
  request<T>(
    name: string,
    options: { ifAvailable: true; mode?: "exclusive" },
    callback: (lock: unknown | null) => T | Promise<T>,
  ): Promise<T>;
}

interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

interface StoredLease {
  token: string;
  publicKeyHex: string;
  updatedAt: number;
  expiresAt: number;
}

interface NostrHeartbeatInput {
  publicKeyHex: string;
  relayUrls: string[];
  getSecretKeyBytes: () => Uint8Array;
  instanceToken: string;
}

export interface SingleInstanceAcquireInput {
  publicKeyHex: string;
  relayUrls: string[];
  getSecretKeyBytes: () => Uint8Array;
  debug?: DebugSink;
}

export interface InstanceLease {
  release(): void | Promise<void>;
}

export interface NostrInstanceNetwork {
  isRunning(
    publicKeyHex: string,
    relayUrls: string[],
    ignoredInstanceTokens: string[],
    debug?: DebugSink,
  ): Promise<boolean>;
  startHeartbeat(input: NostrHeartbeatInput, debug?: DebugSink): InstanceLease;
}

interface SingleInstanceGuardDeps {
  storage?: Storage | null;
  locks?: BrowserLockManager | null;
  createBroadcastChannel?: ((name: string) => BroadcastChannelLike) | null;
  nostr?: NostrInstanceNetwork | null;
  now?: () => number;
  randomUUID?: () => string;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  leaseDurationMs?: number;
  leaseRenewMs?: number;
  broadcastProbeMs?: number;
}

export class CordnAlreadyRunningError extends Error {
  constructor() {
    super(INSTANCE_RUNNING_MESSAGE);
    this.name = "CordnAlreadyRunningError";
  }
}

export class SimplePoolNostrInstanceNetwork implements NostrInstanceNetwork {
  constructor(private readonly probeTimeoutMs = DEFAULT_NOSTR_PROBE_MS) {}

  async isRunning(
    publicKeyHex: string,
    relayUrls: string[],
    ignoredInstanceTokens: string[],
    debug?: DebugSink,
  ): Promise<boolean> {
    if (relayUrls.length === 0) {
      return false;
    }

    const pool = new SimplePool({ enablePing: false, enableReconnect: false });
    const since = Math.floor(Date.now() / 1000) - HEARTBEAT_EXPIRATION_SECONDS;

    try {
      const events = await pool.querySync(
        relayUrls,
        {
          kinds: [INSTANCE_HEARTBEAT_KIND],
          authors: [publicKeyHex],
          "#d": [HEARTBEAT_D_TAG],
          since,
          limit: 8,
        },
        { maxWait: this.probeTimeoutMs, label: "cordn-instance-probe" },
      );
      const latest = latestHeartbeatEvent(events, ignoredInstanceTokens);
      const running = latest ? isRunningHeartbeat(latest) : false;

      debug?.(
        "info",
        "nostr instance probe complete",
        latest ? `${heartbeatStatus(latest)} heartbeat ${running ? "fresh" : "ignored"}` : "no heartbeat",
      );
      return running;
    } catch (error) {
      debug?.("warn", "nostr instance probe failed", errorMessage(error));
      return false;
    } finally {
      pool.destroy();
    }
  }

  startHeartbeat(input: NostrHeartbeatInput, debug?: DebugSink): InstanceLease {
    if (input.relayUrls.length === 0) {
      return { release: () => undefined };
    }

    const pool = new SimplePool({ enablePing: false, enableReconnect: false });
    const publish = async (status: "running" | "stopped"): Promise<void> => {
      const secretKey = input.getSecretKeyBytes();
      let event: NostrEvent;
      try {
        // Kind 30382 is parameterized-replaceable. Guarantee that a stop sent
        // in the same wall-clock second as the last running heartbeat wins the
        // relay's replacement ordering instead of leaving a false online state.
        const nowSeconds = Math.max(
          Math.floor(Date.now() / 1000),
          (latestHeartbeatCreatedAtByPubkey[input.publicKeyHex] ?? 0) + 1,
        );
        latestHeartbeatCreatedAtByPubkey[input.publicKeyHex] = nowSeconds;
        event = finalizeEvent(
          {
            kind: INSTANCE_HEARTBEAT_KIND,
            created_at: nowSeconds,
            content: `cordn browser ${status}`,
            tags: [
              ["d", HEARTBEAT_D_TAG],
              ["status", status],
              ["instance", input.instanceToken],
              ["expiration", String(nowSeconds + (status === "running" ? HEARTBEAT_EXPIRATION_SECONDS : 1))],
            ],
          },
          secretKey,
        );
      } catch (error) {
        debug?.("warn", "nostr instance heartbeat failed", errorMessage(error));
        if (status === "stopped") pool.destroy();
        return;
      } finally {
        secretKey.fill(0);
      }

      try {
        const results = await Promise.allSettled(pool.publish(input.relayUrls, event));
        const published = results.filter((result) => result.status === "fulfilled").length;
        debug?.("info", `nostr instance ${status} heartbeat published`, `${published}/${input.relayUrls.length} relays`);
      } catch (error) {
        debug?.("warn", "nostr instance heartbeat publish failed", errorMessage(error));
      } finally {
        if (status === "stopped") pool.destroy();
      }
    };

    void publish("running");
    const timer = setInterval(() => void publish("running"), HEARTBEAT_RENEW_MS);

    return {
      release: async () => {
        clearInterval(timer);
        await publish("stopped");
      },
    };
  }
}

export class SingleInstanceGuard {
  private readonly releases: Array<() => void | Promise<void>> = [];
  private readonly token: string;

  constructor(private readonly deps: SingleInstanceGuardDeps = {}) {
    this.token = deps.randomUUID?.() ?? crypto.randomUUID();
  }

  async acquire(input: SingleInstanceAcquireInput): Promise<InstanceLease> {
    input.debug?.("info", "checking browser instance locks", shortKey(input.publicKeyHex));

    try {
      await this.acquireWebLock(input.publicKeyHex, input.debug);
      await this.probeBroadcast(input.publicKeyHex, input.debug);
      this.acquireStorageLease(input.publicKeyHex, input.debug);
      await this.probeNostr(input.publicKeyHex, input.relayUrls, input.debug);
      this.openBroadcastResponder(input.publicKeyHex, input.debug);
      this.startNostrHeartbeat(input, input.debug);
      input.debug?.("info", "single instance guard acquired", shortKey(input.publicKeyHex));
    } catch (error) {
      await this.release();
      throw error;
    }

    return {
      release: () => this.release(),
    };
  }

  private async acquireWebLock(publicKeyHex: string, debug?: DebugSink): Promise<void> {
    const locks = this.getLocks();
    if (!locks) {
      debug?.("info", "web lock unavailable", "continuing with storage and relay checks");
      return;
    }

    let releaseLock: () => void = () => undefined;
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let requestComplete: Promise<void> = Promise.resolve();
    const granted = new Promise<boolean>((resolve) => {
      requestComplete = locks.request(`cordn:${publicKeyHex}`, { ifAvailable: true, mode: "exclusive" }, async (lock) => {
        resolve(Boolean(lock));
        if (!lock) {
          return;
        }

        await holdLock;
      });
    });

    if (!(await granted)) {
      debug?.("warn", "web lock detected running instance", shortKey(publicKeyHex));
      throw new CordnAlreadyRunningError();
    }

    this.releases.push(async () => {
      releaseLock();
      await requestComplete;
    });
    debug?.("info", "web lock acquired", shortKey(publicKeyHex));
  }

  private async probeBroadcast(publicKeyHex: string, debug?: DebugSink): Promise<void> {
    const channel = this.createBroadcastChannel();
    if (!channel) {
      debug?.("info", "broadcast probe unavailable", "continuing with storage and relay checks");
      return;
    }

    const running = await new Promise<boolean>((resolve) => {
      const timeout = this.getSetTimeout()(() => {
        cleanup();
        resolve(false);
      }, this.deps.broadcastProbeMs ?? DEFAULT_BROADCAST_PROBE_MS);
      const onMessage = (event: MessageEvent): void => {
        if (isBroadcastMessage(event.data, "running", publicKeyHex)) {
          cleanup();
          resolve(true);
        }
      };
      const cleanup = (): void => {
        this.getClearTimeout()(timeout);
        channel.removeEventListener("message", onMessage);
        channel.close();
      };

      channel.addEventListener("message", onMessage);
      channel.postMessage({ type: "probe", publicKeyHex, token: this.token });
    });

    if (running) {
      debug?.("warn", "broadcast probe detected running instance", shortKey(publicKeyHex));
      throw new CordnAlreadyRunningError();
    }

    debug?.("info", "broadcast probe clear", shortKey(publicKeyHex));
  }

  private acquireStorageLease(publicKeyHex: string, debug?: DebugSink): void {
    const storage = this.getStorage();
    if (!storage) {
      debug?.("info", "storage lease unavailable", "continuing with relay check");
      return;
    }

    const key = leaseStorageKey(publicKeyHex);
    const now = this.now();
    const existing = readLease(storage, key);

    if (existing && existing.token !== this.token && existing.expiresAt > now) {
      debug?.("warn", "storage lease detected running instance", shortKey(publicKeyHex));
      throw new CordnAlreadyRunningError();
    }

    const writeLease = (): void => {
      const updatedAt = this.now();
      const lease: StoredLease = {
        token: this.token,
        publicKeyHex,
        updatedAt,
        expiresAt: updatedAt + (this.deps.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS),
      };
      storage.setItem(key, JSON.stringify(lease));
    };

    writeLease();
    if (readLease(storage, key)?.token !== this.token) {
      debug?.("warn", "storage lease write lost race", shortKey(publicKeyHex));
      throw new CordnAlreadyRunningError();
    }

    const timer = this.getSetInterval()(writeLease, this.deps.leaseRenewMs ?? DEFAULT_LEASE_RENEW_MS);
    const release = (): void => {
      this.getClearInterval()(timer);
      rememberStoppedInstanceToken(storage, stoppedTokenStorageKey(publicKeyHex), this.token, this.now());
      if (readLease(storage, key)?.token === this.token) {
        storage.removeItem(key);
      }
    };
    this.releases.push(release);
    debug?.("info", "storage lease acquired", shortKey(publicKeyHex));
  }

  private async probeNostr(publicKeyHex: string, relayUrls: string[], debug?: DebugSink): Promise<void> {
    const nostr = this.getNostr();
    if (!nostr) {
      debug?.("info", "nostr instance probe unavailable", "browser-native checks complete");
      return;
    }

    debug?.("info", "checking nostr for active public key", shortKey(publicKeyHex));
    if (await nostr.isRunning(publicKeyHex, relayUrls, this.stoppedInstanceTokens(publicKeyHex), debug)) {
      debug?.("warn", "nostr probe detected running instance", shortKey(publicKeyHex));
      throw new CordnAlreadyRunningError();
    }
  }

  private openBroadcastResponder(publicKeyHex: string, debug?: DebugSink): void {
    const channel = this.createBroadcastChannel();
    if (!channel) {
      return;
    }

    const onMessage = (event: MessageEvent): void => {
      if (isBroadcastMessage(event.data, "probe", publicKeyHex)) {
        channel.postMessage({ type: "running", publicKeyHex, token: this.token });
      }
    };

    channel.addEventListener("message", onMessage);
    this.releases.push(() => {
      channel.removeEventListener("message", onMessage);
      channel.close();
    });
    debug?.("info", "broadcast responder active", shortKey(publicKeyHex));
  }

  private startNostrHeartbeat(input: SingleInstanceAcquireInput, debug?: DebugSink): void {
    const nostr = this.getNostr();
    if (!nostr) {
      return;
    }

    const heartbeat = nostr.startHeartbeat({ ...input, instanceToken: this.token }, debug);
    this.releases.push(() => heartbeat.release());
  }

  async release(): Promise<void> {
    const pending = this.releases.splice(0).reverse().map((release) => Promise.resolve(release()));
    await Promise.allSettled(pending);
  }

  private getStorage(): Storage | null {
    if (this.deps.storage !== undefined) {
      return this.deps.storage;
    }

    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  }

  private getLocks(): BrowserLockManager | null {
    if (this.deps.locks !== undefined) {
      return this.deps.locks;
    }

    return (globalThis.navigator as Navigator & { locks?: BrowserLockManager }).locks ?? null;
  }

  private createBroadcastChannel(): BroadcastChannelLike | null {
    if (this.deps.createBroadcastChannel !== undefined) {
      return this.deps.createBroadcastChannel?.(BROADCAST_CHANNEL_NAME) ?? null;
    }

    if (!("BroadcastChannel" in globalThis)) {
      return null;
    }

    return new BroadcastChannel(BROADCAST_CHANNEL_NAME);
  }

  private getNostr(): NostrInstanceNetwork | null {
    if (this.deps.nostr !== undefined) {
      return this.deps.nostr;
    }

    return new SimplePoolNostrInstanceNetwork();
  }

  private stoppedInstanceTokens(publicKeyHex: string): string[] {
    const storage = this.getStorage();
    if (!storage) {
      return [];
    }

    return readStoppedInstanceTokens(storage, stoppedTokenStorageKey(publicKeyHex), this.now());
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private getSetInterval(): typeof setInterval {
    return this.deps.setInterval ?? setInterval;
  }

  private getClearInterval(): typeof clearInterval {
    return this.deps.clearInterval ?? clearInterval;
  }

  private getSetTimeout(): typeof setTimeout {
    return this.deps.setTimeout ?? setTimeout;
  }

  private getClearTimeout(): typeof clearTimeout {
    return this.deps.clearTimeout ?? clearTimeout;
  }
}

function leaseStorageKey(publicKeyHex: string): string {
  return `${LEASE_KEY_PREFIX}${publicKeyHex}`;
}

function stoppedTokenStorageKey(publicKeyHex: string): string {
  return `${STOPPED_TOKEN_KEY_PREFIX}${publicKeyHex}`;
}

/** Forget browser-only instance bookkeeping after its coordinator identity is destroyed. */
export function clearCoordinatorInstanceRecords(publicKeyHex: string): void {
  try {
    localStorage.removeItem(leaseStorageKey(publicKeyHex));
    localStorage.removeItem(stoppedTokenStorageKey(publicKeyHex));
  } catch {
    // Destruction still succeeds when browser storage is unavailable.
  }
}

function readLease(storage: Storage, key: string): StoredLease | null {
  const raw = storage.getItem(key);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredLease>;
    if (
      typeof parsed.token === "string" &&
      typeof parsed.publicKeyHex === "string" &&
      typeof parsed.updatedAt === "number" &&
      typeof parsed.expiresAt === "number"
    ) {
      return parsed as StoredLease;
    }
  } catch {
    return null;
  }

  return null;
}

function isBroadcastMessage(value: unknown, type: "probe" | "running", publicKeyHex: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "publicKeyHex" in value &&
    value.type === type &&
    value.publicKeyHex === publicKeyHex
  );
}

function latestHeartbeatEvent(events: NostrEvent[], ignoredInstanceTokens: string[]): NostrEvent | null {
  const ignored = new Set(ignoredInstanceTokens);
  return events
    .filter((event) => event.tags.some((tag) => tag[0] === "d" && tag[1] === HEARTBEAT_D_TAG))
    .filter((event) => !ignored.has(heartbeatInstanceToken(event)))
    .sort((left, right) => right.created_at - left.created_at)[0] ?? null;
}

function isRunningHeartbeat(event: NostrEvent): boolean {
  return heartbeatStatus(event) === "running" && !isExpired(event) && isFresh(event);
}

function heartbeatStatus(event: NostrEvent): string {
  return event.tags.find((tag) => tag[0] === "status")?.[1] ?? "unknown";
}

function heartbeatInstanceToken(event: NostrEvent): string {
  return event.tags.find((tag) => tag[0] === "instance")?.[1] ?? "";
}

function isExpired(event: NostrEvent): boolean {
  const expiration = event.tags.find((tag) => tag[0] === "expiration")?.[1];
  return expiration ? Number(expiration) <= Math.floor(Date.now() / 1000) : false;
}

function isFresh(event: NostrEvent): boolean {
  return event.created_at >= Math.floor(Date.now() / 1000) - HEARTBEAT_FRESH_SECONDS;
}

function shortKey(publicKeyHex: string): string {
  return `${publicKeyHex.slice(0, 8)}...${publicKeyHex.slice(-8)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface StoppedInstanceToken {
  token: string;
  expiresAt: number;
}

function rememberStoppedInstanceToken(storage: Storage, key: string, token: string, nowMs: number): void {
  const tokens = readStoppedInstanceTokenEntries(storage, key, nowMs);
  const nextTokens = [
    ...tokens.filter((entry) => entry.token !== token),
    { token, expiresAt: nowMs + HEARTBEAT_EXPIRATION_SECONDS * 1_000 },
  ];
  storage.setItem(key, JSON.stringify(nextTokens));
}

function readStoppedInstanceTokens(storage: Storage, key: string, nowMs: number): string[] {
  const entries = readStoppedInstanceTokenEntries(storage, key, nowMs);
  if (entries.length === 0) {
    storage.removeItem(key);
    return [];
  }

  storage.setItem(key, JSON.stringify(entries));
  return entries.map((entry) => entry.token);
}

function readStoppedInstanceTokenEntries(storage: Storage, key: string, nowMs: number): StoppedInstanceToken[] {
  const raw = storage.getItem(key);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as Array<Partial<StoppedInstanceToken>>;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(
      (entry): entry is StoppedInstanceToken =>
        typeof entry.token === "string" &&
        typeof entry.expiresAt === "number" &&
        entry.expiresAt > nowMs,
    );
  } catch {
    return [];
  }
}
