import { McpServer } from "@contextvm/mcp-sdk/server/mcp";
import type { JSONRPCMessage } from "@contextvm/mcp-sdk/types";
import type { RelayHandler } from "@contextvm/sdk/core";
import { NostrServerTransport, type OpenStreamWriter } from "@contextvm/sdk/transport";
import { bytesToHex } from "nostr-tools/utils";
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createKeyPackage } from "../src/client/protocol.js";
import { COORDINATOR_METHODS } from "../src/contracts/index.js";
import { InMemoryCoordinatorStorage } from "../src/coordinator/storage/inMemoryStorage.js";
import { encodeBase64 } from "../src/server/base64.js";
import {
  abortCancelledOpenStream,
  TransportFactory,
  transportFactory,
  type RunningTransport,
  type TransportDiagnostics,
} from "../src/server/transport.js";
import { createRequiredRelayPool, REQUIRED_LOCAL_RELAY_URL } from "../src/relay/relay-pool.js";
import { createBrowserCoordinatorStorage } from "../src/coordinator/storage/browserSqliteStorage.js";

// Expected failures would otherwise fill the output through the SDK's own logger.
vi.hoisted(() => {
  process.env.LOG_ENABLED = "false";
});

vi.mock("../src/relay/relay-pool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/relay/relay-pool.js")>()),
  createRequiredRelayPool: vi.fn(),
}));

vi.mock("../src/coordinator/storage/browserSqliteStorage.js", () => ({
  createBrowserCoordinatorStorage: vi.fn(),
}));

/** The Nostr kind ContextVM uses for its plain-text JSON-RPC messages. */
const CTXVM_MESSAGES_KIND = 25910;

class FakeRelay implements RelayHandler {
  readonly published: NostrEvent[] = [];
  readonly connect = vi.fn(async (): Promise<void> => undefined);
  readonly disconnect = vi.fn(async (): Promise<void> => undefined);
  readonly unsubscribe = vi.fn();
  readonly unsubscribeOne = vi.fn();
  readonly publish = vi.fn<RelayHandler["publish"]>(async (event) => {
    this.published.push(event);
  });
  deliver: (event: NostrEvent) => void = () => undefined;
  readonly subscribe = vi.fn<RelayHandler["subscribe"]>(async (_filters, onEvent) => {
    this.deliver = onEvent;
    return this.unsubscribeOne;
  });
  readonly getRelayUrls = vi.fn(() => ["wss://relay.example", REQUIRED_LOCAL_RELAY_URL]);

  /** JSON-RPC payloads the coordinator has answered with. */
  responses(): Array<Record<string, unknown>> {
    return this.published
      .filter((event) => event.kind === CTXVM_MESSAGES_KIND)
      .map((event) => JSON.parse(event.content) as Record<string, unknown>);
  }
}

type Inspectable = {
  relayHandler: RelayHandler;
  inboundMiddlewares: Array<
    (message: JSONRPCMessage, ctx: { clientPubkey: string }, forward: (message: JSONRPCMessage) => Promise<void>) => Promise<void>
  >;
  processIncomingEvent: (event: NostrEvent) => Promise<void>;
  publishEventToRelayUrls: (event: NostrEvent, relayUrls: string[]) => Promise<void>;
  getInternalStateForTesting: () => { openStreamWriters: Map<string, OpenStreamWriter> };
};

const inspect = (running: RunningTransport) => running.transport as unknown as Inspectable;

function recordingDiagnostics() {
  return {
    onStartupPhase: vi.fn<NonNullable<TransportDiagnostics["onStartupPhase"]>>(),
    onStarted: vi.fn<NonNullable<TransportDiagnostics["onStarted"]>>(),
    onNostrEvent: vi.fn<NonNullable<TransportDiagnostics["onNostrEvent"]>>(),
    onInboundMessage: vi.fn<NonNullable<TransportDiagnostics["onInboundMessage"]>>(),
    onNostrPublish: vi.fn<NonNullable<TransportDiagnostics["onNostrPublish"]>>(),
    onRelayPublish: vi.fn<NonNullable<TransportDiagnostics["onRelayPublish"]>>(),
    onOutboundMessage: vi.fn<NonNullable<TransportDiagnostics["onOutboundMessage"]>>(),
    onOutboundError: vi.fn<NonNullable<TransportDiagnostics["onOutboundError"]>>(),
    onClosed: vi.fn<NonNullable<TransportDiagnostics["onClosed"]>>(),
  };
}

const privateKey = generateSecretKey();
const privateKeyHex = bytesToHex(privateKey);
const coordinatorPubkey = getPublicKey(privateKey);
const clientKey = generateSecretKey();
const clientPubkey = getPublicKey(clientKey);

function request(id: number | string, method: string, params?: Record<string, unknown>): NostrEvent {
  return finalizeEvent(
    {
      kind: CTXVM_MESSAGES_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", coordinatorPubkey]],
      content: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
    },
    clientKey,
  );
}

function notification(method: string, params: Record<string, unknown>): NostrEvent {
  return finalizeEvent(
    {
      kind: CTXVM_MESSAGES_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", coordinatorPubkey]],
      content: JSON.stringify({ jsonrpc: "2.0", method, params }),
    },
    clientKey,
  );
}

