import { roomIdentityKey, type StoredRoom } from "./room-store";

export const SIDEBAR_LEDGER_KEY = "cordn:v1:sidebar-ledger";

export type SidebarHistoryReason = "coordinator-rotated" | "deleted" | "left" | "identity-retired";

export interface SidebarHistoryEntry {
  roomKey: string;
  roomId: string;
  coordinatorPubkey: string;
  coordinatorLabel: string;
  title: string;
  reason: SidebarHistoryReason;
  archivedAt: number;
}

export interface SidebarLedger {
  version: 1;
  coordinatorOrder: string[];
  roomOrder: Record<string, string[]>;
  history: SidebarHistoryEntry[];
  favorites: string[];
}

export interface SidebarProjection {
  ledger: SidebarLedger;
  activeRooms: StoredRoom[];
  history: SidebarHistoryEntry[];
}

export function emptySidebarLedger(): SidebarLedger {
  return { version: 1, coordinatorOrder: [], roomOrder: {}, history: [], favorites: [] };
}

export function parseSidebarLedger(raw: string | null): SidebarLedger {
  if (!raw) return emptySidebarLedger();
  try {
    const value = JSON.parse(raw) as Partial<SidebarLedger>;
    if (value.version !== 1) return emptySidebarLedger();
    const coordinatorOrder = Array.isArray(value.coordinatorOrder)
      ? uniqueStrings(value.coordinatorOrder)
      : [];
    const roomOrder: Record<string, string[]> = {};
    if (value.roomOrder && typeof value.roomOrder === "object") {
      for (const [pubkey, keys] of Object.entries(value.roomOrder)) {
        if (typeof pubkey === "string" && Array.isArray(keys)) roomOrder[pubkey] = uniqueStrings(keys);
      }
    }
    const history = Array.isArray(value.history)
      ? value.history.filter(isSidebarHistoryEntry).sort((left, right) => right.archivedAt - left.archivedAt)
      : [];
    const favorites = Array.isArray(value.favorites)
      ? uniqueStrings(value.favorites).filter(isCompositeRoomKey)
      : [];
    return { version: 1, coordinatorOrder, roomOrder, history, favorites };
  } catch {
    return emptySidebarLedger();
  }
}

export function reconcileSidebarLedger(
  ledger: SidebarLedger,
  rooms: readonly StoredRoom[],
  currentCoordinatorPubkey: string,
  currentCoordinatorLabel: string,
  now = Date.now(),
): SidebarProjection {
  const next = cloneLedger(ledger);
  const discovered = [...rooms].sort(compareDiscoveryOrder);
  const activeRooms: StoredRoom[] = [];

  for (const room of discovered) {
    const reason = historicalReason(room, currentCoordinatorPubkey);
    if (reason) {
      archiveSidebarRoom(next, room, reason, coordinatorLabel(room, currentCoordinatorPubkey, currentCoordinatorLabel), now);
      continue;
    }
    activeRooms.push(room);
    next.history = next.history.filter((entry) => entry.roomKey !== roomIdentityKey(room.coordinatorPubkey, room.id));
    if (room.coordinatorPubkey !== currentCoordinatorPubkey && !next.coordinatorOrder.includes(room.coordinatorPubkey)) {
      next.coordinatorOrder.push(room.coordinatorPubkey);
    }
    const order = next.roomOrder[room.coordinatorPubkey] ?? [];
    const key = roomIdentityKey(room.coordinatorPubkey, room.id);
    if (!order.includes(key)) order.push(key);
    next.roomOrder[room.coordinatorPubkey] = order;
  }

  const activeKeys = new Set(activeRooms.map((room) => roomIdentityKey(room.coordinatorPubkey, room.id)));
  for (const [pubkey, order] of Object.entries(next.roomOrder)) {
    next.roomOrder[pubkey] = order.filter((key) => activeKeys.has(key));
  }
  next.coordinatorOrder = next.coordinatorOrder.filter((pubkey) => activeRooms.some((room) => room.coordinatorPubkey === pubkey));
  next.favorites = next.favorites.filter((key) => activeKeys.has(key));

  const ordered = orderActiveRooms(activeRooms, next, currentCoordinatorPubkey);
  return { ledger: next, activeRooms: ordered, history: next.history };
}

export function isSidebarFavorite(
  ledger: SidebarLedger,
  room: Pick<StoredRoom, "id" | "coordinatorPubkey">,
): boolean {
  return ledger.favorites.includes(roomIdentityKey(room.coordinatorPubkey, room.id));
}

export function toggleSidebarFavorite(
  ledger: SidebarLedger,
  room: Pick<StoredRoom, "id" | "coordinatorPubkey">,
): SidebarLedger {
  const next = cloneLedger(ledger);
  const key = roomIdentityKey(room.coordinatorPubkey, room.id);
  next.favorites = next.favorites.includes(key)
    ? next.favorites.filter((candidate) => candidate !== key)
    : [...next.favorites, key];
  return next;
}

