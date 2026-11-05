import { describe, expect, test } from "vitest";

import {
  BROWSER_MAX_USERS_CAP,
  DEFAULT_MAX_USERS,
  MIN_MAX_USERS,
  normalizeCoordinatorName,
  validateMaxUsers,
  validateRelayUrl,
  validateShareableRelayUrl,
} from "../src/runtime/config-validator.js";

describe("validateRelayUrl", () => {
  test.each([
    ["", "Relay URL is required"],
    ["   ", "Relay URL is required"],
    ["relay.example", "Relay URL must be a valid ws:// or wss:// URI"],
    ["ws://", "Relay URL must be a valid ws:// or wss:// URI"],
    ["wss://:443", "Relay URL must be a valid ws:// or wss:// URI"],
    ["https://relay.example", "Relay URL must start with ws:// or wss://"],
  ])("%j -> %s", (value, message) => {
    expect(validateRelayUrl(value)).toBe(message);
  });

  test("ignores surrounding whitespace", () => {
    expect(validateRelayUrl("  wss://relay.example  ")).toBeNull();
  });
});

describe("validateShareableRelayUrl", () => {
  test("accepts only secure relays", () => {
    expect(validateShareableRelayUrl(" wss://relay.example ")).toBeNull();
    expect(validateShareableRelayUrl("ws://relay.example")).toBe("Relay URL must start with wss://");
  });

  test("reports the underlying validation error first", () => {
    expect(validateShareableRelayUrl("")).toBe("Relay URL is required");
    expect(validateShareableRelayUrl("https://relay.example")).toBe("Relay URL must start with ws:// or wss://");
  });
});

describe("validateMaxUsers", () => {
  test("accepts the inclusive bounds and the default", () => {
    for (const value of [MIN_MAX_USERS, DEFAULT_MAX_USERS, BROWSER_MAX_USERS_CAP]) {
      expect(validateMaxUsers(value)).toBeNull();
    }
  });

  test.each([
    [1.5, "Key-package quota must be a whole number"],
    [Number.NaN, "Key-package quota must be a whole number"],
    [Number.POSITIVE_INFINITY, "Key-package quota must be a whole number"],
    [Number.MAX_SAFE_INTEGER + 1, "Key-package quota must be a whole number"],
    [0, "Key-package quota must be at least 1"],
    [-5, "Key-package quota must be at least 1"],
    [BROWSER_MAX_USERS_CAP + 1, "Browser limit is 256 key packages per identity"],
  ])("%s -> %s", (value, message) => {
    expect(validateMaxUsers(value)).toBe(message);
  });
});

describe("normalizeCoordinatorName", () => {
  test.each([[null], [undefined], [42], [{}], [""], ["   \n\t"]])("rejects %j", (value) => {
    expect(normalizeCoordinatorName(value)).toBeNull();
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeCoordinatorName("  Madeira host  ")).toBe("Madeira host");
  });

  test("limits by code points, so a surrogate pair is never split", () => {
    const name = normalizeCoordinatorName("😀".repeat(60));
    expect(Array.from(name!)).toHaveLength(48);
    expect(name).toBe("😀".repeat(48));
  });

  test("does not leave trailing whitespace when truncation lands on a space", () => {
    const name = normalizeCoordinatorName(`${"x".repeat(47)} tail`);
    expect(name).toBe("x".repeat(47));
    expect(normalizeCoordinatorName(name)).toBe(name);
  });
});