const callTool = (id: number, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) =>
  request(id, "tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });

let relay: FakeRelay;
let started: RunningTransport[];

async function start(
  options: {
    diagnostics?: TransportDiagnostics;
    storage?: InMemoryCoordinatorStorage;
    maxUsers?: number;
    announce?: boolean;
    coordinatorName?: string;
    persistent?: boolean;
  } = {},
) {
  const storage = options.storage ?? new InMemoryCoordinatorStorage();
  const createStorage = vi.fn(() => storage);
  const running = await new TransportFactory({ createStorage }).create(
    privateKey,
    ["wss://relay.example"],
    {
      announce: options.announce ?? false,
      maxUsers: options.maxUsers ?? 8,
      ...(options.coordinatorName ? { coordinatorName: options.coordinatorName } : {}),
    },
    options.persistent ?? false,
    options.diagnostics,
  );
  started.push(running);
  return { running, storage, createStorage };
}

async function responseTo(id: number | string) {
  await vi.waitFor(() => expect(relay.responses().some((response) => response.id === id)).toBe(true));
  return relay.responses().find((response) => response.id === id) as {
    id: number | string;
    result?: { isError?: boolean; content?: unknown; structuredContent?: Record<string, unknown> };
    error?: { message: string };
  };
}

beforeEach(() => {
  relay = new FakeRelay();
  started = [];
  vi.mocked(createRequiredRelayPool).mockReset();
  vi.mocked(createRequiredRelayPool).mockImplementation(() => relay);
  // The SDK's own logger reports expected failures on the console.
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(() => undefined);
  }
});

afterEach(() => {
  for (const running of started) running.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TransportFactory startup", () => {
  test("reports its phases in order and connects to the relay pool", async () => {
    const diagnostics = recordingDiagnostics();

    const { running, createStorage } = await start({ diagnostics, persistent: true });

    expect(diagnostics.onStartupPhase.mock.calls.map(([details]) => details.phase)).toEqual([
      "opening-storage",
      "preparing-runtime",
      "connecting-relays",
    ]);
    expect(createStorage).toHaveBeenCalledWith(true, coordinatorPubkey);
    expect(diagnostics.onStarted).toHaveBeenCalledWith({
      publicKeyHex: coordinatorPubkey,
      relayUrls: ["wss://relay.example", REQUIRED_LOCAL_RELAY_URL],
    });
    expect(relay.connect).toHaveBeenCalledOnce();
    expect(relay.subscribe).toHaveBeenCalledOnce();
    expect(running.coordinator).toBeDefined();
    expect(running.adapter).toBeDefined();
    expect(running.server).toBeInstanceOf(McpServer);
    expect(running.transport).toBeInstanceOf(NostrServerTransport);
  });

  test("builds the relay pool with the full relay list and the relay diagnostics callback", async () => {
    const diagnostics = recordingDiagnostics();

    await start({ diagnostics });

    expect(createRequiredRelayPool).toHaveBeenCalledWith(["wss://relay.example", REQUIRED_LOCAL_RELAY_URL], {
      operation: "coordinator-response",
      onPublishDiagnostic: diagnostics.onRelayPublish,
    });
  });

  test("a coordinator with no configured relays still runs on the required local relay", async () => {
    const running = await new TransportFactory({ createStorage: () => new InMemoryCoordinatorStorage() }).create(
      privateKey,
      [],
      { announce: false, maxUsers: 8 },
      false,
    );
    started.push(running);

    expect(vi.mocked(createRequiredRelayPool).mock.calls[0]?.[0]).toEqual([REQUIRED_LOCAL_RELAY_URL]);
  });

  test("opens default browser storage when no factory is supplied", async () => {
    const storage = new InMemoryCoordinatorStorage();
    vi.mocked(createBrowserCoordinatorStorage).mockResolvedValue(storage as never);

    const running = await transportFactory.create(privateKey, ["wss://relay.example"], { announce: false, maxUsers: 8 }, true);
    started.push(running);

    expect(createBrowserCoordinatorStorage).toHaveBeenCalledWith(true, coordinatorPubkey);
  });

  test("accepts an asynchronous storage factory", async () => {
    const storage = new InMemoryCoordinatorStorage();
    const close = vi.spyOn(storage, "close");
    const running = await new TransportFactory({ createStorage: async () => storage }).create(
      privateKey,
      ["wss://relay.example"],
      { announce: false, maxUsers: 8 },
      false,
    );

    running.close();

    expect(close).toHaveBeenCalledOnce();
  });

  test("advertises the default coordinator name", async () => {
    const { running } = await start();

    expect((running.server.server as unknown as { _serverInfo: { name: string } })._serverInfo.name).toBe("cordn-browser");
  });

  test("announces a public coordinator with its name and quota through the bounded relay path", async () => {
    await start({ announce: true, coordinatorName: "my-coordinator", maxUsers: 3 });

    await vi.waitFor(() => expect(relay.published.length).toBeGreaterThan(0));
    const announcement = relay.published.find((event) => event.tags.some(([name, value]) =>
      name === "name" && value === "my-coordinator"));
    expect(announcement).toBeDefined();
    expect(JSON.stringify(announcement?.tags)).toContain("key package quota 3 per identity");
  });

  test("keeps discoverability publication on the lifecycle-owned relay handler", async () => {
    const { running } = await start();
    const event = request(1, "ping");

    await inspect(running).publishEventToRelayUrls(event, ["wss://bootstrap.example"]);

    expect(relay.publish).toHaveBeenCalledWith(event, undefined);
  });

  test("never reports the private key in any diagnostic", async () => {
    const diagnostics = recordingDiagnostics();
    await start({ diagnostics });

    relay.deliver(callTool(1, COORDINATOR_METHODS.fetchGroupMessages, { gid: "g" }));
    await responseTo(1);

    expect(JSON.stringify(Object.values(diagnostics).map((mock) => mock.mock.calls))).not.toContain(privateKeyHex);
  });
});

