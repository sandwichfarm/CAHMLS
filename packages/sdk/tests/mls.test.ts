import { describe, expect, test } from "vitest";
import {
  base64ToBytes,
  defaultCredentialTypes,
  encode,
  mlsMessageEncoder,
  protocolVersions,
  wireformats,
  type CustomExtension,
  type KeyPackage,
} from "ts-mls";

import { makeCordnLastResortKeyPackageExtension } from "../src/client/cordn-wire.js";
import {
  addMember,
  createKeyPackage,
  createRoomState,
} from "../src/client/protocol.js";
import {
  APP_DATA_DICTIONARY_EXTENSION_TYPE,
  LAST_RESORT_KEY_PACKAGE_COMPONENT_ID,
  ensureLastResortKeyPackageExtension,
  isLastResortKeyPackage,
  isLastResortKeyPackageExtension,
} from "../src/mls/lastResortKeyPackage.js";
import {
  decodeExact,
  decodeKeyPackage,
  decodeWelcome,
  encodeKeyPackage,
  encodeWelcome,
} from "../src/mls/mlsCodec.js";

const dictionaryExtension = (...bytes: number[]): CustomExtension => ({
  extensionType: APP_DATA_DICTIONARY_EXTENSION_TYPE,
  extensionData: Uint8Array.from(bytes),
}) as CustomExtension;

async function twoMemberWelcome() {
  const host = await createKeyPackage("aa".repeat(32));
  const guest = await createKeyPackage("bb".repeat(32));
  const state = await createRoomState(host.keyPackage, host.privateKeyPackage);
  return { host, guest, ...(await addMember(state, guest.stored.publicBase64)) };
}

describe("isLastResortKeyPackageExtension", () => {
  test("recognizes the marker Cordn clients publish", () => {
    expect(isLastResortKeyPackageExtension(makeCordnLastResortKeyPackageExtension())).toBe(true);
    expect(LAST_RESORT_KEY_PACKAGE_COMPONENT_ID).toBe(4);
  });

  test("ignores other extension types even with marker bytes", () => {
    const marker = makeCordnLastResortKeyPackageExtension();
    expect(isLastResortKeyPackageExtension({ ...marker, extensionType: 0x0a0a } as CustomExtension)).toBe(false);
  });

  test("treats an empty dictionary as not last-resort", () => {
    expect(isLastResortKeyPackageExtension(dictionaryExtension(0x00))).toBe(false);
  });

  test("finds the marker after skipping an unrelated component", () => {
    expect(isLastResortKeyPackageExtension(dictionaryExtension(
      0x08,
      0x00, 0x09, 0x02, 0xca, 0xfe, // component 9 with two bytes
      0x00, 0x04, 0x00, // last-resort marker
    ))).toBe(true);
  });

  test("does not accept component 4 carrying data", () => {
    expect(isLastResortKeyPackageExtension(dictionaryExtension(0x04, 0x00, 0x04, 0x01, 0xff))).toBe(false);
  });

  test("decodes two-byte and four-byte MLS varint lengths", () => {
    const payload = new Array<number>(64).fill(0x11);
    expect(isLastResortKeyPackageExtension(dictionaryExtension(
      0x40, 0x47, // 2-byte varint: dictionary is 71 bytes
      0x00, 0x09, 0x40, 0x40, ...payload,
      0x00, 0x04, 0x00,
    ))).toBe(true);
    expect(isLastResortKeyPackageExtension(dictionaryExtension(
      0x80, 0x00, 0x00, 0x03, // 4-byte varint: dictionary is 3 bytes
      0x00, 0x04, 0x00,
    ))).toBe(true);
  });

  test.each([
    ["missing dictionary length", [], /Unexpected end of app data dictionary/],
    ["truncated multi-byte length", [0x40], /dictionary length/],
    ["dictionary shorter than declared", [0x05, 0x00, 0x04], /component data/],
    ["trailing bytes after the dictionary", [0x03, 0x00, 0x04, 0x00, 0xff], /trailing data/],
    ["component id cut in half", [0x01, 0x00], /Unexpected end of app data dictionary/],
    ["component without a data length", [0x02, 0x00, 0x09], /Unexpected end of app data dictionary/],
  ] as const)("rejects a malformed dictionary: %s", (_label, bytes, message) => {
    expect(() => isLastResortKeyPackageExtension(dictionaryExtension(...bytes))).toThrow(message);
  });

  test("rejects the reserved 0b11 varint prefix on the outer dictionary length", () => {
    // RFC 9420 2.1.2: a two-bit prefix of 11 is invalid.
    expect(() => isLastResortKeyPackageExtension(dictionaryExtension(
      0xc0, 0, 0, 0, 0, 0, 0, 3,
      0x00, 0x04, 0x00,
    ))).toThrow(/varint/i);
  });

  test("a crafted negative component length cannot rewind the parser into an endless loop", () => {
    // Before the fix the reserved prefix was read as a 64-bit length truncated
    // to int32, so 0xfffffff6 became -10 and moved the offset back to the start.
    // A key package from any remote client reaches this parser during kp_publish.
    expect(() => isLastResortKeyPackageExtension(dictionaryExtension(
      0x0a,
      0x00, 0x09, 0xc0, 0, 0, 0, 0xff, 0xff, 0xff, 0xf6,
    ))).toThrow(/varint/i);
  });
});

