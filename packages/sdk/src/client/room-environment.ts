import type { StoredRoom } from "./room-store.js";

/** The subset of the Web Storage API the room store requires. */
export interface RoomStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Metadata-only notification emitted by a room session. Never carries message content. */
export type RoomNotification =
  | { category: "join_request"; key: string; room: string; action: "waiting" | "joined" }
  | {
      category: "new_message";
      key: string;
      actor: string;
      room: string;
      roomKey: string;
      actorPubkey: string;
    };

export interface RoomNotificationSink {
  record(notification: RoomNotification): void;
}

export type RoomRemovalReason = "deleted" | "left";

/** Called with the persisted record immediately before an exact room is removed. */
export type RoomRemovedHook = (room: StoredRoom, reason: RoomRemovalReason, coordinatorLabel: string) => void;

/** Everything the room store needs from its host application. */
export interface RoomEnvironment {
  /** Durable room storage. Defaults to `globalThis.localStorage`. */
  storage: RoomStorage;
  /** Target for room events and `online`/`offline` signals. Defaults to `globalThis` when it is an event target. */
  events: EventTarget;
  /** Origin recorded on newly created rooms. Defaults to `globalThis.location.origin`. */
  origin(): string;
  /** Optional sink for metadata-only notifications. */
  notifications: RoomNotificationSink | null;
  /** Optional hook that lets an application archive removed rooms. */
  onRoomRemoved: RoomRemovedHook | null;
}

const fallbackEvents = new EventTarget();

function defaultStorage(): RoomStorage {
  const storage = (globalThis as { localStorage?: RoomStorage }).localStorage;
  if (!storage) {
    throw new Error("No room storage is available; call configureRoomEnvironment({ storage })");
  }
  return storage;
}

function defaultEvents(): EventTarget {
  const candidate = globalThis as unknown as Partial<EventTarget>;
  return typeof candidate.dispatchEvent === "function" && typeof candidate.addEventListener === "function"
    ? (globalThis as unknown as EventTarget)
    : fallbackEvents;
}

function defaultOrigin(): string {
  return (globalThis as { location?: { origin?: string } }).location?.origin ?? "";
}

let overrides: Partial<RoomEnvironment> = {};

const environment: RoomEnvironment = {
  get storage() {
    return overrides.storage ?? defaultStorage();
  },
  get events() {
    return overrides.events ?? defaultEvents();
  },
  origin() {
    return overrides.origin ? overrides.origin() : defaultOrigin();
  },
  get notifications() {
    return overrides.notifications ?? null;
  },
  get onRoomRemoved() {
    return overrides.onRoomRemoved ?? null;
  },
};

/** Return the live environment. Values are resolved on each property read. */
export function getRoomEnvironment(): RoomEnvironment {
  return environment;
}

/**
 * Merge application services into the process-wide room environment. The
 * returned function restores the previous configuration.
 */
export function configureRoomEnvironment(next: Partial<RoomEnvironment>): () => void {
  const previous = overrides;
  overrides = { ...previous, ...next };
  return () => {
    overrides = previous;
  };
}

/** Volatile Web-Storage-compatible store for tests and non-browser hosts. */
export function createMemoryRoomStorage(initial: Iterable<[string, string]> = []): RoomStorage {
  const values = new Map<string, string>(initial);
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, String(value));
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}