describe("TransportFactory startup failure", () => {
  const options = { announce: false, maxUsers: 8 };

  test("propagates a storage factory failure without starting anything", async () => {
    const diagnostics = recordingDiagnostics();

    await expect(
      new TransportFactory({ createStorage: () => Promise.reject(new Error("storage blocked")) }).create(
        privateKey,
        ["wss://relay.example"],
        options,
        false,
        diagnostics,
      ),
    ).rejects.toThrow("storage blocked");

    expect(createRequiredRelayPool).not.toHaveBeenCalled();
    expect(diagnostics.onStarted).not.toHaveBeenCalled();
  });

  test("a relay connection failure closes storage and the transport, and reports no start", async () => {
    const diagnostics = recordingDiagnostics();
    const storage = new InMemoryCoordinatorStorage();
    const close = vi.spyOn(storage, "close");
    relay.connect.mockRejectedValue(new Error("relay offline"));
    const transportClose = vi.spyOn(NostrServerTransport.prototype, "close");

    await expect(
      new TransportFactory({ createStorage: () => storage }).create(privateKey, ["wss://relay.example"], options, false, diagnostics),
    ).rejects.toThrow("relay offline");

    expect(close).toHaveBeenCalledOnce();
    expect(transportClose).toHaveBeenCalled();
    expect(diagnostics.onStarted).not.toHaveBeenCalled();
    expect(diagnostics.onOutboundError).toHaveBeenCalled();
  });

  test("a failing storage close does not mask the startup error or keep the transport open", async () => {
    const storage = new InMemoryCoordinatorStorage();
    vi.spyOn(storage, "close").mockImplementation(() => {
      throw new Error("close failed");
    });
    relay.connect.mockRejectedValue(new Error("relay offline"));
    const transportClose = vi.spyOn(NostrServerTransport.prototype, "close");
    const serverClose = vi.spyOn(McpServer.prototype, "close");

    await expect(
      new TransportFactory({ createStorage: () => storage }).create(privateKey, ["wss://relay.example"], options, false),
    ).rejects.toThrow("relay offline");

    expect(transportClose).toHaveBeenCalled();
    expect(serverClose).toHaveBeenCalledOnce();
  });

  test("closes storage directly when the coordinator could not be created", async () => {
    const storage = new InMemoryCoordinatorStorage();
    const close = vi.spyOn(storage, "close");
    vi.spyOn(globalThis, "setInterval").mockImplementationOnce(() => {
      throw new Error("no timers");
    });

    await expect(
      new TransportFactory({ createStorage: () => storage }).create(privateKey, ["wss://relay.example"], options, false),
    ).rejects.toThrow("no timers");

    expect(close).toHaveBeenCalledOnce();
    expect(createRequiredRelayPool).not.toHaveBeenCalled();
  });

  test("tolerates storage without a close method", async () => {
    const storage = new InMemoryCoordinatorStorage();
    Object.defineProperty(storage, "close", { value: undefined });
    vi.spyOn(globalThis, "setInterval").mockImplementationOnce(() => {
      throw new Error("no timers");
    });

    await expect(
      new TransportFactory({ createStorage: () => storage }).create(privateKey, ["wss://relay.example"], options, false),
    ).rejects.toThrow("no timers");
  });

  test("a diagnostics callback failing after storage opened still closes storage", async () => {
    const storage = new InMemoryCoordinatorStorage();
    const close = vi.spyOn(storage, "close");

    await expect(
      new TransportFactory({ createStorage: () => storage }).create(privateKey, ["wss://relay.example"], options, false, {
        onStartupPhase: ({ phase }) => {
          if (phase === "preparing-runtime") throw new Error("observer bug");
        },
      }),
    ).rejects.toThrow("observer bug");

    expect(close).toHaveBeenCalledOnce();
  });

  test("a transport close that throws during failure handling is contained", async () => {
    relay.connect.mockRejectedValue(new Error("relay offline"));
    vi.spyOn(NostrServerTransport.prototype, "close").mockImplementation(() => {
      throw new Error("sync close failure");
    });
    const serverClose = vi.spyOn(McpServer.prototype, "close");

    await expect(
      new TransportFactory({ createStorage: () => new InMemoryCoordinatorStorage() }).create(
        privateKey,
        ["wss://relay.example"],
        options,
        false,
      ),
    ).rejects.toThrow("relay offline");

    expect(serverClose).toHaveBeenCalledOnce();
  });
});

describe("running transport close", () => {
  test("closes every layer and reports closure", async () => {
    const diagnostics = recordingDiagnostics();
    const { running, storage } = await start({ diagnostics });
    const storageClose = vi.spyOn(storage, "close");
    const serverClose = vi.spyOn(running.server, "close");

    running.close();

    expect(storageClose).toHaveBeenCalledOnce();
    expect(serverClose).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(diagnostics.onClosed).toHaveBeenCalled());
    await vi.waitFor(() => expect(relay.unsubscribeOne).toHaveBeenCalled());
    await vi.waitFor(() => expect(relay.disconnect).toHaveBeenCalled());
  });

  test("reports closure once even though the server also closes its transport", async () => {
    const diagnostics = recordingDiagnostics();
    const { running } = await start({ diagnostics });

    running.close();
    await vi.waitFor(() => expect(diagnostics.onClosed).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(diagnostics.onClosed).toHaveBeenCalledOnce();
  });

  test("closes without any diagnostics configured", async () => {
    const { running } = await start();

    expect(() => running.close()).not.toThrow();
    await vi.waitFor(() => expect(relay.disconnect).toHaveBeenCalled());
  });

  test("a failing storage close does not keep the transport or server open", async () => {
    const { running, storage } = await start();
    vi.spyOn(storage, "close").mockImplementation(() => {
      throw new Error("close failed");
    });
    const transportClose = vi.spyOn(running.transport, "close");
    const serverClose = vi.spyOn(running.server, "close");

    expect(() => running.close()).not.toThrow();

    expect(transportClose).toHaveBeenCalled();
    expect(serverClose).toHaveBeenCalledOnce();
  });

  test("a transport close that rejects or throws does not keep the server open", async () => {
    const rejecting = await start();
    vi.spyOn(rejecting.running.transport, "close").mockRejectedValue(new Error("async failure"));
    const rejectingServerClose = vi.spyOn(rejecting.running.server, "close");
    expect(() => rejecting.running.close()).not.toThrow();
    expect(rejectingServerClose).toHaveBeenCalledOnce();

    const throwing = await start();
    vi.spyOn(throwing.running.transport, "close").mockImplementation(() => {
      throw new Error("sync failure");
    });
    const throwingServerClose = vi.spyOn(throwing.running.server, "close");
    expect(() => throwing.running.close()).not.toThrow();
    expect(throwingServerClose).toHaveBeenCalledOnce();
  });

  test("a server close that fails is contained", async () => {
    const { running } = await start();
    vi.spyOn(running.server, "close").mockRejectedValue(new Error("async failure"));

    expect(() => running.close()).not.toThrow();
    await vi.waitFor(() => expect(relay.disconnect).toHaveBeenCalled());
  });
});

