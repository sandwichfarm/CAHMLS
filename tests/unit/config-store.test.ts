import { beforeEach, describe, expect, test, vi } from "vitest";

import { ConfigStore, normalizeCoordinatorName } from "../../src/config/config.svelte";
import { DEFAULT_MAX_USERS } from "@cahmls/sdk/runtime";

const DEFAULT_PUBLIC_RELAYS = [
  "wss://relay2.contextvm.org",
  "wss://bucket.coracle.social",
  "wss://nos.lol",
];

describe("ConfigStore runtime limits", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  test("defaults announcement off and exposes incomplete setup coordinator options", () => {
    const store = new ConfigStore();

    expect(store.autostart).toBe(false);
    expect(store.setupState).toBe("incomplete");
    expect(store.isSetupComplete).toBe(false);
    expect(store.inviteRelayUrls).toEqual(DEFAULT_PUBLIC_RELAYS);
    expect(store.enabledRelayUrls).toEqual([...DEFAULT_PUBLIC_RELAYS, "ws://localhost:4870"]);
    expect(store.coordinatorOptions).toEqual({
      announce: false,
      maxUsers: DEFAULT_MAX_USERS,
      coordinatorName: "My coordinator",
    });

    store.setAnnouncement(true);

    expect(store.coordinatorOptions.announce).toBe(true);
  });

  test("persists the autostart preference", () => {
    const store = new ConfigStore();
    store.setAutostart(true);

    expect(new ConfigStore().autostart).toBe(true);
  });

  test("defaults to invisible and persists offline sleep state", () => {
    const store = new ConfigStore();
    expect(store.presenceState).toBe("invisible");

    store.setPresenceState("offline");
    expect(new ConfigStore().presenceState).toBe("offline");

    store.resetToDefaults();
    expect(store.presenceState).toBe("invisible");
  });

  test("persists presence without changing runtime configuration", () => {
    const store = new ConfigStore();
    const initialRuntimeRevision = store.runtimeRevision;
    const initialOptions = store.coordinatorOptions;

    store.setPresenceState("online");

    expect(store.presenceState).toBe("online");
    expect(store.runtimeRevision).toBe(initialRuntimeRevision);
    expect(store.coordinatorOptions).toEqual(initialOptions);
    expect(new ConfigStore().presenceState).toBe("online");
  });

  test("normalizes coordinator names by Unicode code points and rejects empty values", () => {
    expect(normalizeCoordinatorName("  Madeira node  ")).toBe("Madeira node");
    expect(normalizeCoordinatorName("   \n\t ")).toBeNull();
    expect(normalizeCoordinatorName(42)).toBeNull();
    expect(normalizeCoordinatorName("😀".repeat(49))).toBe("😀".repeat(48));
  });

  test("completes setup atomically and persists the normalized coordinator name", () => {
    const store = new ConfigStore();

    expect(store.completeSetup("  Madeira node  ")).toBe(true);
    expect(store.isSetupComplete).toBe(true);
    expect(store.coordinatorName).toBe("Madeira node");
    expect(JSON.parse(localStorage.getItem("cordn:v1:config") ?? "{}")).toMatchObject({
      coordinatorName: "Madeira node",
      setupCompleted: true,
    });

    const reloaded = new ConfigStore();
    expect(reloaded.setupState).toBe("complete");
    expect(reloaded.coordinatorOptions.coordinatorName).toBe("Madeira node");
  });

  test("commits first-run preferences together and survives reload", () => {
    const store = new ConfigStore();

    expect(store.completeFirstRunSetup({
      name: "  Recommended coordinator  ",
      relays: ["wss://relay.example.com", "wss://backup.example.com"],
      announce: false,
      autostart: true,
    })).toBe(true);

    const reloaded = new ConfigStore();
    expect(reloaded.isSetupComplete).toBe(true);
    expect(reloaded.coordinatorName).toBe("Recommended coordinator");
    expect(reloaded.inviteRelayUrls).toEqual(["wss://relay.example.com", "wss://backup.example.com"]);
    expect(reloaded.announce).toBe(false);
    expect(reloaded.autostart).toBe(true);
  });

  test.each([
    ["no relays", [], "Add at least one relay"],
    ["invalid relay", ["https://relay.example.com"], "Relay URL must start with ws:// or wss://"],
    ["insecure relay", ["ws://relay.example.com"], "Relay URL must start with wss://"],
    ["duplicate relays", ["wss://relay.example.com", "wss://relay.example.com"], "Relay URLs must be unique"],
  ])("rejects %s without partially completing first-run setup", (_case, relays, expectedError) => {
    const store = new ConfigStore();

    expect(store.completeFirstRunSetup({ name: "Draft", relays, announce: true, autostart: true })).toBe(false);
    expect(store.relayError).toBe(expectedError);
    expect(store.isSetupComplete).toBe(false);
    expect(store.coordinatorName).toBe("My coordinator");
    expect(store.announce).toBe(false);
    expect(store.autostart).toBe(false);
    expect(localStorage.getItem("cordn:v1:config")).toBeNull();
  });

  test("leaves first-run state and revisions unchanged when durable config storage fails", () => {
    const store = new ConfigStore();
    const before = {
      name: store.coordinatorName,
      relays: store.relays.map((relay) => ({ ...relay })),
      announce: store.announce,
      autostart: store.autostart,
      setupCompleted: store.setupCompleted,
      revision: store.revision,
      runtimeRevision: store.runtimeRevision,
    };
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("synthetic private failure"); });

    expect(store.completeFirstRunSetup({
      name: "Must remain a draft",
      relays: ["wss://relay.example.com"],
      announce: true,
      autostart: true,
    })).toBe(false);
    expect(store.setupError).toBe("Could not save coordinator setup");
    expect({
      name: store.coordinatorName,
      relays: store.relays.map((relay) => ({ ...relay })),
      announce: store.announce,
      autostart: store.autostart,
      setupCompleted: store.setupCompleted,
      revision: store.revision,
      runtimeRevision: store.runtimeRevision,
    }).toEqual(before);
    expect(localStorage.getItem("cordn:v1:config")).toBeNull();
  });

  test.each([
    ["meaningful legacy name", "  Existing coordinator  ", "complete", "Existing coordinator"],
    ["untouched default", "My coordinator", "incomplete", "My coordinator"],
    ["blank", "", "incomplete", "My coordinator"],
    ["whitespace-only", "  \n\t ", "incomplete", "My coordinator"],
    ["malformed", 42, "incomplete", "My coordinator"],
    ["overlong meaningful name", "é".repeat(49), "complete", "é".repeat(48)],
  ])("migrates %s legacy setup records exactly once", (_classification, coordinatorName, setupState, expectedName) => {
    localStorage.setItem(
      "cordn:v1:config",
      JSON.stringify({
        version: 1,
        relays: [],
        announce: false,
        maxUsers: DEFAULT_MAX_USERS,
        autostart: false,
        coordinatorName,
      }),
    );

    const migrated = new ConfigStore();

    expect(migrated.setupState).toBe(setupState);
    expect(migrated.coordinatorName).toBe(expectedName);
    expect(JSON.parse(localStorage.getItem("cordn:v1:config") ?? "{}").setupCompleted === true).toBe(
      setupState === "complete",
    );

    const reloaded = new ConfigStore();
    expect(reloaded.setupState).toBe(setupState);
  });

  test("persists validated coordinator names and marks running setup renames for restart", () => {
    const store = new ConfigStore();
    expect(store.completeSetup("First coordinator")).toBe(true);
    const initialOptions = store.coordinatorOptions;
    expect(store.setCoordinatorName("  Madeira node  ")).toBe(true);
    store.setUserName("River");
    store.setHostBadgeLabel("guide");
    store.setHostBadgeEmoji("🦉");

    expect(initialOptions.coordinatorName).toBe("First coordinator");
    expect(store.runtimeRevision).toBe(1);
    expect(store.coordinatorOptions.coordinatorName).toBe("Madeira node");
    expect(store.setCoordinatorName("  ")).toBe(false);
    expect(store.coordinatorName).toBe("Madeira node");
    const reloaded = new ConfigStore();
    expect(reloaded.coordinatorName).toBe("Madeira node");
    expect(reloaded.userName).toBe("River");
    expect(reloaded.hostBadgeLabel).toBe("guide");
    expect(reloaded.hostBadgeEmoji).toBe("🦉");

    store.setAnnouncement(true);
    expect(store.runtimeRevision).toBe(2);
  });

  test("always includes the local WebSocket relay in the active pool", () => {
    const store = new ConfigStore();
    for (const relay of [...store.relays]) store.removeRelay(relay.id);

    expect(store.enabledRelayUrls).toEqual(["ws://localhost:4870"]);
    expect(store.inviteRelayUrls).toEqual([]);

    store.addRelay("wss://relay.example");
    expect(store.enabledRelayUrls).toEqual(["wss://relay.example", "ws://localhost:4870"]);
    expect(store.inviteRelayUrls).toEqual(["wss://relay.example"]);
  });

  test("validates key-package quota without subscription telemetry coupling", () => {
    const store = new ConfigStore();

    expect(store.setMaxUsers(4)).toBe(true);
    expect(store.maxUsers).toBe(4);
    expect(store.limitError).toBeNull();
  });

  test("preserves relay edit behavior with runtime options present", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    const store = new ConfigStore();

    expect(store.addRelay("wss://relay.example")).toBe(true);
    expect(store.relays.at(-1)).toEqual({
      id: "00000000-0000-4000-8000-000000000001",
      url: "wss://relay.example",
      enabled: true,
    });
  });

  test("persists relay and runtime configuration across store instances", () => {
    const first = new ConfigStore();
    for (const relay of [...first.relays]) first.removeRelay(relay.id);
    expect(first.addRelay("wss://relay.example")).toBe(true);
    first.toggleRelay(first.relays[0].id);
    first.setAnnouncement(true);
    expect(first.setMaxUsers(12)).toBe(true);

    const second = new ConfigStore();

    expect(second.relays).toEqual([
      {
        id: expect.any(String),
        url: "wss://relay.example",
        enabled: false,
      },
    ]);
    expect(second.announce).toBe(true);
    expect(second.maxUsers).toBe(12);
  });

  test("ignores invalid persisted config entries", () => {
    localStorage.setItem(
      "cordn:v1:config",
      JSON.stringify({
        version: 1,
        relays: [
          { url: "javascript:alert(1)", enabled: true },
          { url: "wss://relay.valid.example", enabled: true },
        ],
        announce: true,
        maxUsers: 999,
      }),
    );

    const store = new ConfigStore();

    expect(store.relays.map((relay) => relay.url)).toEqual(["wss://relay.valid.example"]);
    expect(store.announce).toBe(true);
    expect(store.maxUsers).toBe(DEFAULT_MAX_USERS);
  });

  test("migrates the legacy Cordn relay that third-party secure clients cannot reach", () => {
    localStorage.setItem(
      "cordn:v1:config",
      JSON.stringify({
        version: 1,
        relays: [{ url: "wss://relay.contextvm.org", enabled: true }],
        announce: false,
        maxUsers: DEFAULT_MAX_USERS,
        autostart: false,
      }),
    );

    const store = new ConfigStore();

    expect(store.inviteRelayUrls).toEqual(DEFAULT_PUBLIC_RELAYS);
    expect(JSON.parse(localStorage.getItem("cordn:v1:config") ?? "{}").relays).toEqual([
      { url: "wss://relay2.contextvm.org", enabled: true },
      { url: "wss://bucket.coracle.social", enabled: true },
      { url: "wss://nos.lol", enabled: true },
    ]);
  });

  test("adds missing public defaults to an existing default relay set once", () => {
    localStorage.setItem(
      "cordn:v1:config",
      JSON.stringify({
        version: 1,
        relays: [
          { url: "wss://relay2.contextvm.org", enabled: true },
          { url: "wss://nos.lol", enabled: true },
        ],
        announce: false,
        maxUsers: DEFAULT_MAX_USERS,
        autostart: false,
      }),
    );

    const migrated = new ConfigStore();
    expect(migrated.inviteRelayUrls).toEqual(DEFAULT_PUBLIC_RELAYS);

    const coracleRelay = migrated.relays.find((relay) => relay.url === "wss://bucket.coracle.social");
    if (!coracleRelay) throw new Error("Expected Coracle relay after migration");
    migrated.removeRelay(coracleRelay.id);

    const reloaded = new ConfigStore();
    expect(reloaded.inviteRelayUrls).toEqual([
      "wss://relay2.contextvm.org",
      "wss://nos.lol",
    ]);
  });

  test("reset clears persisted config and restores defaults", () => {
    const store = new ConfigStore();
    store.removeRelay(store.relays[0].id);
    store.addRelay("wss://relay.example");
    store.setAnnouncement(true);

    store.resetToDefaults();
    const reloaded = new ConfigStore();

    expect(reloaded.relays.map((relay) => relay.url)).toEqual(DEFAULT_PUBLIC_RELAYS);
    expect(reloaded.announce).toBe(false);
    expect(reloaded.isSetupComplete).toBe(false);
  });
});