describe("ensureLastResortKeyPackageExtension", () => {
  test("appends the marker without mutating the caller's list", () => {
    const other = { extensionType: 0x0a0a, extensionData: new Uint8Array([1]) } as CustomExtension;
    const input = [other];
    const output = ensureLastResortKeyPackageExtension(input);

    expect(input).toEqual([other]);
    expect(output).toHaveLength(2);
    expect(output[0]).toBe(other);
    expect(isLastResortKeyPackageExtension(output[1]!)).toBe(true);
  });

  test("emits bytes identical to the client-side marker", () => {
    const [added] = ensureLastResortKeyPackageExtension([]);
    expect(added!.extensionData).toEqual(makeCordnLastResortKeyPackageExtension().extensionData);
  });

  test("returns the same list when the marker is already present", () => {
    const input = [makeCordnLastResortKeyPackageExtension()];
    expect(ensureLastResortKeyPackageExtension(input)).toBe(input);
  });
});

describe("isLastResortKeyPackage", () => {
  test("distinguishes ordinary from last-resort packages", async () => {
    const ordinary = await createKeyPackage("aa".repeat(32));
    const lastResort = await createKeyPackage("aa".repeat(32), { lastResort: true });

    expect(isLastResortKeyPackage(ordinary.keyPackage)).toBe(false);
    expect(isLastResortKeyPackage(lastResort.keyPackage)).toBe(true);
  });

  test("the marker survives a serialization round trip", async () => {
    const { keyPackage } = await createKeyPackage("aa".repeat(32), { lastResort: true });
    expect(isLastResortKeyPackage(decodeKeyPackage(encodeKeyPackage(keyPackage)))).toBe(true);
  });

  test("a hostile extension in a key package is rejected rather than hanging", async () => {
    const { keyPackage } = await createKeyPackage("aa".repeat(32));
    const hostile: KeyPackage = {
      ...keyPackage,
      extensions: [dictionaryExtension(0x0a, 0x00, 0x09, 0xc0, 0, 0, 0, 0xff, 0xff, 0xff, 0xf6)],
    };
    expect(() => isLastResortKeyPackage(hostile)).toThrow(/varint/i);
  });
});

describe("mlsCodec", () => {
  test("decodeExact rejects undecodable and over-long input with its label", () => {
    const byteDecoder = (bytes: Uint8Array, offset: number): [number, number] | undefined =>
      offset < bytes.length ? [bytes[offset]!, offset + 1] : undefined;

    expect(decodeExact(Uint8Array.of(7), byteDecoder, "thing")).toBe(7);
    expect(() => decodeExact(new Uint8Array(0), byteDecoder, "thing")).toThrow("Invalid thing");
    expect(() => decodeExact(Uint8Array.of(7, 8), byteDecoder, "thing")).toThrow("Invalid thing");
  });

  test("key packages round trip and keep their identity", async () => {
    const { keyPackage } = await createKeyPackage("aa".repeat(32));
    const decoded = decodeKeyPackage(encodeKeyPackage(keyPackage));

    expect(encodeKeyPackage(decoded)).toEqual(encodeKeyPackage(keyPackage));
    expect(decoded.leafNode.credential.credentialType).toBe(defaultCredentialTypes.basic);
  });

  test("key package decoding rejects garbage and trailing bytes", async () => {
    const { keyPackage } = await createKeyPackage("aa".repeat(32));
    const encoded = encodeKeyPackage(keyPackage);

    expect(() => decodeKeyPackage(Uint8Array.of(1, 2, 3))).toThrow("Invalid key package");
    expect(() => decodeKeyPackage(new Uint8Array([...encoded, 0]), "kp_64")).toThrow("Invalid kp_64");
    // ts-mls raises its own bounds error for truncated input; it must still reject.
    expect(() => decodeKeyPackage(encoded.subarray(0, encoded.length - 1))).toThrow();
  });

  test("welcomes round trip", async () => {
    const { welcomeBase64 } = await twoMemberWelcome();
    const welcome = decodeWelcome(base64ToBytes(welcomeBase64));

    expect(encodeWelcome(welcome)).toEqual(base64ToBytes(welcomeBase64));
  });

  test("welcome decoding rejects garbage, truncation and trailing bytes", async () => {
    const { welcomeBase64 } = await twoMemberWelcome();
    const bytes = base64ToBytes(welcomeBase64);

    expect(() => decodeWelcome(Uint8Array.of(0, 1))).toThrow("Invalid welcome");
    expect(() => decodeWelcome(bytes.subarray(0, bytes.length - 1), "welcome_64")).toThrow();
    expect(() => decodeWelcome(new Uint8Array([...bytes, 0]))).toThrow("Invalid welcome");
  });

  test("welcome decoding rejects other well-formed MLS messages", async () => {
    const { host } = await twoMemberWelcome();
    const keyPackageMessage = encode(mlsMessageEncoder, {
      version: protocolVersions.mls10,
      wireformat: wireformats.mls_key_package,
      keyPackage: host.keyPackage,
    });
    expect(() => decodeWelcome(keyPackageMessage, "welcome_64")).toThrow("Invalid welcome_64");
  });
});