describe("instrumented relay handler", () => {
  test("delegates its lifecycle to the relay pool", async () => {
    const { running } = await start();
    const handler = inspect(running).relayHandler;
    const onEvent = vi.fn();
    const onEose = vi.fn();
    const filters = [{ kinds: [1] }];

    await expect(handler.subscribe(filters, onEvent, onEose)).resolves.toBe(relay.unsubscribeOne);
    expect(relay.subscribe).toHaveBeenLastCalledWith(filters, onEvent, onEose);

    handler.unsubscribe();
    expect(relay.unsubscribe).toHaveBeenCalledOnce();

    expect(handler.getRelayUrls?.()).toEqual(["wss://relay.example", REQUIRED_LOCAL_RELAY_URL]);

    await handler.disconnect();
    expect(relay.disconnect).toHaveBeenCalled();
  });

  test("reports attempted and accepted publications, passing options through", async () => {
    const diagnostics = recordingDiagnostics();
    const { running } = await start({ diagnostics });
    diagnostics.onNostrPublish.mockClear();
    const event = request(1, "ping");
    const abortOptions = { abortSignal: new AbortController().signal };

    await inspect(running).relayHandler.publish(event, abortOptions);

    expect(relay.publish).toHaveBeenCalledWith(event, abortOptions);
    expect(diagnostics.onNostrPublish.mock.calls.map(([details]) => details.phase)).toEqual(["attempt", "accepted"]);
    expect(diagnostics.onNostrPublish.mock.calls[0]?.[0].summary).toContain(`kind=${CTXVM_MESSAGES_KIND}`);
  });

  test("does not report acceptance for a failed publication", async () => {
    const diagnostics = recordingDiagnostics();
    const { running } = await start({ diagnostics });
    diagnostics.onNostrPublish.mockClear();
    relay.publish.mockRejectedValueOnce(new Error("no relay accepted"));

    await expect(inspect(running).relayHandler.publish(request(1, "ping"))).rejects.toThrow("no relay accepted");

    expect(diagnostics.onNostrPublish.mock.calls.map(([details]) => details.phase)).toEqual(["attempt"]);
  });

  test("publishes without any diagnostics configured", async () => {
    const { running } = await start();

    await expect(inspect(running).relayHandler.publish(request(1, "ping"))).resolves.toBeUndefined();
  });
});

describe("Nostr event diagnostics", () => {
  function crafted(overrides: Partial<NostrEvent>): NostrEvent {
    return {
      id: "e".repeat(64),
      kind: 1,
      pubkey: "f".repeat(64),
      created_at: 1,
      tags: [],
      content: "",
      sig: "0".repeat(128),
      ...overrides,
    };
  }

  async function summarize(event: NostrEvent) {
    const diagnostics = recordingDiagnostics();
    const { running } = await start({ diagnostics });
    await inspect(running).processIncomingEvent(event);
    return diagnostics.onNostrEvent.mock.calls[0]?.[0].summary;
  }

  test("abbreviates long ids and omits empty tags and content", async () => {
    await expect(summarize(crafted({}))).resolves.toBe(
      `kind=1 id=eeeeeeee...eeeeeeee pubkey=ffffffff...ffffffff`,
    );
  });

  test("leaves ids of sixteen characters or fewer intact", async () => {
    await expect(summarize(crafted({ id: "a".repeat(16), pubkey: "b".repeat(16) }))).resolves.toBe(
      `kind=1 id=${"a".repeat(16)} pubkey=${"b".repeat(16)}`,
    );
  });

  test("reports only the first two fields of the first six tags", async () => {
    const tags = Array.from({ length: 8 }, (_, index) => ["t", `value${index}`, "ignored-third-field"]);

    const summary = await summarize(crafted({ tags }));

    expect(summary).toContain("tags=t=value0 t=value1 t=value2 t=value3 t=value4 t=value5");
    expect(summary).not.toContain("value6");
    expect(summary).not.toContain("ignored-third-field");
  });

  test("truncates long content", async () => {
    const summary = await summarize(crafted({ content: `${"x".repeat(180)}SECRET-TAIL` }));

    expect(summary).toContain(`content=${"x".repeat(180)}...`);
    expect(summary).not.toContain("SECRET-TAIL");
  });

  test("keeps content of exactly the limit whole", async () => {
    const summary = await summarize(crafted({ content: "x".repeat(180) }));

    expect(summary?.endsWith(`content=${"x".repeat(180)}`)).toBe(true);
  });

  test("processes events without any diagnostics configured", async () => {
    const { running } = await start();

    await expect(inspect(running).processIncomingEvent(crafted({}))).resolves.toBeUndefined();
  });

  test("processes the event after reporting it", async () => {
    const diagnostics = recordingDiagnostics();
    await start({ diagnostics });

    relay.deliver(request(1, "ping"));
    const response = await responseTo(1);

    expect(response.result).toEqual({});
    expect(diagnostics.onNostrEvent).toHaveBeenCalled();
  });
});

