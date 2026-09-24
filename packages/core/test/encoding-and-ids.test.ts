import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodeBase64Url, encodeBase64Url, generateId, isId } from "../src/index.js";
import { isValidTimestamp } from "../src/internal/timestamp.js";
import { describeTextProblem, normalizeText } from "../src/internal/text.js";
import { fixedRandom } from "./support.js";

describe("base64url", () => {
  it("matches RFC 4648 test vectors (unpadded, URL-safe)", () => {
    const encode = (text: string): string => encodeBase64Url(new TextEncoder().encode(text));
    expect(encode("")).toBe("");
    expect(encode("f")).toBe("Zg");
    expect(encode("fo")).toBe("Zm8");
    expect(encode("foo")).toBe("Zm9v");
    expect(encode("foob")).toBe("Zm9vYg");
    expect(encode("fooba")).toBe("Zm9vYmE");
    expect(encode("foobar")).toBe("Zm9vYmFy");
    expect(encodeBase64Url(Uint8Array.of(0xfb, 0xff, 0xfe))).toBe("-__-");
  });

  it("round-trips arbitrary bytes (property)", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        const decoded = decodeBase64Url(encodeBase64Url(bytes));
        return decoded !== undefined && Buffer.compare(decoded, bytes) === 0;
      }),
    );
  });

  it("rejects everything but the canonical encoding", () => {
    for (const text of [
      "Zg==", // padding
      "Zh", // non-zero trailing bits: not the canonical form of any byte string
      "Z", // impossible length
      "Zm9v+", // wrong alphabet
      "Zm9v/",
      "Zm9 v",
      "Zm9v\n",
      "Zm9vé",
    ]) {
      expect(decodeBase64Url(text), text).toBeUndefined();
    }
  });
});

describe("ids", () => {
  it("generates deterministic, well-formed ids from injected sources", () => {
    const now = new Date("2026-09-24T00:00:00Z");
    const id = generateId("footprint", { now, randomBytes: fixedRandom(0) });
    expect(id).toBe(generateId("footprint", { now, randomBytes: fixedRandom(0) }));
    expect(id).toMatch(/^fp_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(id.endsWith("0000000000000000")).toBe(true); // 80 zero bits of entropy
  });

  it("uses distinct prefixes per kind", () => {
    const options = { now: new Date(0), randomBytes: fixedRandom(1) };
    expect(generateId("identity", options)).toMatch(/^df:identity:/);
    expect(generateId("project", options)).toMatch(/^df:project:/);
    expect(generateId("footprint", options)).toMatch(/^fp_/);
    expect(generateId("key", options)).toMatch(/^key_/);
  });

  it("sorts by creation time", () => {
    const early = generateId("key", { now: new Date("2026-01-01T00:00:00Z") });
    const late = generateId("key", { now: new Date("2026-06-01T00:00:00Z") });
    expect(early < late).toBe(true);
  });

  it("generates unique ids with the real random source", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateId("key")));
    expect(ids.size).toBe(1000);
  });

  it("validates ids strictly, including against lookalike characters", () => {
    const valid = "01J8Y5N3ZQ4VTK6M2P9R7XBWCD";
    expect(isId("identity", `df:identity:${valid}`)).toBe(true);
    expect(isId("identity", `df:project:${valid}`)).toBe(false); // wrong kind
    expect(isId("footprint", `fp_${valid.toLowerCase()}`)).toBe(false); // must be upper case
    expect(isId("footprint", `fp_${valid.slice(1)}`)).toBe(false); // too short
    expect(isId("key", `key_${valid}A`)).toBe(false); // too long
    expect(isId("key", `key_${valid.replace("J", "I")}`)).toBe(false); // I is not in the alphabet
    expect(isId("key", `key_${valid.replace("0", "\u{41e}")}`)).toBe(false); // Cyrillic \u{41e}, not zero
    expect(isId("key", `key_${valid}\n`)).toBe(false);
    expect(isId("key", `../../etc/passwd`)).toBe(false);
  });

  it("rejects an out-of-range clock instead of producing a malformed id", () => {
    expect(() => generateId("key", { now: new Date(-1) })).toThrow(RangeError);
  });
});

describe("timestamps", () => {
  it("accepts only the exact UTC form and real calendar dates", () => {
    expect(isValidTimestamp("2026-09-24T00:00:00Z")).toBe(true);
    expect(isValidTimestamp("2024-02-29T23:59:59Z")).toBe(true);
    for (const text of [
      "2026-09-24T00:00:00.000Z",
      "2026-09-24T00:00:00+00:00",
      "2026-09-24 00:00:00Z",
      "2026-09-24T00:00:00",
      "2026-9-24T00:00:00Z",
      "2026-02-30T00:00:00Z",
      "2025-02-29T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-09-24T24:00:00Z",
      "2026-09-24T00:60:00Z",
      "2026-09-24T00:00:60Z",
      "1969-12-31T23:59:59Z",
      "",
    ]) {
      expect(isValidTimestamp(text), text).toBe(false);
    }
  });
});

describe("display text", () => {
  it("accepts ordinary names in any script", () => {
    for (const name of [
      "Sarah",
      "Ahmed Fayyaz",
      "Zoë Müller",
      "山田太郎",
      "Acme, Inc.",
      "😀 Team",
    ]) {
      expect(describeTextProblem(name, 100), name).toBeUndefined();
    }
  });

  it("stores markup as inert text rather than interpreting it", () => {
    expect(describeTextProblem('<script>alert(1)</script> & "quotes"', 100)).toBeUndefined();
    expect(describeTextProblem("[click](javascript:alert(1))", 100)).toBeUndefined();
  });

  it("rejects text that can spoof or corrupt terminals, logs and layouts", () => {
    const rejected: Record<string, string> = {
      empty: "",
      "leading space": " Sarah",
      "trailing space": "Sarah ",
      newline: "Sa\nrah",
      escape: "\u001b[31mSarah",
      "bidi override": "Sarah\u{202e}gnp.exe",
      "bidi isolate": "\u{2066}Sarah",
      "zero width space": "Sa\u{200b}rah",
      "zero width joiner": "Sa\u{200d}rah",
      "word joiner": "Sa\u{2060}rah",
      bom: "\u{feff}Sarah",
      "line separator": "Sa\u{2028}rah",
      "tag character": "Sarah\u{E0041}",
      "lone surrogate": "Sarah\ud800",
      "not NFC": "Cafe\u{301}", // e + combining acute, must be é
      "too long": "x".repeat(101),
    };
    for (const [label, value] of Object.entries(rejected)) {
      expect(describeTextProblem(value, 100), label).toBeTypeOf("string");
    }
  });

  it("counts characters, not UTF-16 units", () => {
    expect(describeTextProblem("😀".repeat(100), 100)).toBeUndefined();
    expect(describeTextProblem("😀".repeat(101), 100)).toBeTypeOf("string");
  });

  it("normalizeText produces text the validator accepts", () => {
    expect(normalizeText("  Cafe\u{301}  ")).toBe("Café");
    expect(describeTextProblem(normalizeText("  Cafe\u{301}  "), 100)).toBeUndefined();
  });
});
