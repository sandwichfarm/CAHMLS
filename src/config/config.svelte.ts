import {
  DEFAULT_MAX_USERS,
  normalizeCoordinatorName,
  validateMaxUsers,
  validateRelayUrl,
  validateShareableRelayUrl,
} from "@cahmls/sdk/runtime";
import { shareableRelayUrls, withRequiredLocalRelay } from "@cahmls/sdk/relay";

const CONFIG_STORAGE_KEY = "cordn:v1:config";
const CONFIG_STORAGE_VERSION = 1;
const DEFAULT_RELAY_SET_VERSION = 1;
const LEGACY_DEFAULT_RELAY_URL = "wss://relay.contextvm.org";
const DEFAULT_RELAYS: RelayConfig[] = [
  { id: "default-relay-contextvm-2", url: "wss://relay2.contextvm.org", enabled: true },
  { id: "default-relay-coracle-bucket", url: "wss://bucket.coracle.social", enabled: true },
  { id: "default-relay-nos-lol", url: "wss://nos.lol", enabled: true },
];

export interface RelayConfig {
  id: string;
  url: string;
  enabled: boolean;
}

export interface BrowserCoordinatorOptions {
  announce: boolean;
  maxUsers: number;
  coordinatorName: string;
}

export interface FirstRunSetupOptions {
  name: unknown;
  relays: string[];
  announce: boolean;
  autostart: boolean;
}

export type PresenceState = "online" | "invisible" | "offline";

interface PersistedConfig {
  version: typeof CONFIG_STORAGE_VERSION;
  relaySetVersion?: number;
  relays: Array<Pick<RelayConfig, "url" | "enabled">>;
  announce: boolean;
  maxUsers: number;
  autostart: boolean;
  coordinatorName?: string;
  setupCompleted?: boolean;
  userName?: string;
  hostBadgeLabel?: string;
  hostBadgeEmoji?: string;
  presenceState?: PresenceState;
}

export class ConfigStore {
  relays = $state<RelayConfig[]>(cloneDefaultRelays());
  editMode = $state(false);
  relayError = $state<string | null>(null);
  setupError = $state<string | null>(null);
  limitError = $state<string | null>(null);
  announce = $state(false);
  maxUsers = $state(DEFAULT_MAX_USERS);
  autostart = $state(false);
  coordinatorName = $state("My coordinator");
  setupCompleted = $state(false);
  userName = $state("");
  hostBadgeLabel = $state("host");
  hostBadgeEmoji = $state("🛡️");
  presenceState = $state<PresenceState>("invisible");
  revision = $state(0);
  runtimeRevision = $state(0);

  constructor() {
    this.loadPersistedConfig();
  }

  get enabledRelayUrls(): string[] {
    return withRequiredLocalRelay(this.relays.filter((relay) => relay.enabled).map((relay) => relay.url));
  }

  get inviteRelayUrls(): string[] {
    return shareableRelayUrls(this.relays.filter((relay) => relay.enabled).map((relay) => relay.url));
  }

  get coordinatorOptions(): BrowserCoordinatorOptions {
    return {
      announce: this.announce,
      maxUsers: this.maxUsers,
      coordinatorName: this.coordinatorName,
    };
  }

  get setupState(): "complete" | "incomplete" {
    return this.setupCompleted ? "complete" : "incomplete";
  }

  get isSetupComplete(): boolean {
    return this.setupCompleted && normalizeCoordinatorName(this.coordinatorName) !== null;
  }

  enterEdit(): void {
    this.editMode = true;
    this.relayError = null;
    this.limitError = null;
  }

  exitEdit(): void {
    this.editMode = false;
    this.relayError = null;
    this.limitError = null;
  }

  lock(): void {
    this.editMode = false;
  }

  addRelay(value: string): boolean {
    const url = value.trim();
    const error = validateRelayUrl(url);
    if (error) {
      this.relayError = error;
      return false;
    }

    if (this.relays.some((relay) => relay.url === url)) {
      this.relayError = "Relay URL is already listed";
      return false;
    }

    this.relays = [...this.relays, { id: crypto.randomUUID(), url, enabled: true }];
    this.relayError = null;
    this.commit(true);
    return true;
  }

  removeRelay(id: string): void {
    if (!this.relays.some((relay) => relay.id === id)) return;
    this.relays = this.relays.filter((relay) => relay.id !== id);
    this.commit(true);
  }

  toggleRelay(id: string): void {
    if (!this.relays.some((relay) => relay.id === id)) return;
    this.relays = this.relays.map((relay) =>
      relay.id === id ? { ...relay, enabled: !relay.enabled } : relay,
    );
    this.commit(true);
  }

  setAnnouncement(value: boolean): void {
    if (this.announce === value) return;
    this.announce = value;
    this.commit(true);
  }

  setAutostart(value: boolean): void {
    if (this.autostart === value) return;
    this.autostart = value;
    this.commit();
  }

  setMaxUsers(value: number): boolean {
    const error = validateMaxUsers(value);
    if (error) {
      this.limitError = error;
      return false;
    }

    this.maxUsers = value;
    this.limitError = null;
    this.commit(true);
    return true;
  }