describe("inbound middleware", () => {
  async function middleware(diagnostics?: TransportDiagnostics) {
    const { running } = await start({ diagnostics });
    const inspectable = inspect(running);
    const writers = inspectable.getInternalStateForTesting().openStreamWriters;
    return {
      running,
      writers,
      run: async (message: JSONRPCMessage) => {
        const forward = vi.fn(async () => undefined);
        await inspectable.inboundMiddlewares[0]!(message, { clientPubkey: "client" }, forward);
        expect(forward).toHaveBeenCalledWith(message);
        return forward;
      },
    };
  }

  const toRequest = (params?: Record<string, unknown>, method = "tools/call", id: string | number = "req"): JSONRPCMessage =>
    ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) as JSONRPCMessage;

  function fakeWriter(isActive = true) {
    return { isActive, abort: vi.fn(async () => undefined), dispose: vi.fn() } as unknown as OpenStreamWriter & {
      abort: ReturnType<typeof vi.fn>;
    };
  }

  async function summary(message: JSONRPCMessage, setup?: (writers: Map<string, OpenStreamWriter>) => void) {
    const diagnostics = recordingDiagnostics();
    const { run, writers } = await middleware(diagnostics);
    setup?.(writers);
    await run(message);
    return { details: diagnostics.onInboundMessage.mock.calls[0]?.[0], writers };
  }

  test("reports a tool call by name and argument keys, never argument values", async () => {
    const { details } = await summary(toRequest({
      name: COORDINATOR_METHODS.postGroupMessage,
      arguments: { gid: "group-value", msg_64: "PAYLOAD-VALUE" },
    }));

    expect(details).toEqual({
      method: "tools/call",
      clientPubkey: "client",
      summary: `type=tools/call id=req params=name,arguments tool=${COORDINATOR_METHODS.postGroupMessage} args=gid,msg_64`,
    });
    expect(details?.summary).not.toContain("PAYLOAD-VALUE");
    expect(details?.summary).not.toContain("group-value");
  });

  test("limits a summary to the first eight keys", async () => {
    const args = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`k${index}`, 1]));

    const { details } = await summary(toRequest({ name: "tool", arguments: args }));

    expect(details?.summary).toContain("args=k0,k1,k2,k3,k4,k5,k6,k7");
    expect(details?.summary).not.toContain("k8");
  });

  test.each([
    ["no arguments", { name: "tool" }, "tool=tool"],
    ["null arguments", { name: "tool", arguments: null }, "tool=tool"],
    ["a non-string tool name", { name: 7 }, "params=name"],
  ])("handles a tool call with %s", async (_label, params, expected) => {
    const { details } = await summary(toRequest(params));

    expect(details?.summary).toContain(expected);
    expect(details?.summary).not.toContain("args=");
  });

  test("handles a request without params", async () => {
    const { details } = await summary(toRequest(undefined, "ping", 7));

    expect(details?.summary).toBe("type=ping id=7");
  });

  test("handles a request with params on a non-tool method", async () => {
    const { details } = await summary(toRequest({ name: "not-a-tool" }, "resources/read"));

    expect(details?.summary).toBe("type=resources/read id=req params=name");
  });

  test("reports a response as a response", async () => {
    const { details } = await summary({ jsonrpc: "2.0", id: 3, result: {} });

    expect(details).toMatchObject({ method: "response", summary: "type=result response id=3 result=" });
  });

  test("forwards without any diagnostics configured", async () => {
    const { run } = await middleware();

    await expect(run(toRequest({ name: "tool" }))).resolves.toBeDefined();
  });

  describe("unused open streams", () => {
    const eventId = "e".repeat(64);
    const withStream = (writers: Map<string, OpenStreamWriter>) => writers.set(eventId, fakeWriter());
    const meta = { requestEventId: eventId };

    test("disables the writer of a non-streaming tool call", async () => {
      const { details, writers } = await summary(
        toRequest({ name: COORDINATOR_METHODS.fetchGroupMessages, _meta: meta }),
        withStream,
      );

      expect(writers.has(eventId)).toBe(false);
      expect(details?.summary).toContain("disabled_unused_stream=eeeeeeee...eeeeeeee");
    });

    test("disables the writer of a non-tool request", async () => {
      const { writers } = await summary(toRequest({ _meta: meta }, "tools/list"), withStream);

      expect(writers.has(eventId)).toBe(false);
    });

    test.each([COORDINATOR_METHODS.subscribeGroupMessages, COORDINATOR_METHODS.subscribeManyGroupMessages])(
      "keeps the writer of the streaming tool %s",
      async (name) => {
        const { details, writers } = await summary(toRequest({ name, _meta: meta }), withStream);

        expect(writers.has(eventId)).toBe(true);
        expect(details?.summary).not.toContain("disabled_unused_stream");
      },
    );

    test("a streaming tool name on another method does not protect the writer", async () => {
      const { writers } = await summary(
        toRequest({ name: COORDINATOR_METHODS.subscribeGroupMessages, _meta: meta }, "tools/other"),
        withStream,
      );

      expect(writers.has(eventId)).toBe(false);
    });

    test.each([
      ["no metadata", {}],
      ["null metadata", { _meta: null }],
      ["non-object metadata", { _meta: "text" }],
      ["no request event id", { _meta: {} }],
      ["a non-string request event id", { _meta: { requestEventId: 7 } }],
      ["a request event id with no writer", { _meta: { requestEventId: "other" } }],
    ])("leaves writers alone with %s", async (_label, params) => {
      const { details, writers } = await summary(toRequest({ name: "tool", ...params }), withStream);

      expect(writers.has(eventId)).toBe(true);
      expect(details?.summary).not.toContain("disabled_unused_stream");
    });

    test("does not touch writers for a response", async () => {
      const { writers } = await summary({ jsonrpc: "2.0", id: eventId, result: {} }, withStream);

      expect(writers.has(eventId)).toBe(true);
    });
  });

  describe("cancellation notifications", () => {
    const cancelled = (params?: Record<string, unknown>): JSONRPCMessage =>
      ({ jsonrpc: "2.0", method: "notifications/cancelled", ...(params ? { params } : {}) }) as JSONRPCMessage;

    test("aborts the matching stream and reports it", async () => {
      const writer = fakeWriter();
      const { details } = await summary(
        cancelled({ requestId: "e".repeat(64), reason: "client left" }),
        (writers) => writers.set("e".repeat(64), writer),
      );

      expect(writer.abort).toHaveBeenCalledWith("client left");
      expect(details?.method).toBe("notifications/cancelled");
      expect(details?.summary).toContain(`requestId=${"e".repeat(64)}`);
      expect(details?.summary).toContain("reason=client left");
      expect(details?.summary).toContain("cancelled_stream=eeeeeeee...eeeeeeee");
    });

    test("accepts a numeric request id and truncates a long reason", async () => {
      const { details } = await summary(cancelled({ requestId: 42, reason: `${"r".repeat(180)}TAIL` }));

      expect(details?.summary).toContain("requestId=42");
      expect(details?.summary).toContain(`reason=${"r".repeat(180)}...`);
      expect(details?.summary).not.toContain("TAIL");
      expect(details?.summary).not.toContain("cancelled_stream");
    });

    test.each([
      ["an empty reason", { requestId: 1, reason: "" }, "requestId=1", "reason="],
      ["a non-string reason", { requestId: 1, reason: 9 }, "requestId=1", "reason="],
      ["a malformed request id", { requestId: { nested: true } }, "params=requestId", "requestId=["],
    ])("handles %s", async (_label, params, included, excluded) => {
      const { details } = await summary(cancelled(params));

      expect(details?.summary).toContain(included);
      expect(details?.summary).not.toContain(excluded);
    });

    test("handles a cancellation without params", async () => {
      const { details } = await summary(cancelled());

      expect(details?.summary).toBe("type=notifications/cancelled");
    });
  });
});

