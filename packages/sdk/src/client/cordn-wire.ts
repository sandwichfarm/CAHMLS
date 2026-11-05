import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { concatBytes, randomBytes } from "@noble/ciphers/utils.js";
import {
  base64ToBytes,
  bytesToBase64,
  defaultCapabilities,
  makeCustomExtension,
  mlsExporter,
  type CustomExtension,
  type ClientState,
  type GroupContextExtension,
} from "ts-mls";

const textEncoder = new TextEncoder();

export const CORDN_GROUP_METADATA_EXTENSION_TYPE = 0xc04d;
export const APP_DATA_DICTIONARY_EXTENSION_TYPE = 0x0006;
export const LAST_RESORT_KEY_PACKAGE_COMPONENT_ID = 0x0004;

const GROUP_PAYLOAD_EXPORTER_LABEL = "cordn";
const GROUP_PAYLOAD_EXPORTER_CONTEXT = "group-payload";
const GROUP_PAYLOAD_KEY_BYTES = 32;
const GROUP_PAYLOAD_NONCE_BYTES = 12;
const GROUP_PAYLOAD_TAG_BYTES = 16;

export interface CordnGroupMetadata {
  name: string;
  description?: string;
  icon?: string;
  imageUrl?: string;
  adminPubkeys?: string[];
}

function encodeUint16(value: number): Uint8Array {
  return Uint8Array.from([(value >> 8) & 0xff, value & 0xff]);
}

function encodeField(bytes: Uint8Array): Uint8Array {
  return new Uint8Array([...encodeUint16(bytes.length), ...bytes]);
}

function hexToBytes(value: string): Uint8Array {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("Cordn metadata admin keys must be 32-byte hex public keys");
  }
  return Uint8Array.from(
    normalized.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)),
  );
}

function encodeAdminPubkeys(values: string[] = []): Uint8Array {
  const normalized = values.map((value) => value.trim().toLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Cordn metadata admin keys must not contain duplicates");
  }
  return concatBytes(...normalized.map(hexToBytes));
}

export function createCordnMetadataCapabilities() {
  const capabilities = defaultCapabilities();
  if (!capabilities.extensions.includes(CORDN_GROUP_METADATA_EXTENSION_TYPE)) {
    capabilities.extensions = [
      ...capabilities.extensions,
      CORDN_GROUP_METADATA_EXTENSION_TYPE,
    ];
  }
  if (!capabilities.extensions.includes(APP_DATA_DICTIONARY_EXTENSION_TYPE)) {
    capabilities.extensions = [
      ...capabilities.extensions,
      APP_DATA_DICTIONARY_EXTENSION_TYPE,
    ];
  }
  return capabilities;
}

export function encodeCordnGroupMetadata(metadata: CordnGroupMetadata): Uint8Array {
  return new Uint8Array([
    ...encodeUint16(1),
    ...encodeField(textEncoder.encode(metadata.name.trim())),
    ...encodeField(textEncoder.encode(metadata.description?.trim() ?? "")),
    ...encodeField(encodeAdminPubkeys(metadata.adminPubkeys)),
    ...encodeField(textEncoder.encode(metadata.icon?.trim() ?? "")),
    ...encodeField(textEncoder.encode(metadata.imageUrl?.trim() ?? "")),
  ]);
}

export function makeCordnGroupMetadataExtension(
  metadata: CordnGroupMetadata,
): GroupContextExtension {
  return makeCustomExtension({
    extensionType: CORDN_GROUP_METADATA_EXTENSION_TYPE,
    extensionData: encodeCordnGroupMetadata(metadata),
  });
}

/** Mark a published package as Cordn's per-identity last-resort package. */
export function makeCordnLastResortKeyPackageExtension(): CustomExtension {
  return makeCustomExtension({
    extensionType: APP_DATA_DICTIONARY_EXTENSION_TYPE,
    // TLS-vector encoded dictionary containing component 0x0004 with an
    // empty value: vector(3 bytes) + component id + vector(0 bytes).
    extensionData: Uint8Array.from([0x03, 0x00, LAST_RESORT_KEY_PACKAGE_COMPONENT_ID, 0x00]),
  }) as CustomExtension;
}

async function deriveGroupPayloadKey(
  state: ClientState,
  cipherSuite: Awaited<ReturnType<typeof import("ts-mls")["getCiphersuiteImpl"]>>,
): Promise<Uint8Array> {
  return mlsExporter(
    state.keySchedule.exporterSecret,
    GROUP_PAYLOAD_EXPORTER_LABEL,
    textEncoder.encode(GROUP_PAYLOAD_EXPORTER_CONTEXT),
    GROUP_PAYLOAD_KEY_BYTES,
    cipherSuite,
  );
}

/** Cordn spec/03: seal serialized MLS bytes before coordinator delivery. */
export async function sealCordnGroupPayloadBase64(
  state: ClientState,
  opaqueMessageBase64: string,
  cipherSuite: Parameters<typeof mlsExporter>[4],
): Promise<string> {
  const key = await deriveGroupPayloadKey(state, cipherSuite);
  const nonce = randomBytes(GROUP_PAYLOAD_NONCE_BYTES);
  const ciphertext = chacha20poly1305(key, nonce, new Uint8Array(0)).encrypt(
    base64ToBytes(opaqueMessageBase64),
  );
  return bytesToBase64(concatBytes(nonce, ciphertext));
}

/** Cordn spec/03: authenticate and recover serialized MLS bytes. */
export async function unsealCordnGroupPayloadBase64(
  state: ClientState,
  encryptedBase64: string,
  cipherSuite: Parameters<typeof mlsExporter>[4],
): Promise<string> {
  const payload = base64ToBytes(encryptedBase64);
  if (payload.length < GROUP_PAYLOAD_NONCE_BYTES + GROUP_PAYLOAD_TAG_BYTES) {
    throw new Error("Sealed Cordn group payload is too short");
  }
  const key = await deriveGroupPayloadKey(state, cipherSuite);
  const nonce = payload.subarray(0, GROUP_PAYLOAD_NONCE_BYTES);
  const ciphertext = payload.subarray(GROUP_PAYLOAD_NONCE_BYTES);
  const serialized = chacha20poly1305(key, nonce, new Uint8Array(0)).decrypt(
    ciphertext,
  );
  return bytesToBase64(serialized);
}