  completeSetup(value: unknown): boolean {
    const name = normalizeCoordinatorName(value);
    if (name === null) return false;

    if (this.setupCompleted && this.coordinatorName === name) return true;
    this.coordinatorName = name;
    this.setupCompleted = true;
    this.commit(false);
    return true;
  }

  completeFirstRunSetup(options: FirstRunSetupOptions): boolean {
    const name = normalizeCoordinatorName(options.name);
    if (name === null) return false;

    const urls = options.relays.map((value) => value.trim());
    if (urls.length === 0) {
      this.relayError = "Add at least one relay";
      return false;
    }
    const invalidRelay = urls.find((url) => validateShareableRelayUrl(url) !== null);
    if (invalidRelay !== undefined) {
      this.relayError = validateShareableRelayUrl(invalidRelay);
      return false;
    }
    if (urls.some((url, index) => urls.indexOf(url) !== index)) {
      this.relayError = "Relay URLs must be unique";
      return false;
    }

    const nextRelays = urls.map((url, index) => ({ id: `setup-relay-${index}-${crypto.randomUUID()}`, url, enabled: true }));
    const persisted: PersistedConfig = {
      version: CONFIG_STORAGE_VERSION,
      relaySetVersion: DEFAULT_RELAY_SET_VERSION,
      relays: nextRelays.map((relay) => ({ url: relay.url, enabled: true })),
      announce: options.announce,
      maxUsers: this.maxUsers,
      autostart: options.autostart,
      coordinatorName: name,
      setupCompleted: true,
      userName: this.userName,
      hostBadgeLabel: this.hostBadgeLabel,
      hostBadgeEmoji: this.hostBadgeEmoji,
      presenceState: this.presenceState,
    };
    try {
      if ("localStorage" in globalThis) localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(persisted));
    } catch {
      this.setupError = "Could not save coordinator setup";
      return false;
    }

    this.coordinatorName = name;
    this.relays = nextRelays;
    this.announce = options.announce;
    this.autostart = options.autostart;
    this.setupCompleted = true;
    this.relayError = null;
    this.setupError = null;
    this.revision += 1;
    this.runtimeRevision += 1;
    return true;
  }

  setCoordinatorName(value: unknown): boolean {
    const name = normalizeCoordinatorName(value);
    if (name === null) return false;
    if (this.coordinatorName === name) return true;
    this.coordinatorName = name;
    this.commit(this.isSetupComplete);
    return true;
  }

  setUserName(value: string): void {
    const name = value.trimStart().slice(0, 32);
    if (this.userName === name) return;
    this.userName = name;
    this.commit();
  }

  setHostBadgeLabel(value: string): void {
    const label = value.trimStart().slice(0, 20);
    if (this.hostBadgeLabel === label) return;
    this.hostBadgeLabel = label;
    this.commit();
  }

  setHostBadgeEmoji(value: string): void {
    const emoji = Array.from(value.trim()).slice(0, 2).join("");
    if (this.hostBadgeEmoji === emoji) return;
    this.hostBadgeEmoji = emoji;
    this.commit();
  }

  setPresenceState(value: PresenceState): void {
    if (this.presenceState === value) return;
    this.presenceState = value;
    this.commit();
  }

  resetToDefaults(): void {
    clearPersistedConfig();
    this.relays = cloneDefaultRelays();
    this.editMode = false;
    this.relayError = null;
    this.setupError = null;
    this.limitError = null;
    this.announce = false;
    this.maxUsers = DEFAULT_MAX_USERS;
    this.autostart = false;
    this.coordinatorName = "My coordinator";
    this.setupCompleted = false;
    this.userName = "";
    this.hostBadgeLabel = "host";
    this.hostBadgeEmoji = "🛡️";
    this.presenceState = "invisible";
    this.revision += 1;
  }

  private commit(restartRequired = false): void {
    this.revision += 1;
    if (restartRequired) this.runtimeRevision += 1;
    this.persistConfig();
  }

  private persistConfig(): void {
    if (!("localStorage" in globalThis)) {
      return;
    }

    const config: PersistedConfig = {
      version: CONFIG_STORAGE_VERSION,
      relaySetVersion: DEFAULT_RELAY_SET_VERSION,
      relays: this.relays.map((relay) => ({ url: relay.url, enabled: relay.enabled })),
      announce: this.announce,
      maxUsers: this.maxUsers,
      autostart: this.autostart,
      coordinatorName: this.coordinatorName,
      setupCompleted: this.setupCompleted,
      userName: this.userName,
      hostBadgeLabel: this.hostBadgeLabel,
      hostBadgeEmoji: this.hostBadgeEmoji,
      presenceState: this.presenceState,
    };
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
  }

  private loadPersistedConfig(): void {
    const persisted = readPersistedConfig();
    if (!persisted) {
      return;
    }

    const hasKnownDefaultRelay = persisted.relays.some((relay) =>
      relay.url === LEGACY_DEFAULT_RELAY_URL
      || DEFAULT_RELAYS.some((defaultRelay) => defaultRelay.url === relay.url)
    );
    const relayMigration = persisted.relaySetVersion !== DEFAULT_RELAY_SET_VERSION
      && hasKnownDefaultRelay;
    const persistedRelays = relayMigration
      ? mergeDefaultRelaySet(persisted.relays)
      : persisted.relays;
    this.relays = persistedRelays.map((relay) => ({
      id: crypto.randomUUID(),
      url: relay.url,
      enabled: relay.enabled,
    }));
    this.announce = persisted.announce;
    this.maxUsers = persisted.maxUsers;
    this.autostart = persisted.autostart;
    this.coordinatorName = persisted.coordinatorName ?? "My coordinator";
    const hasValidCoordinatorName = normalizeCoordinatorName(this.coordinatorName) !== null;
    const isMeaningfulLegacyName = hasValidCoordinatorName && this.coordinatorName !== "My coordinator";
    const legacySetupMigration = persisted.setupCompleted === undefined && isMeaningfulLegacyName;
    this.setupCompleted = persisted.setupCompleted === true
      ? hasValidCoordinatorName
      : legacySetupMigration;
    this.userName = persisted.userName || "";
    this.hostBadgeLabel = persisted.hostBadgeLabel ?? "host";
    this.hostBadgeEmoji = persisted.hostBadgeEmoji ?? "🛡️";
    this.presenceState = persisted.presenceState ?? "invisible";
    if (relayMigration || legacySetupMigration) this.persistConfig();
  }
}