describe("abortCancelledOpenStream", () => {
  const cancelled = (params?: unknown): JSONRPCMessage =>
    ({ jsonrpc: "2.0", method: "notifications/cancelled", params }) as JSONRPCMessage;

  function transportWith(writers: Map<string, { isActive: boolean; abort: () => Promise<void> }>, correlationStore?: unknown) {
    return {
      getInternalStateForTesting: () => ({ openStreamWriters: writers, correlationStore }),
    } as never;
  }

  test("ignores other messages", async () => {
    const getState = vi.fn();

    await expect(
      abortCancelledOpenStream({ getInternalStateForTesting: getState } as never, { jsonrpc: "2.0", id: 1, result: {} }),
    ).resolves.toBeUndefined();
    await expect(
      abortCancelledOpenStream({ getInternalStateForTesting: getState } as never, { jsonrpc: "2.0", method: "other" } as JSONRPCMessage),
    ).resolves.toBeUndefined();

    expect(getState).not.toHaveBeenCalled();
  });

  test.each([
    ["missing params", undefined],
    ["null params", null],
    ["a non-object", "text"],
    ["no request id", {}],
    ["a boolean request id", { requestId: true }],
  ])("ignores a cancellation with %s", async (_label, params) => {
    const getState = vi.fn();

    await expect(
      abortCancelledOpenStream({ getInternalStateForTesting: getState } as never, cancelled(params)),
    ).resolves.toBeUndefined();

    expect(getState).not.toHaveBeenCalled();
  });

  test.each([
    ["no reason", {}],
    ["an empty reason", { reason: "" }],
    ["a non-string reason", { reason: 5 }],
  ])("falls back to a generic reason with %s", async (_label, extra) => {
    const abort = vi.fn(async () => undefined);
    const transport = transportWith(new Map([["event", { isActive: true, abort }]]));

    await expect(abortCancelledOpenStream(transport, cancelled({ requestId: "event", ...extra }))).resolves.toBe("event");

    expect(abort).toHaveBeenCalledWith("cancelled");
  });

  test("matches a numeric JSON-RPC request id through the correlation store", async () => {
    const abort = vi.fn(async () => undefined);
    const routes = new Map<string, { originalRequestId: number }>([["event", { originalRequestId: 12 }]]);
    const transport = transportWith(
      new Map([
        ["other", { isActive: true, abort: vi.fn() }],
        ["event", { isActive: true, abort }],
      ]),
      { getEventRoute: (id: string) => routes.get(id) },
    );

    await expect(abortCancelledOpenStream(transport, cancelled({ requestId: 12 }))).resolves.toBe("event");

    expect(abort).toHaveBeenCalledOnce();
  });

  test("works without a correlation store", async () => {
    const abort = vi.fn(async () => undefined);
    const transport = transportWith(new Map([["event", { isActive: true, abort }]]));

    await expect(abortCancelledOpenStream(transport, cancelled({ requestId: "unknown" }))).resolves.toBeUndefined();

    expect(abort).not.toHaveBeenCalled();
  });

  test("surfaces a failing abort to the caller", async () => {
    const transport = transportWith(new Map([["event", { isActive: true, abort: () => Promise.reject(new Error("publish failed")) }]]));

    await expect(abortCancelledOpenStream(transport, cancelled({ requestId: "event" }))).rejects.toThrow("publish failed");
  });
});

