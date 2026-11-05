import {
  makeCustomExtension,
  type CustomExtension,
  type KeyPackage,
} from "ts-mls";

export const APP_DATA_DICTIONARY_EXTENSION_TYPE = 0x0006;
export const LAST_RESORT_KEY_PACKAGE_COMPONENT_ID = 0x0004;

function encodeUint16(value: number): Uint8Array {
  return Uint8Array.from([(value >> 8) & 0xff, value & 0xff]);
}

function decodeUint16(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.length) {
    throw new Error("Unexpected end of app data dictionary");
  }
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

/** Only ever encodes the short constant below, so the one-byte varint form suffices. */
function encodeVarBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from([bytes.length, ...bytes]);
}

function decodeVarBytes(
  bytes: Uint8Array,
  offset: number,
): [Uint8Array, number] {
  if (offset >= bytes.length) {
    throw new Error("Unexpected end of app data dictionary");
  }

  const firstByte = bytes[offset]!;
  // RFC 9420 2.1.2 reserves prefix 0b11. Reading it as an 8-byte length would
  // overflow int32 and could rewind the caller's offset into an endless loop.
  if ((firstByte & 0xc0) === 0xc0) {
    throw new Error("Invalid varint prefix in app data dictionary");
  }
  const lengthFieldSize = 1 << ((firstByte & 0xc0) >> 6);
  if (offset + lengthFieldSize > bytes.length) {
    throw new Error("Unexpected end of app data dictionary length");
  }

  let length = firstByte & 0x3f;
  for (let i = 1; i < lengthFieldSize; i += 1) {
    length = (length << 8) | bytes[offset + i]!;
  }

  const start = offset + lengthFieldSize;
  const end = start + length;
  if (end > bytes.length) {
    throw new Error("Unexpected end of app data dictionary component data");
  }

  return [bytes.slice(start, end), end];
}

const LAST_RESORT_KEY_PACKAGE_EXTENSION = makeCustomExtension({
  extensionType: APP_DATA_DICTIONARY_EXTENSION_TYPE,
  extensionData: encodeVarBytes(
    new Uint8Array([
      ...encodeUint16(LAST_RESORT_KEY_PACKAGE_COMPONENT_ID),
      ...encodeVarBytes(new Uint8Array()),
    ]),
  ),
});

export function ensureLastResortKeyPackageExtension(
  extensions: CustomExtension[],
): CustomExtension[] {
  if (extensions.some(isLastResortKeyPackageExtension)) {
    return extensions;
  }

  return [...extensions, LAST_RESORT_KEY_PACKAGE_EXTENSION];
}

export function isLastResortKeyPackage(keyPackage: KeyPackage): boolean {
  return keyPackage.extensions.some(isLastResortKeyPackageExtension);
}

export function isLastResortKeyPackageExtension(
  extension: CustomExtension,
): boolean {
  if (extension.extensionType !== APP_DATA_DICTIONARY_EXTENSION_TYPE) {
    return false;
  }

  const [dictionaryData, dictionaryEnd] = decodeVarBytes(
    extension.extensionData,
    0,
  );
  if (dictionaryEnd !== extension.extensionData.length) {
    throw new Error("Invalid app data dictionary trailing data");
  }

  let offset = 0;
  while (offset < dictionaryData.length) {
    const componentId = decodeUint16(dictionaryData, offset);
    const [componentData, nextOffset] = decodeVarBytes(
      dictionaryData,
      offset + 2,
    );

    if (
      componentId === LAST_RESORT_KEY_PACKAGE_COMPONENT_ID &&
      componentData.length === 0
    ) {
      return true;
    }

    offset = nextOffset;
  }

  return false;
}
