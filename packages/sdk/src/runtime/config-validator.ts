export function validateRelayUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "Relay URL is required";
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "Relay URL must be a valid ws:// or wss:// URI";
  }

  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return "Relay URL must start with ws:// or wss://";
  }

  if (!parsed.hostname) {
    return "Relay URL needs a hostname";
  }

  return null;
}

export function validateShareableRelayUrl(value: string): string | null {
  const error = validateRelayUrl(value);
  if (error) return error;
  if (new URL(value.trim()).protocol !== "wss:") return "Relay URL must start with wss://";
  return null;
}

export const MIN_MAX_USERS = 1;
export const DEFAULT_MAX_USERS = 64;
export const BROWSER_MAX_USERS_CAP = 256;

export function validateMaxUsers(value: number): string | null {
  if (!Number.isSafeInteger(value)) {
    return "Key-package quota must be a whole number";
  }

  if (value < MIN_MAX_USERS) {
    return `Key-package quota must be at least ${MIN_MAX_USERS}`;
  }

  if (value > BROWSER_MAX_USERS_CAP) {
    return `Browser limit is ${BROWSER_MAX_USERS_CAP} key packages per identity`;
  }

  return null;
}

/** Trim a coordinator display name to at most 48 code points. Empty or non-string input is rejected. */
export function normalizeCoordinatorName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = Array.from(value.trim()).slice(0, 48).join("");
  return normalized || null;
}