describe("outbound messages", () => {
  async function sent(message: JSONRPCMessage) {
    const diagnostics = recordingDiagnostics();
    vi.spyOn(NostrServerTransport.prototype, "send").mockResolvedValue(undefined);
    const { running } = await start({ diagnostics });

    await running.transport.send(message);

    return diagnostics.onOutboundMessage.mock.calls[0]?.[0];
  }

  test("summarizes a result with its routing fields and no message content", async () => {
    await expect(
      sent({
        jsonrpc: "2.0",
        id: 4,
        result: {
          content: [],
          structuredContent: { cursor: 9, gid: "group", at: 100, msg_64: "PAYLOAD-VALUE" },
        },
      }),
    ).resolves.toEqual({
      type: "result response",
      summary: "type=result response id=4 result=content,structuredContent structured=cursor,gid,at,msg_64 cursor=9 gid=group at=100",
      error: undefined,
    });
  });

  test("reports booleans and skips routing fields of other types", async () => {
    const details = await sent({
      jsonrpc: "2.0",
      id: 4,
      result: { structuredContent: { cursor: { nested: true }, gid: false } },
    });

    expect(details?.summary).toContain("gid=false");
    expect(details?.summary).not.toContain("cursor=");
  });

  test.each([
    ["no structured content", { content: [] }, "result=content"],
    ["null structured content", { structuredContent: null }, "result=structuredContent"],
    ["scalar structured content", { structuredContent: "text" }, "result=structuredContent"],
  ])("summarizes a result with %s", async (_label, result, expected) => {
    const details = await sent({ jsonrpc: "2.0", id: 4, result } as JSONRPCMessage);

    expect(details?.summary).toContain(expected);
    expect(details?.summary).not.toContain("structured=");
  });

  test("tolerates a null result", async () => {
    const details = await sent({ jsonrpc: "2.0", id: 4, result: null } as unknown as JSONRPCMessage);

    expect(details?.summary).toBe("type=result response id=4");
  });

  test("reports an error response and truncates its message in the summary", async () => {
    const message = `${"m".repeat(180)}TAIL`;

    const details = await sent({ jsonrpc: "2.0", id: 5, error: { code: -1, message } });

    expect(details).toMatchObject({ type: "error response", error: message });
    expect(details?.summary).toBe(`type=error response id=5 error=${"m".repeat(180)}...`);
  });

  test("reports a notification by method", async () => {
    const details = await sent({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } });

    expect(details).toMatchObject({
      type: "notifications/progress",
      summary: "type=notifications/progress params=progress",
    });
  });

  test("tolerates non-object params", async () => {
    const details = await sent({ jsonrpc: "2.0", method: "note", params: "text" } as unknown as JSONRPCMessage);

    expect(details?.summary).toBe("type=note");
  });

  test.each([
    ["an Error", new Error("publish failed"), "publish failed"],
    ["a non-Error", "publish failed", "publish failed"],
  ])("reports and rethrows a send failure that is %s", async (_label, failure, message) => {
    const diagnostics = recordingDiagnostics();
    vi.spyOn(NostrServerTransport.prototype, "send").mockRejectedValue(failure);
    const { running } = await start({ diagnostics });

    await expect(running.transport.send({ jsonrpc: "2.0", id: 1, result: {} })).rejects.toBe(failure);

    expect(diagnostics.onOutboundMessage).not.toHaveBeenCalled();
    expect(diagnostics.onOutboundError).toHaveBeenCalledOnce();
    const reported = diagnostics.onOutboundError.mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(Error);
    expect(reported?.message).toBe(message);
  });

  test("forwards transport errors to diagnostics", async () => {
    const diagnostics = recordingDiagnostics();
    const { running } = await start({ diagnostics });
    const failure = new Error("transport failure");

    running.transport.onerror?.(failure);

    expect(diagnostics.onOutboundError).toHaveBeenCalledWith(failure);
  });

  test("send, send failures and transport errors work without diagnostics", async () => {
    const send = vi.spyOn(NostrServerTransport.prototype, "send").mockResolvedValue(undefined);
    const { running } = await start();

    await expect(running.transport.send({ jsonrpc: "2.0", id: 1, result: {} })).resolves.toBeUndefined();

    send.mockRejectedValueOnce(new Error("publish failed"));
    await expect(running.transport.send({ jsonrpc: "2.0", id: 1, result: {} })).rejects.toThrow("publish failed");

    expect(() => running.transport.onerror?.(new Error("transport failure"))).not.toThrow();
  });
});

