import { afterEach, describe, expect, test, vi } from "vitest";
import { base64ToBytes, bytesToBase64, defaultCapabilities, getCiphersuiteImpl, nobleCryptoProvider } from "ts-mls";

import {
  APP_DATA_DICTIONARY_EXTENSION_TYPE,
  CORDN_GROUP_METADATA_EXTENSION_TYPE,
  LAST_RESORT_KEY_PACKAGE_COMPONENT_ID,
  createCordnMetadataCapabilities,
  encodeCordnGroupMetadata,
  makeCordnGroupMetadataExtension,
  makeCordnLastResortKeyPackageExtension,
  sealCordnGroupPayloadBase64,
  unsealCordnGroupPayloadBase64,
} from "../src/client/cordn-wire.js";
import { createKeyPackage, createRoomState } from "../src/client/protocol.js";

vi.mock("ts-mls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ts-mls")>();
  return { ...actual, defaultCapabilities: vi.fn(actual.defaultCapabilities) };
});

const PK_A = "ab".repeat(32);
const PK_B = "cd".repeat(32);

const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (value: string) => [...new TextEncoder().encode(value)];
const field = (...content: number[]) => [(content.length >> 8) & 0xff, content.length & 0xff, ...content];

const cipherSuite = () => getCiphersuiteImpl("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519", nobleCryptoProvider);

async function room() {
  const { keyPackage, privateKeyPackage } = await createKeyPackage(PK_A);
  return createRoomState(keyPackage, privateKeyPackage);
}

afterEach(() => {
  vi.mocked(defaultCapabilities).mockClear();
});

describe("encodeCordnGroupMetadata (wire format pin)", () => {
  test("encodes version then five length-prefixed fields in Cordn order", () => {
    expect(encodeCordnGroupMetadata({
      name: "N",
      description: "D",
      adminPubkeys: [PK_A],
      icon: "I",
      imageUrl: "U",
    })).toEqual(bytes(
      0x00, 0x01,
      ...field(...ascii("N")),
      ...field(...ascii("D")),
      ...field(...new Array<number>(32).fill(0xab)),
      ...field(...ascii("I")),
      ...field(...ascii("U")),
    ));
  });

  test("omitted optional fields are empty fields, not absent ones", () => {
    expect(encodeCordnGroupMetadata({ name: "Room" })).toEqual(bytes(
      0x00, 0x01,
      ...field(...ascii("Room")),
      0, 0,
      0, 0,
      0, 0,
      0, 0,
    ));
  });

  test("trims text fields", () => {
    expect(encodeCordnGroupMetadata({ name: "  a ", description: " b ", icon: " c ", imageUrl: " d " }))
      .toEqual(encodeCordnGroupMetadata({ name: "a", description: "b", icon: "c", imageUrl: "d" }));
  });

  test("measures UTF-8 bytes, not characters", () => {
    const encoded = encodeCordnGroupMetadata({ name: "é" });
    expect([...encoded.subarray(2, 6)]).toEqual([0, 2, 0xc3, 0xa9]);
  });

  test("normalizes admin key case and whitespace and concatenates keys", () => {
    const expected = encodeCordnGroupMetadata({ name: "x", adminPubkeys: [PK_A, PK_B] });
    expect(encodeCordnGroupMetadata({ name: "x", adminPubkeys: [` ${PK_A.toUpperCase()} `, PK_B] })).toEqual(expected);
    // 2 version + (2+1) name + 2 description + 2 prefix + two 32-byte keys + 2 icon + 2 image.
    expect(expected.length).toBe(2 + 3 + 2 + 2 + 64 + 2 + 2);
  });

  test.each([
    ["too short", "ab"],
    ["too long", "ab".repeat(33)],
    ["not hex", "zz".repeat(32)],
    ["empty", ""],
  ])("rejects an admin key that is %s", (_label, key) => {
    expect(() => encodeCordnGroupMetadata({ name: "x", adminPubkeys: [key] })).toThrow("32-byte hex public keys");
  });

  test("rejects duplicate admin keys even when they differ by case", () => {
    expect(() => encodeCordnGroupMetadata({ name: "x", adminPubkeys: [PK_A, PK_A.toUpperCase()] }))
      .toThrow("must not contain duplicates");
  });

  test("the largest field a uint16 prefix can describe still encodes correctly", () => {
    const encoded = encodeCordnGroupMetadata({ name: "a".repeat(0xffff) });
    expect([...encoded.subarray(2, 4)]).toEqual([0xff, 0xff]);
    expect(encoded.length).toBe(2 + 2 + 0xffff + 2 * 4);
  });

  test("refuses a field longer than its uint16 prefix instead of emitting corrupt framing", () => {
    // Before the fix the length wrapped to 0, so the receiver would read the
    // first bytes of the oversized name as the following fields.
    expect(() => encodeCordnGroupMetadata({ name: "a".repeat(0x10000) })).toThrow(/too long/i);
    expect(() => encodeCordnGroupMetadata({ name: "x", description: "a".repeat(0x10001) })).toThrow(/too long/i);
  });
});

