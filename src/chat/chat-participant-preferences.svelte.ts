import { roomIdentityKey } from "./room-store";

export const CHAT_PARTICIPANT_PREFERENCES_STORAGE_KEY = "cordn:v1:chat-participant-preferences";

export type ParticipantHighlightName = "lime" | "gold" | "cyan" | "violet" | "rose";

export const PARTICIPANT_HIGHLIGHT_PALETTE = Object.freeze({
  lime: "#7cf59d",
  gold: "#f1f58f",
  cyan: "#86ddff",
  violet: "#c4a6ff",
  rose: "#ffaaa3",
} as const satisfies Record<ParticipantHighlightName, string>);

export interface ParticipantHighlight {
  name: ParticipantHighlightName;
  value: (typeof PARTICIPANT_HIGHLIGHT_PALETTE)[ParticipantHighlightName];
}

const HIGHLIGHT_NAMES = new Set<ParticipantHighlightName>(["lime", "gold", "cyan", "violet", "rose"]);

interface PersistedParticipantPreferences {
  version: 1;
  ignores: Record<string, true>;
  highlights?: Record<string, ParticipantHighlightName>;
}

interface ParticipantPreferenceState {
  ignores: Record<string, true>;
  highlights: Record<string, ParticipantHighlightName>;
}

export class ChatParticipantPreferencesStore {
  preferences = $state<ParticipantPreferenceState>(readPreferences());

  isIgnored(coordinatorPubkey: string, roomId: string, participantPubkey: string): boolean {
    const key = ignoreKey(coordinatorPubkey, roomId, participantPubkey);
    return key !== null && this.preferences.ignores[key] === true;
  }

  setIgnored(coordinatorPubkey: string, roomId: string, participantPubkey: string, ignored: boolean): void {
    const key = ignoreKey(coordinatorPubkey, roomId, participantPubkey);
    if (key === null) return;

    const ignores = { ...this.preferences.ignores };
    if (ignored) ignores[key] = true;
    else delete ignores[key];
    this.preferences = { ...this.preferences, ignores };
    persistPreferences(this.preferences);
  }

  highlightFor(participantPubkey: string): ParticipantHighlight | undefined {
    const pubkey = normalizePubkey(participantPubkey);
    const name = pubkey ? this.preferences.highlights[pubkey] : undefined;
    return name ? { name, value: PARTICIPANT_HIGHLIGHT_PALETTE[name] } : undefined;
  }

  setHighlight(participantPubkey: string, name: ParticipantHighlightName | undefined): void {
    const pubkey = normalizePubkey(participantPubkey);
    if (!pubkey || (name !== undefined && !HIGHLIGHT_NAMES.has(name))) return;

    const highlights = { ...this.preferences.highlights };
    if (name === undefined) delete highlights[pubkey];
    else highlights[pubkey] = name;
    this.preferences = { ...this.preferences, highlights };
    persistPreferences(this.preferences);
  }
}

function ignoreKey(coordinatorPubkey: string, roomId: string, participantPubkey: string): string | null {
  const coordinator = normalizePubkey(coordinatorPubkey);
  const participant = normalizePubkey(participantPubkey);
  if (!coordinator || !participant || !isRoomId(roomId)) return null;
  return `${roomIdentityKey(coordinator, roomId)}\u0000${participant}`;
}

function readPreferences(): ParticipantPreferenceState {
  const raw = getStoredValue();
  if (!raw) return emptyPreferences();

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.ignores)) return emptyPreferences();

    const ignores: Record<string, true> = {};
    for (const [key, value] of Object.entries(parsed.ignores)) {
      if (value === true && parseIgnoreKey(key) !== null) ignores[key] = true;
    }
    return { ignores, highlights: readHighlights(parsed.highlights) };
  } catch {
    return emptyPreferences();
  }
}

function emptyPreferences(): ParticipantPreferenceState {
  return { ignores: {}, highlights: {} };
}

function readHighlights(value: unknown): Record<string, ParticipantHighlightName> {
  if (value === undefined) return {};
  if (!isRecord(value)) return {};

  const highlights: Record<string, ParticipantHighlightName> = {};
  for (const [pubkey, name] of Object.entries(value)) {
    if (normalizePubkey(pubkey) === pubkey && typeof name === "string" && HIGHLIGHT_NAMES.has(name as ParticipantHighlightName)) {
      highlights[pubkey] = name as ParticipantHighlightName;
    }
  }
  return highlights;
}

function parseIgnoreKey(value: string): { coordinatorPubkey: string; roomId: string; participantPubkey: string } | null {
  const [coordinatorPubkey, roomId, participantPubkey, extra] = value.split("\u0000");
  if (extra !== undefined || !coordinatorPubkey || !participantPubkey || !isRoomId(roomId)) return null;
  const coordinator = normalizePubkey(coordinatorPubkey);
  const participant = normalizePubkey(participantPubkey);
  if (!coordinator || !participant) return null;
  if (value !== `${roomIdentityKey(coordinator, roomId)}\u0000${participant}`) return null;
  return { coordinatorPubkey: coordinator, roomId, participantPubkey: participant };
}

function normalizePubkey(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function isRoomId(value: string): boolean {
  return value.trim().length > 0 && !value.includes("\u0000");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function persistPreferences(state: ParticipantPreferenceState): void {
  try {
    if (Object.keys(state.ignores).length === 0 && Object.keys(state.highlights).length === 0) {
      localStorage.removeItem(CHAT_PARTICIPANT_PREFERENCES_STORAGE_KEY);
      return;
    }
    const persisted: PersistedParticipantPreferences = {
      version: 1,
      ignores: state.ignores,
      ...(Object.keys(state.highlights).length > 0 ? { highlights: state.highlights } : {}),
    };
    localStorage.setItem(CHAT_PARTICIPANT_PREFERENCES_STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // Preferences still apply for this session when browser storage is unavailable.
  }
}

function getStoredValue(): string | null {
  try {
    return localStorage.getItem(CHAT_PARTICIPANT_PREFERENCES_STORAGE_KEY);
  } catch {
    return null;
  }
}

export const chatParticipantPreferences = new ChatParticipantPreferencesStore();