describe("requests over the coordinator transport", () => {
  test("advertises the Cordn tools", async () => {
    await start();

    relay.deliver(request(1, "tools/list"));
    const response = await responseTo(1);

    const names = ((response.result as unknown as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
    expect(names.sort()).toEqual(Object.values(COORDINATOR_METHODS).sort());
  });

  test("binds a post to the signer's pubkey, ignoring a forged one in the request", async () => {
    const { running } = await start();

    relay.deliver(callTool(
      1,
      COORDINATOR_METHODS.postGroupMessage,
      { gid: "g", msg_64: encodeBase64(Uint8Array.from([1])) },
      { clientPubkey: "f".repeat(64) },
    ));
    const response = await responseTo(1);

    expect(response.result?.structuredContent).toMatchObject({ cursor: 1, gid: "g" });
    expect(running.coordinator.fetchGroupMessages({ groupId: "g" })[0]?.ephemeralSenderPubkey).toBe(clientPubkey);
  });

  test("stores a key package with the verified inbound request as its publication event", async () => {
    const generated = await createKeyPackage(clientPubkey);
    const { running } = await start();
    const event = callTool(1, COORDINATOR_METHODS.publishKeyPackage, {
      kp_ref: generated.stored.reference,
      kp_64: generated.stored.publicBase64,
    });

    relay.deliver(event);
    const response = await responseTo(1);

    expect(response.result?.structuredContent).toMatchObject({ kp_ref: generated.stored.reference, last_resort: false });
    expect(running.coordinator.getKeyPackage(generated.stored.reference)?.publicationEvent.id).toBe(event.id);
  });

  test("rejects a key package when the transport holds no such request event", async () => {
    const generated = await createKeyPackage(clientPubkey);
    const { running } = await start();

    await expect(
      running.adapter.publishKeyPackage(
        { kp_ref: generated.stored.reference, kp_64: generated.stored.publicBase64 },
        { _meta: { clientPubkey, requestEventId: "unknown-event" } },
      ),
    ).rejects.toThrow("Missing publication event");
  });

  test("applies maxUsers as the per-identity key package quota, without logging rejections", async () => {
    const [first, second] = await Promise.all([createKeyPackage(clientPubkey), createKeyPackage(clientPubkey)]);
    await start({ maxUsers: 1 });

    relay.deliver(callTool(1, COORDINATOR_METHODS.publishKeyPackage, { kp_ref: first.stored.reference, kp_64: first.stored.publicBase64 }));
    await responseTo(1);
    relay.deliver(callTool(2, COORDINATOR_METHODS.publishKeyPackage, { kp_ref: second.stored.reference, kp_64: second.stored.publicBase64 }));
    const response = await responseTo(2);

    expect(response.result?.isError).toBe(true);
    expect(JSON.stringify(response.result?.content)).toContain("Key package quota exceeded");
  });

  test("reports inbound and outbound messages for one request", async () => {
    const diagnostics = recordingDiagnostics();
    await start({ diagnostics });
    diagnostics.onNostrPublish.mockClear();

    relay.deliver(callTool(1, COORDINATOR_METHODS.fetchGroupMessages, { gid: "g" }));
    await responseTo(1);

    await vi.waitFor(() => expect(diagnostics.onOutboundMessage).toHaveBeenCalled());
    expect(diagnostics.onInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "tools/call",
        clientPubkey,
        summary: expect.stringContaining(`tool=${COORDINATOR_METHODS.fetchGroupMessages}`),
      }),
    );
    expect(diagnostics.onOutboundMessage.mock.calls[0]?.[0]).toMatchObject({ type: "result response" });
    expect(diagnostics.onNostrPublish.mock.calls.map(([details]) => details.phase)).toEqual(["attempt", "accepted"]);
  });

  test("a non-streaming request carrying a progress token gets its response immediately", async () => {
    const diagnostics = recordingDiagnostics();
    const { running } = await start({ diagnostics });

    relay.deliver(callTool(1, COORDINATOR_METHODS.fetchGroupMessages, { gid: "g" }, { progressToken: "token" }));
    const response = await responseTo(1);

    expect(response.result?.structuredContent).toEqual({ messages: [] });
    expect(inspect(running).getInternalStateForTesting().openStreamWriters.size).toBe(0);
    expect(diagnostics.onInboundMessage.mock.calls[0]?.[0].summary).toContain("disabled_unused_stream=");
  });

  test("streams a subscription and aborts it when the client cancels", async () => {
    const diagnostics = recordingDiagnostics();
    const { running } = await start({ diagnostics });
    const setSubscriptionMetrics = vi.fn();
    running.adapter.setTelemetrySink({ setSubscriptionMetrics });

    relay.deliver(callTool(7, COORDINATOR_METHODS.subscribeGroupMessages, { gid: "g" }, { progressToken: "token" }));
    await vi.waitFor(() => expect(running.coordinator.getActiveSubscriptionMetrics().activeStreams).toBe(1));
    await vi.waitFor(() =>
      expect(relay.responses().some((message) => message.method === "notifications/progress")).toBe(true));

    relay.deliver(notification("notifications/cancelled", { requestId: 7, reason: "client left" }));

    await vi.waitFor(() => expect(running.coordinator.getActiveSubscriptionMetrics().activeStreams).toBe(0));
    await vi.waitFor(() => {
      const cancellation = diagnostics.onInboundMessage.mock.calls
        .map(([details]) => details)
        .find((details) => details.method === "notifications/cancelled");
      expect(cancellation?.summary).toContain("cancelled_stream=");
      expect(cancellation?.summary).toContain("reason=client left");
    });
    expect(setSubscriptionMetrics).toHaveBeenLastCalledWith({ activeStreams: 0, groupLegs: 0 });
  });

  test("closing the transport releases a live subscription", async () => {
    const { running } = await start();

    relay.deliver(callTool(7, COORDINATOR_METHODS.subscribeGroupMessages, { gid: "g" }, { progressToken: "token" }));
    await vi.waitFor(() => expect(running.coordinator.getActiveSubscriptionMetrics().activeStreams).toBe(1));
    await vi.waitFor(() =>
      expect(relay.responses().some((message) => message.method === "notifications/progress")).toBe(true));

    running.close();

    await vi.waitFor(() => expect(running.coordinator.getActiveSubscriptionMetrics().activeStreams).toBe(0));
  });
});
