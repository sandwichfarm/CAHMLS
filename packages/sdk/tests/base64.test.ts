import { afterEach, describe, expect, test, vi } from "vitest";

import { assertNonEmptyBase64, decodeBase64, encodeBase64 } from "../src/server/base64.js";

describe("encodeBase64", () => {
  test.each([
    [[1], "AQ=="],
    [[1, 2], "AQI="],
    [[1, 2, 3], "AQID"],
    [[0, 0xff, 0x80], "AP+A"],
  ])("encodes %j as %s", (bytes, expected) => {
    expect(encodeBase64(Uint8Array.from(bytes))).toBe(expected);
  });

  test("encodes empty bytes as the empty string", () => {
    expect(encodeBase64(new Uint8Array())).toBe("");
  });
});

describe("decodeBase64", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("round-trips every byte value", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);

    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });

  test("ignores whitespace such as MIME line wrapping", () => {
    expect([...decodeBase64(" AQ\nID\t\r\n")]).toEqual([1, 2, 3]);
  });

  test.each([
    ["empty", ""],
    ["only whitespace", " \n\t"],
    ["only padding", "===="],
    ["a lone padding character", "="],
    ["a truncated quantum", "A"],
    ["characters outside the alphabet", "AQ!D"],
    ["url-safe alphabet", "-_-_"],
    ["missing padding", "AQ"],
    ["non-canonical trailing bits", "AR=="],
    ["data after padding", "AQ==AQ=="],
  ])("rejects %s", (_label, value) => {
    expect(() => decodeBase64(value)).toThrow("Invalid base64 payload");
  });

  test("rejects input whose decoded form is empty", () => {
    vi.stubGlobal("atob", () => "");

    expect(() => decodeBase64("AAAA")).toThrow("Invalid base64 payload");
  });
});

describe("assertNonEmptyBase64", () => {
  test("returns the decoded bytes", () => {
    expect([...assertNonEmptyBase64("AQID", "field")]).toEqual([1, 2, 3]);
  });

  test("rejects empty and malformed payloads", () => {
    expect(() => assertNonEmptyBase64("", "field")).toThrow("Invalid base64 payload");
    expect(() => assertNonEmptyBase64("***", "field")).toThrow("Invalid base64 payload");
  });
});