export const configStore = new ConfigStore();

export { normalizeCoordinatorName };

export function clearPersistedConfig(): void {
  if ("localStorage" in globalThis) {
    localStorage.removeItem(CONFIG_STORAGE_KEY);
  }
}

function cloneDefaultRelays(): RelayConfig[] {
  return DEFAULT_RELAYS.map((relay) => ({ ...relay }));
}

function readPersistedConfig(): PersistedConfig | null {
  if (!("localStorage" in globalThis)) {
    return null;
  }

  const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedConfig>;
    if (parsed.version !== CONFIG_STORAGE_VERSION || !Array.isArray(parsed.relays)) {
      return null;
    }

    const relays = parsed.relays
      .map((relay) => normalizePersistedRelay(relay))
      .filter((relay): relay is Pick<RelayConfig, "url" | "enabled"> => relay !== null);

    const maxUsers = typeof parsed.maxUsers === "number" ? Math.trunc(parsed.maxUsers) : DEFAULT_MAX_USERS;
    const limitError = validateMaxUsers(maxUsers);

    return {
      version: CONFIG_STORAGE_VERSION,
      relaySetVersion: typeof parsed.relaySetVersion === "number"
        ? parsed.relaySetVersion
        : undefined,
      relays,
      announce: parsed.announce === true,
      maxUsers: limitError ? DEFAULT_MAX_USERS : maxUsers,
      autostart: parsed.autostart === true,
      coordinatorName: normalizeCoordinatorName(parsed.coordinatorName) ?? undefined,
      setupCompleted: typeof parsed.setupCompleted === "boolean" ? parsed.setupCompleted : undefined,
      userName: normalizeName(parsed.userName, 32),
      hostBadgeLabel: normalizeName(parsed.hostBadgeLabel, 20),
      hostBadgeEmoji: normalizeEmoji(parsed.hostBadgeEmoji),
      presenceState: normalizePresenceState(parsed.presenceState),
    };
  } catch {
    return null;
  }
}

function mergeDefaultRelaySet(
  persistedRelays: Array<Pick<RelayConfig, "url" | "enabled">>,
): Array<Pick<RelayConfig, "url" | "enabled">> {
  const existing = new Map(persistedRelays.map((relay) => [relay.url, relay]));
  const defaults = DEFAULT_RELAYS.map((relay) => ({
    url: relay.url,
    enabled: existing.get(relay.url)?.enabled ?? true,
  }));
  const custom = persistedRelays.filter((relay) =>
    relay.url !== LEGACY_DEFAULT_RELAY_URL
    && !DEFAULT_RELAYS.some((defaultRelay) => defaultRelay.url === relay.url)
  );
  return [...defaults, ...custom];
}

function normalizePresenceState(value: unknown): PresenceState | undefined {
  return value === "online" || value === "invisible" || value === "offline" ? value : undefined;
}

function normalizeName(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, maxLength);
  return normalized || undefined;
}

function normalizeEmoji(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = Array.from(value.trim()).slice(0, 2).join("");
  return normalized || undefined;
}

function normalizePersistedRelay(value: unknown): Pick<RelayConfig, "url" | "enabled"> | null {
  if (typeof value !== "object" || value === null || !("url" in value)) {
    return null;
  }

  const url = typeof value.url === "string" ? value.url.trim() : "";
  if (validateRelayUrl(url)) {
    return null;
  }

  return {
    url,
    enabled: "enabled" in value ? value.enabled === true : true,
  };
}