describe("Cordn extensions", () => {
  test("constants match the Cordn registry values", () => {
    expect(CORDN_GROUP_METADATA_EXTENSION_TYPE).toBe(0xc04d);
    expect(APP_DATA_DICTIONARY_EXTENSION_TYPE).toBe(0x0006);
    expect(LAST_RESORT_KEY_PACKAGE_COMPONENT_ID).toBe(0x0004);
  });

  test("the metadata extension wraps the encoded metadata", () => {
    const metadata = { name: "Room", adminPubkeys: [PK_A] };
    const extension = makeCordnGroupMetadataExtension(metadata);
    expect(extension.extensionType).toBe(CORDN_GROUP_METADATA_EXTENSION_TYPE);
    expect(extension.extensionData).toEqual(encodeCordnGroupMetadata(metadata));
  });

  test("the last-resort marker bytes are exactly dictionary{component 4: empty}", () => {
    const extension = makeCordnLastResortKeyPackageExtension();
    expect(extension.extensionType).toBe(APP_DATA_DICTIONARY_EXTENSION_TYPE);
    expect(extension.extensionData).toEqual(bytes(0x03, 0x00, 0x04, 0x00));
  });
});

describe("createCordnMetadataCapabilities", () => {
  test("advertises both Cordn extensions on top of the defaults", () => {
    const capabilities = createCordnMetadataCapabilities();
    expect(capabilities.extensions).toEqual(expect.arrayContaining([
      CORDN_GROUP_METADATA_EXTENSION_TYPE,
      APP_DATA_DICTIONARY_EXTENSION_TYPE,
    ]));
  });

  test("does not list an extension twice when the defaults already contain it", () => {
    const actual = vi.mocked(defaultCapabilities).getMockImplementation()!;
    const base = actual();
    vi.mocked(defaultCapabilities).mockReturnValueOnce({
      ...base,
      extensions: [CORDN_GROUP_METADATA_EXTENSION_TYPE, APP_DATA_DICTIONARY_EXTENSION_TYPE],
    });

    expect(createCordnMetadataCapabilities().extensions).toEqual([
      CORDN_GROUP_METADATA_EXTENSION_TYPE,
      APP_DATA_DICTIONARY_EXTENSION_TYPE,
    ]);
  });
});

describe("group payload sealing", () => {
  const plaintext = bytesToBase64(bytes(1, 2, 3, 4, 5));

  test("round trips, hiding the plaintext behind a nonce and tag", async () => {
    const state = await room();
    const suite = await cipherSuite();

    const sealed = await sealCordnGroupPayloadBase64(state, plaintext, suite);

    expect(base64ToBytes(sealed).length).toBe(12 + 5 + 16);
    await expect(unsealCordnGroupPayloadBase64(state, sealed, suite)).resolves.toBe(plaintext);
  });

  test("uses a fresh nonce each time", async () => {
    const state = await room();
    const suite = await cipherSuite();
    const first = await sealCordnGroupPayloadBase64(state, plaintext, suite);
    const second = await sealCordnGroupPayloadBase64(state, plaintext, suite);

    expect(first).not.toBe(second);
    expect(base64ToBytes(first).subarray(0, 12)).not.toEqual(base64ToBytes(second).subarray(0, 12));
  });

  test("rejects a payload too short to hold a nonce and tag", async () => {
    const state = await room();
    const suite = await cipherSuite();
    const shortest = bytesToBase64(new Uint8Array(12 + 16 - 1));

    await expect(unsealCordnGroupPayloadBase64(state, shortest, suite)).rejects.toThrow("too short");
  });

  test("an empty plaintext produces a minimal payload that still authenticates", async () => {
    const state = await room();
    const suite = await cipherSuite();
    const sealed = await sealCordnGroupPayloadBase64(state, "", suite);

    expect(base64ToBytes(sealed).length).toBe(12 + 16);
    await expect(unsealCordnGroupPayloadBase64(state, sealed, suite)).resolves.toBe("");
  });

  test.each([
    ["nonce", 0],
    ["ciphertext", 12],
    ["tag", -1],
  ])("rejects a flipped %s byte", async (_label, position) => {
    const state = await room();
    const suite = await cipherSuite();
    const sealed = base64ToBytes(await sealCordnGroupPayloadBase64(state, plaintext, suite));
    const index = position < 0 ? sealed.length + position : position;
    sealed[index]! ^= 0x01;

    await expect(unsealCordnGroupPayloadBase64(state, bytesToBase64(sealed), suite)).rejects.toThrow();
  });

  test("a different group's exporter secret cannot open the payload", async () => {
    const suite = await cipherSuite();
    const sealed = await sealCordnGroupPayloadBase64(await room(), plaintext, suite);

    await expect(unsealCordnGroupPayloadBase64(await room(), sealed, suite)).rejects.toThrow();
  });
});