export function archiveSidebarRoom(
  ledger: SidebarLedger,
  room: Pick<StoredRoom, "id" | "title" | "coordinatorPubkey">,
  reason: SidebarHistoryReason,
  coordinatorLabel: string,
  archivedAt = Date.now(),
): SidebarLedger {
  const roomKey = roomIdentityKey(room.coordinatorPubkey, room.id);
  const existing = ledger.history.find((candidate) => candidate.roomKey === roomKey);
  const entry: SidebarHistoryEntry = {
    roomKey,
    roomId: room.id,
    coordinatorPubkey: room.coordinatorPubkey,
    coordinatorLabel,
    title: room.title,
    reason,
    archivedAt: existing?.archivedAt ?? archivedAt,
  };
  ledger.history = [entry, ...ledger.history.filter((candidate) => candidate.roomKey !== roomKey)]
    .sort((left, right) => right.archivedAt - left.archivedAt);
  const order = ledger.roomOrder[room.coordinatorPubkey];
  if (order) ledger.roomOrder[room.coordinatorPubkey] = order.filter((key) => key !== roomKey);
  return ledger;
}

export function serializeSidebarLedger(ledger: SidebarLedger): string {
  return JSON.stringify(ledger);
}

export function persistRemovedSidebarRoom(
  room: Pick<StoredRoom, "id" | "title" | "coordinatorPubkey">,
  reason: "deleted" | "left",
  coordinatorLabel: string,
): void {
  try {
    const ledger = parseSidebarLedger(localStorage.getItem(SIDEBAR_LEDGER_KEY));
    archiveSidebarRoom(ledger, room, reason, coordinatorLabel);
    localStorage.setItem(SIDEBAR_LEDGER_KEY, serializeSidebarLedger(ledger));
  } catch {
    // Room removal remains authoritative when optional presentation history is unavailable.
  }
}

export function historyReasonLabel(reason: SidebarHistoryReason): string {
  if (reason === "coordinator-rotated") return "Coordinator key rotated";
  if (reason === "identity-retired") return "Identity retired";
  if (reason === "deleted") return "Deleted";
  return "Left";
}

function orderActiveRooms(rooms: StoredRoom[], ledger: SidebarLedger, currentPubkey: string): StoredRoom[] {
  const coordinatorRank = new Map<string, number>([[currentPubkey, -1]]);
  ledger.coordinatorOrder.forEach((pubkey, index) => coordinatorRank.set(pubkey, index));
  const roomRanks = new Map<string, number>();
  for (const order of Object.values(ledger.roomOrder)) order.forEach((key, index) => roomRanks.set(key, index));
  return [...rooms].sort((left, right) => {
    const coordinatorDelta = (coordinatorRank.get(left.coordinatorPubkey) ?? Number.MAX_SAFE_INTEGER)
      - (coordinatorRank.get(right.coordinatorPubkey) ?? Number.MAX_SAFE_INTEGER);
    if (coordinatorDelta) return coordinatorDelta;
    return (roomRanks.get(roomIdentityKey(left.coordinatorPubkey, left.id)) ?? Number.MAX_SAFE_INTEGER)
      - (roomRanks.get(roomIdentityKey(right.coordinatorPubkey, right.id)) ?? Number.MAX_SAFE_INTEGER);
  });
}

function historicalReason(room: StoredRoom, currentPubkey: string): SidebarHistoryReason | null {
  if (room.membershipStatus === "retired") return "identity-retired";
  if (room.isHost && room.coordinatorPubkey !== currentPubkey) return "coordinator-rotated";
  return null;
}

function coordinatorLabel(room: StoredRoom, currentPubkey: string, currentLabel: string): string {
  if (room.coordinatorPubkey === currentPubkey) return currentLabel;
  return room.isHost ? `Previous local ${room.coordinatorPubkey.slice(0, 6)}` : `Coordinator ${room.coordinatorPubkey.slice(0, 6)}`;
}

function compareDiscoveryOrder(left: StoredRoom, right: StoredRoom): number {
  const leftCreated = left.createdAt ?? 0;
  const rightCreated = right.createdAt ?? 0;
  return leftCreated - rightCreated
    || roomIdentityKey(left.coordinatorPubkey, left.id).localeCompare(roomIdentityKey(right.coordinatorPubkey, right.id));
}

function cloneLedger(ledger: SidebarLedger): SidebarLedger {
  return {
    version: 1,
    coordinatorOrder: [...ledger.coordinatorOrder],
    roomOrder: Object.fromEntries(Object.entries(ledger.roomOrder).map(([pubkey, keys]) => [pubkey, [...keys]])),
    history: ledger.history.map((entry) => ({ ...entry })),
    favorites: [...ledger.favorites],
  };
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function isSidebarHistoryEntry(value: unknown): value is SidebarHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<SidebarHistoryEntry>;
  return typeof entry.roomKey === "string"
    && typeof entry.roomId === "string"
    && typeof entry.coordinatorPubkey === "string"
    && typeof entry.coordinatorLabel === "string"
    && typeof entry.title === "string"
    && ["coordinator-rotated", "deleted", "left", "identity-retired"].includes(entry.reason ?? "")
    && typeof entry.archivedAt === "number"
    && Number.isFinite(entry.archivedAt);
}

function isCompositeRoomKey(value: string): boolean {
  const separator = value.indexOf("\u0000");
  const coordinatorPubkey = value.slice(0, separator);
  return /^[0-9a-f]{64}$/i.test(coordinatorPubkey)
    && separator < value.length - 1
    && value.indexOf("\u0000", separator + 1) === -1;
}
