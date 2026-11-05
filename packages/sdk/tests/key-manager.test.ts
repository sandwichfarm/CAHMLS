import { describe, expect, test } from "vitest";

import { KeyManager } from "../src/crypto/key-manager.js";

describe("KeyManager", () => {
  test("generates npub identity and keeps private key out of identity", () => {
    const manager = KeyManager.generate();

    expect(manager.identity.npub).toMatch(/^npub/);
    expect(manager.identity.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(manager.identity).not.toHaveProperty("secretKey");
    expect(manager.identity).not.toHaveProperty("nsec");
  });

  test("zero-fills key material before making it unavailable", () => {
    const manager = KeyManager.generate();
    const hex = manager.getSecretKeyHex();

    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    manager.destroy();
    expect(() => manager.getSecretKeyHex()).toThrow("destroyed");
  });
});
