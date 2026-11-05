import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configureRoomEnvironment,
  createMemoryRoomStorage,
  getRoomEnvironment,
  type RoomNotificationSink,
  type RoomRemovedHook,
} from "../src/client/room-environment.js";

describe("room environment defaults", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves storage, events and origin from the host global", () => {
    const environment = getRoomEnvironment();

    expect(environment.storage).toBe(globalThis.localStorage);
    expect(environment.events).toBe(globalThis);
    expect(environment.origin()).toBe(globalThis.location.origin);
    expect(environment.notifications).toBeNull();
    expect(environment.onRoomRemoved).toBeNull();
  });

  it("names the configuration call when the host has no storage", () => {
    vi.stubGlobal("localStorage", undefined);

    expect(() => getRoomEnvironment().storage).toThrow(/configureRoomEnvironment\(\{ storage \}\)/);
  });

  it("falls back to one private event target when the global cannot dispatch", () => {
    vi.stubGlobal("dispatchEvent", undefined);
    const events = getRoomEnvironment().events;
    const listener = vi.fn();
    events.addEventListener("ping", listener);

    expect(events).not.toBe(globalThis);
    expect(getRoomEnvironment().events).toBe(events);
    getRoomEnvironment().events.dispatchEvent(new Event("ping"));
    expect(listener).toHaveBeenCalledOnce();
    events.removeEventListener("ping", listener);
  });

  it("also falls back when the global can dispatch but not listen", () => {
    vi.stubGlobal("addEventListener", undefined);

    expect(getRoomEnvironment().events).not.toBe(globalThis);
  });

  it("uses an empty origin outside a browser location", () => {
    vi.stubGlobal("location", undefined);

    expect(getRoomEnvironment().origin()).toBe("");
  });
});

describe("configureRoomEnvironment", () => {
  it("overrides each service and resolves them on every property read", () => {
    const environment = getRoomEnvironment();
    const storage = createMemoryRoomStorage();
    const events = new EventTarget();
    const notifications: RoomNotificationSink = { record: vi.fn() };
    const onRoomRemoved: RoomRemovedHook = vi.fn();

    const restore = configureRoomEnvironment({ storage, events, origin: () => "https://app.example", notifications, onRoomRemoved });
    try {
      expect(environment.storage).toBe(storage);
      expect(environment.events).toBe(events);
      expect(environment.origin()).toBe("https://app.example");
      expect(environment.notifications).toBe(notifications);
      expect(environment.onRoomRemoved).toBe(onRoomRemoved);
    } finally {
      restore();
    }

    expect(environment.storage).toBe(globalThis.localStorage);
    expect(environment.notifications).toBeNull();
    expect(environment.onRoomRemoved).toBeNull();
  });

  it("merges over earlier configuration and restores each layer in turn", () => {
    const first = createMemoryRoomStorage();
    const events = new EventTarget();
    const restoreOuter = configureRoomEnvironment({ storage: first });
    const restoreInner = configureRoomEnvironment({ events });

    expect(getRoomEnvironment().storage).toBe(first);
    expect(getRoomEnvironment().events).toBe(events);

    restoreInner();
    expect(getRoomEnvironment().storage).toBe(first);
    expect(getRoomEnvironment().events).toBe(globalThis);

    restoreOuter();
    expect(getRoomEnvironment().storage).toBe(globalThis.localStorage);
  });
});

describe("createMemoryRoomStorage", () => {
  it("behaves like Web Storage for reads, writes, enumeration and removal", () => {
    const storage = createMemoryRoomStorage();

    expect(storage.length).toBe(0);
    expect(storage.key(0)).toBeNull();
    expect(storage.getItem("missing")).toBeNull();

    storage.setItem("a", "1");
    storage.setItem("b", 2 as unknown as string);

    expect(storage.length).toBe(2);
    expect(storage.key(0)).toBe("a");
    expect(storage.key(1)).toBe("b");
    expect(storage.key(2)).toBeNull();
    expect(storage.getItem("b")).toBe("2");

    storage.removeItem("a");
    storage.removeItem("never-set");

    expect(storage.length).toBe(1);
    expect(storage.getItem("a")).toBeNull();
  });

  it("seeds from initial entries and keeps separate instances isolated", () => {
    const seeded = createMemoryRoomStorage([["k", "v"]]);
    const other = createMemoryRoomStorage();

    other.setItem("k", "other");

    expect(seeded.getItem("k")).toBe("v");
    expect(seeded.length).toBe(1);
  });
});
