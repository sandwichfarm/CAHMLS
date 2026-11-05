export function decodeBase64(value: string): Uint8Array {
  const normalizedInput = value.replace(/\s+/g, "");
  if (normalizedInput === "") {
    throw new Error("Invalid base64 payload");
  }

  let decodedString: string;
  try {
    decodedString = atob(normalizedInput);
  } catch {
    throw new Error("Invalid base64 payload");
  }

  const decoded = Uint8Array.from(decodedString, (char) => char.charCodeAt(0));
  if (decoded.length === 0 || encodeBase64(decoded) !== normalizedInput) {
    throw new Error("Invalid base64 payload");
  }

  return decoded;
}

export function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < value.length; index += 1) {
    binary += String.fromCharCode(value[index]!);
  }

  return btoa(binary);
}

export function assertNonEmptyBase64(
  value: string,
  fieldName: string,
): Uint8Array {
  const decoded = decodeBase64(value);
  if (decoded.length === 0) {
    throw new Error(
      `Invalid ${fieldName}: base64 payload decoded to empty bytes`,
    );
  }

  return decoded;
}
