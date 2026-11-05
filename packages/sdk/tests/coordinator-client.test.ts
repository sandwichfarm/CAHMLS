import { Client } from "@contextvm/mcp-sdk/client";
import { NostrClientTransport } from "@contextvm/sdk/transport";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";

import {
  CHAT_COORDINATOR_CONNECT_TIMEOUT_MS,
  CHAT_COORDINATOR_REQUEST_TIMEOUT_MS,
  ChatCoordinatorClient,
} from "../src/client/coordinator-client.js";
import { CORDN_DEFAULT_RELAY_URLS } from "../src/client/invite.js";
import { BrowserNostrSigner } from "../src/crypto/browser-nostr-signer.js";
import { REQUIRED_LOCAL_RELAY_URL } from "../src/relay/relay-pool.js";

const COORDINATOR = "ab".repeat(32);

type TransportInternals = {
  signer: { getPublicKey(): Promise<string> };
  serverPubkey: string;
  relayHandler: { relayUrls?: string[] };
};

const ok = (structuredContent: unknown) => ({ content: [], structuredContent });

describe("ChatCoordinatorClient", () => {
  const secret = generateSecretKey();
  const signer = new BrowserNostrSigner(secret);
  let connect: MockInstance<Client["connect"]>;
  let callTool: MockInstance<Client["callTool"]>;
  let client: ChatCoordinatorClient;

  const lastCall = () => callTool.mock.lastCall!;
  /** Identify which logical channel made a call: the connect target of that Client. */
  const clientNames = () => callTool.mock.contexts.map((context) =>
    (context as unknown as { _clientInfo: { name: string } })._clientInfo.name);

  beforeEach(() => {
    connect = vi.spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
    callTool = vi.spyOn(Client.prototype, "callTool").mockResolvedValue(ok({}) as never);
    client = new ChatCoordinatorClient({ coordinatorPubkey: COORDINATOR, relayUrls: ["wss://relay.example"] }, signer);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await client.close();
    vi.restoreAllMocks();
  });

  describe("request shapes (public coordinator contract)", () => {
    test("publishKeyPackage sends kp_publish on the identity channel", async () => {
      await expect(client.publishKeyPackage("ref", "kp64")).resolves.toBeUndefined();

      expect(lastCall()[0]).toEqual({ name: "kp_publish", arguments: { kp_ref: "ref", kp_64: "kp64" } });
      expect(clientNames()).toEqual(["CvmMlsDeliveryServiceClient"]);
    });

    test("listOwnKeyPackageRefs reads kp_list on the identity channel", async () => {
      callTool.mockResolvedValueOnce(ok({ keyPackages: [{ pk: "p", kp_ref: "one", last_resort: true, at: 1 }, { pk: "p", kp_ref: "two", last_resort: false, at: 2 }] }) as never);

      await expect(client.listOwnKeyPackageRefs()).resolves.toEqual(["one", "two"]);

      expect(lastCall()[0]).toEqual({ name: "kp_list", arguments: {} });
      expect(clientNames()).toEqual(["CvmMlsDeliveryServiceClient"]);
    });

    test("storeJoinRequest includes an invite token only when there is one", async () => {
      await client.storeJoinRequest("gid", "ref");
      expect(lastCall()[0]).toEqual({ name: "join_request_store", arguments: { gid: "gid", kp_ref: "ref" } });

      await client.storeJoinRequest("gid", "ref", "");
      expect(lastCall()[0]).toEqual({ name: "join_request_store", arguments: { gid: "gid", kp_ref: "ref" } });

      await client.storeJoinRequest("gid", "ref", "token");
      expect(lastCall()[0]).toEqual({ name: "join_request_store", arguments: { gid: "gid", kp_ref: "ref", invite_token: "token" } });
      expect(new Set(clientNames())).toEqual(new Set(["CvmMlsDeliveryServiceClient"]));
    });

    test("fetchWelcomes uses the identity channel and only sends real acknowledgements", async () => {
      const welcomes = [{ kp_ref: "r", welcome_64: "w", at: 1 }];
      callTool.mockResolvedValue(ok({ welcomes }) as never);

      await expect(client.fetchWelcomes()).resolves.toEqual(welcomes);
      expect(lastCall()[0]).toEqual({ name: "welcome_take", arguments: {} });

      await client.fetchWelcomes([]);
      expect(lastCall()[0]).toEqual({ name: "welcome_take", arguments: {} });

      await client.fetchWelcomes([{ kp_ref: "r", at: 1 }]);
      expect(lastCall()[0]).toEqual({ name: "welcome_take", arguments: { consumed: [{ kp_ref: "r", at: 1 }] } });
      expect(new Set(clientNames())).toEqual(new Set(["CvmMlsDeliveryServiceClient"]));
    });

    test("fetchJoinRequests is anonymous and filters out other groups the server returns", async () => {
      callTool.mockResolvedValue(ok({
        requests: [
          { gid: "gid", pk: "a", kp_ref: "r1", at: 1 },
          { gid: "other", pk: "b", kp_ref: "r2", at: 2 },
          { pk: "c", kp_ref: "r3", at: 3 },
        ],
      }) as never);

      await expect(client.fetchJoinRequests("gid")).resolves.toEqual([{ gid: "gid", pk: "a", kp_ref: "r1", at: 1 }]);
      expect(lastCall()[0]).toEqual({ name: "join_request_take_many", arguments: { groups: [{ gid: "gid" }] } });

      await client.fetchJoinRequests("gid", []);
      expect(lastCall()[0]).toEqual({ name: "join_request_take_many", arguments: { groups: [{ gid: "gid" }] } });

      await client.fetchJoinRequests("gid", [{ pk: "a", at: 1 }]);
      expect(lastCall()[0]).toEqual({
        name: "join_request_take_many",
        arguments: { groups: [{ gid: "gid" }], consumed: [{ gid: "gid", pk: "a", at: 1 }] },
      });
      expect(new Set(clientNames())).toEqual(new Set(["CvmMlsDeliveryServiceClientEphemeral"]));
    });

    test("consumeKeyPackage returns the package or null", async () => {
      const keyPackage = { pk: "a", kp_ref: "r", event: { id: "e" } };
      callTool.mockResolvedValueOnce(ok({ keyPackage }) as never);
      await expect(client.consumeKeyPackage("id")).resolves.toEqual(keyPackage);
      expect(lastCall()[0]).toEqual({ name: "kp_take", arguments: { id: "id" } });

      callTool.mockResolvedValueOnce(ok({ keyPackage: null }) as never);
      await expect(client.consumeKeyPackage("id")).resolves.toBeNull();
      expect(new Set(clientNames())).toEqual(new Set(["CvmMlsDeliveryServiceClientEphemeral"]));
    });

    test("postGroupMessage returns the server's receipt", async () => {
      const receipt = { cursor: 3, gid: "gid", at: 9 };
      callTool.mockResolvedValue(ok(receipt) as never);

      await expect(client.postGroupMessage("gid", "msg")).resolves.toEqual(receipt);
      expect(lastCall()[0]).toEqual({ name: "msg_post", arguments: { gid: "gid", msg_64: "msg" } });
      expect(clientNames()).toEqual(["CvmMlsDeliveryServiceClientEphemeral"]);
    });

    test("storeWelcome passes every field, including a zero cursor", async () => {
      await expect(client.storeWelcome("pk", "ref", "w", 0)).resolves.toBeUndefined();

      expect(lastCall()[0]).toEqual({
        name: "welcome_store",
        arguments: { target_pk: "pk", kp_ref: "ref", welcome_64: "w", after: 0 },
      });
      expect(clientNames()).toEqual(["CvmMlsDeliveryServiceClientEphemeral"]);
    });

    test("fetchMessages omits a missing or zero cursor", async () => {
      const messages = [{ cursor: 1, gid: "gid", msg_64: "m", at: 1 }];
      callTool.mockResolvedValue(ok({ messages }) as never);

      await expect(client.fetchMessages("gid")).resolves.toEqual(messages);
      expect(lastCall()[0]).toEqual({ name: "msg_fetch_many", arguments: { groups: [{ gid: "gid" }] } });

      await client.fetchMessages("gid", 0);
      expect(lastCall()[0]).toEqual({ name: "msg_fetch_many", arguments: { groups: [{ gid: "gid" }] } });

      await client.fetchMessages("gid", 5);
      expect(lastCall()[0]).toEqual({ name: "msg_fetch_many", arguments: { groups: [{ gid: "gid", after: 5 }] } });
    });

    test("every request carries the timeout, abort signal and progress reset", async () => {
      await client.storeWelcome("pk", "ref", "w", 0);
      const [, , options] = lastCall();

      expect(options).toMatchObject({
        timeout: CHAT_COORDINATOR_REQUEST_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
        signal: expect.any(AbortSignal),
      });
      expect(options!.onprogress!({ progress: 1 })).toBeUndefined();
      expect(options!.signal!.aborted).toBe(false);
    });
  });

  describe("connection identity", () => {
    test("the identity channel signs as the user and the other channel as a throwaway key", async () => {
      await client.publishKeyPackage("ref", "kp");
      await client.storeWelcome("pk", "ref", "w", 0);

      expect(connect).toHaveBeenCalledTimes(2);
      const [stable, ephemeral] = connect.mock.calls.map(([transport]) => transport as unknown as TransportInternals);
      await expect(stable!.signer.getPublicKey()).resolves.toBe(getPublicKey(secret));
      await expect(ephemeral!.signer.getPublicKey()).resolves.not.toBe(getPublicKey(secret));
      expect(stable!.serverPubkey).toBe(COORDINATOR);
      expect(ephemeral!.serverPubkey).toBe(COORDINATOR);
      expect(connect.mock.calls[0]![1]).toEqual({ timeout: CHAT_COORDINATOR_CONNECT_TIMEOUT_MS });
    });

    test("two clients for one signer do not share an ephemeral identity", async () => {
      const other = new ChatCoordinatorClient({ coordinatorPubkey: COORDINATOR, relayUrls: [] }, signer);
      await client.storeWelcome("pk", "ref", "w", 0);
      await other.storeWelcome("pk", "ref", "w", 0);
      const [first, second] = connect.mock.calls.map(([transport]) => transport as unknown as TransportInternals);

      expect(await first!.signer.getPublicKey()).not.toBe(await second!.signer.getPublicKey());
      await other.close();
    });

    test("an explicit relay list is used plus the required local relay", async () => {
      await client.storeWelcome("pk", "ref", "w", 0);
      const transport = connect.mock.lastCall![0] as unknown as { relayHandler: { getRelayUrls(): string[] } };
      expect(transport.relayHandler.getRelayUrls()).toEqual(["wss://relay.example", REQUIRED_LOCAL_RELAY_URL]);
    });

    test("no relay hints fall back to the Cordn defaults", async () => {
      const fallback = new ChatCoordinatorClient({ coordinatorPubkey: COORDINATOR, relayUrls: [] }, signer);
      await fallback.storeWelcome("pk", "ref", "w", 0);
      const transport = connect.mock.lastCall![0] as unknown as { relayHandler: { getRelayUrls(): string[] } };
      expect(transport.relayHandler.getRelayUrls()).toEqual([...CORDN_DEFAULT_RELAY_URLS, REQUIRED_LOCAL_RELAY_URL]);
      await fallback.close();
    });
  });

  describe("connection reuse", () => {
    test("connects each channel once however many calls run", async () => {
      await Promise.all([
        client.storeWelcome("pk", "ref", "w", 0),
        client.storeWelcome("pk", "ref", "w", 1),
        client.publishKeyPackage("ref", "kp"),
        client.storeJoinRequest("g", "ref"),
      ]);
      await client.storeWelcome("pk", "ref", "w", 2);

      expect(connect).toHaveBeenCalledTimes(2);
      expect(callTool).toHaveBeenCalledTimes(5);
    });

    test.each([
      ["ephemeral", (c: ChatCoordinatorClient) => c.storeWelcome("pk", "ref", "w", 0)],
      ["stable", (c: ChatCoordinatorClient) => c.fetchWelcomes()],
    ])("a failed %s connection is retried by the next call and reports its cause", async (_kind, invoke) => {
      callTool.mockResolvedValue(ok({ welcomes: [] }) as never);
      connect.mockRejectedValueOnce(new Error("relay offline"));

      await expect(invoke(client)).rejects.toThrow("relay offline");
      expect(callTool).not.toHaveBeenCalled();

      await expect(invoke(client)).resolves.not.toThrow();
      expect(connect).toHaveBeenCalledTimes(2);
      expect(callTool).toHaveBeenCalledTimes(1);
    });

    test.each([
      ["ephemeral", (c: ChatCoordinatorClient) => c.storeWelcome("pk", "ref", "w", 0)],
      ["stable", (c: ChatCoordinatorClient) => c.fetchWelcomes()],
    ])("concurrent %s callers share one failed attempt without clobbering a newer one", async (_kind, invoke) => {
      callTool.mockResolvedValue(ok({ welcomes: [] }) as never);
      connect.mockRejectedValueOnce(new Error("relay offline"));

      const results = await Promise.allSettled([invoke(client), invoke(client)]);

      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(connect).toHaveBeenCalledTimes(1);

      await invoke(client);
      await invoke(client);
      expect(connect).toHaveBeenCalledTimes(2);
    });
  });

  describe("coordinator rejections", () => {
    test("surfaces the coordinator's error text", async () => {
      callTool.mockResolvedValue({
        isError: true,
        content: [{ type: "text", text: "quota exceeded" }, { type: "text", text: "try later" }],
      } as never);

      await expect(client.storeWelcome("pk", "ref", "w", 0)).rejects.toThrow("quota exceeded\ntry later");
    });

    test("skips non-text parts", async () => {
      callTool.mockResolvedValue({
        isError: true,
        content: [{ type: "image" }, { type: "text", text: "only this" }, { type: "text", text: "" }],
      } as never);

      await expect(client.storeWelcome("pk", "ref", "w", 0)).rejects.toThrow(/^only this$/);
    });

    test.each<[string, unknown]>([
      ["no content", undefined],
      ["empty content", []],
      ["only non-text content", [{ type: "image" }]],
    ])("names the tool when an error has %s", async (_label, content) => {
      callTool.mockResolvedValue({ isError: true, content } as never);

      await expect(client.storeWelcome("pk", "ref", "w", 0)).rejects.toThrow("Coordinator rejected welcome_store");
    });

    test("a transport failure on a non-idempotent call is not retried", async () => {
      callTool.mockRejectedValueOnce(new Error("timeout"));

      await expect(client.postGroupMessage("gid", "msg")).rejects.toThrow("timeout");
      expect(callTool).toHaveBeenCalledTimes(1);
    });
  });

  describe("idempotent write retries", () => {
    test.each([
      ["publishKeyPackage", (c: ChatCoordinatorClient) => c.publishKeyPackage("ref", "kp")],
      ["storeJoinRequest", (c: ChatCoordinatorClient) => c.storeJoinRequest("g", "ref")],
    ])("%s backs off 500ms then 1s and succeeds", async (_name, invoke) => {
      vi.useFakeTimers();
      callTool
        .mockRejectedValueOnce(new Error("lost"))
        .mockRejectedValueOnce(new Error("lost again"))
        .mockResolvedValueOnce(ok({}) as never);

      const write = invoke(client);
      await vi.advanceTimersByTimeAsync(0);
      expect(callTool).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(499);
      expect(callTool).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(callTool).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(999);
      expect(callTool).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(callTool).toHaveBeenCalledTimes(3);

      await expect(write).resolves.toBeUndefined();
    });

    test("gives up after three attempts with the last error", async () => {
      vi.useFakeTimers();
      callTool
        .mockRejectedValueOnce(new Error("first"))
        .mockRejectedValueOnce(new Error("second"))
        .mockRejectedValue(new Error("third"));

      const outcome = expect(client.publishKeyPackage("ref", "kp")).rejects.toThrow("third");
      await vi.advanceTimersByTimeAsync(10_000);
      await outcome;

      expect(callTool).toHaveBeenCalledTimes(3);
    });

    test("closing during a backoff ends it at once, without waiting or another attempt", async () => {
      vi.useFakeTimers();
      callTool.mockRejectedValue(new Error("lost"));

      const outcome = expect(client.storeJoinRequest("g", "ref")).rejects.toThrow("lost");
      await vi.advanceTimersByTimeAsync(0);
      expect(callTool).toHaveBeenCalledTimes(1);

      await client.close();
      await outcome;

      expect(callTool).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    test("a failure that arrives after close is not retried", async () => {
      vi.useFakeTimers();
      let fail!: (error: Error) => void;
      callTool.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));

      const outcome = expect(client.publishKeyPackage("ref", "kp")).rejects.toThrow("aborted");
      await vi.advanceTimersByTimeAsync(0);
      await client.close();
      fail(new Error("aborted"));
      await outcome;

      expect(callTool).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    test("retry timers are cleared after a normal backoff", async () => {
      vi.useFakeTimers();
      callTool.mockRejectedValueOnce(new Error("lost")).mockResolvedValueOnce(ok({}) as never);

      const write = client.publishKeyPackage("ref", "kp");
      await vi.advanceTimersByTimeAsync(500);
      await write;

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("close", () => {
    test("aborts in-flight requests through their signal", async () => {
      let signal: AbortSignal | undefined;
      callTool.mockImplementationOnce((_params, _schema, options) => {
        signal = options?.signal;
        return new Promise((_, reject) => {
          options!.signal!.addEventListener("abort", () => reject(new Error("request aborted")));
        });
      });

      const pending = client.fetchMessages("gid");
      await vi.waitFor(() => expect(signal).toBeDefined());
      await client.close();

      await expect(pending).rejects.toThrow("request aborted");
      expect(signal!.aborted).toBe(true);
    });

    test("closes both clients and both transports, tolerating failures", async () => {
      const closeClient = vi.spyOn(Client.prototype, "close").mockRejectedValue(new Error("client close failed"));
      const closeTransport = vi.spyOn(NostrClientTransport.prototype, "close").mockRejectedValue(new Error("transport close failed"));

      await expect(client.close()).resolves.toBeUndefined();

      expect(closeClient).toHaveBeenCalledTimes(2);
      expect(closeTransport).toHaveBeenCalledTimes(2);
    });

    test("every operation refuses to run afterwards, without connecting", async () => {
      await client.close();

      for (const call of [
        () => client.fetchWelcomes(),
        () => client.fetchJoinRequests("g"),
        () => client.consumeKeyPackage("id"),
        () => client.postGroupMessage("g", "m"),
        () => client.storeWelcome("pk", "r", "w", 0),
        () => client.fetchMessages("g"),
        () => client.publishKeyPackage("r", "k"),
        () => client.storeJoinRequest("g", "r"),
      ]) {
        await expect(call()).rejects.toThrow("Coordinator client is closed");
      }
      expect(connect).not.toHaveBeenCalled();
      expect(callTool).not.toHaveBeenCalled();
    });

    test("closing twice is safe", async () => {
      await client.close();
      await expect(client.close()).resolves.toBeUndefined();
    });
  });
});
