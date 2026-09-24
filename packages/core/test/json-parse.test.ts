import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LIMITS, parseJson } from "../src/index.js";

function parsed(text: string): unknown {
  const result = parseJson(text);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("parseJson", () => {
  it("parses ordinary documents", () => {
    expect(parsed('{"a":[1,2,{"b":null}],"c":"x","d":true}')).toEqual({
      a: [1, 2, { b: null }],
      c: "x",
      d: true,
    });
    expect(parsed('  "\\u00e9\\ud83d\\ude00"  ')).toBe("é😀");
  });

  it("rejects duplicate keys instead of letting the last one win", () => {
    const result = parseJson('{"role":"contributor","role":"owner"}');
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_JSON" } });
    expect(result.ok ? "" : result.error.message).toContain('duplicate key "role"');
  });

  it("treats duplicate keys that differ only by escaping as duplicates", () => {
    expect(parseJson('{"a":1,"\\u0061":2}')).toMatchObject({ ok: false });
  });

  it("does not let __proto__ pollute prototypes", () => {
    const value = parsed('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("rejects malformed JSON", () => {
    for (const text of [
      "",
      "{",
      '{"a":1,}',
      "[1,]",
      "{'a':1}",
      '{"a":1} x',
      "undefined",
      "NaN",
      "01",
      "+1",
      ".5",
      '"\\x"',
      '"tab\there"',
      '"\\u12"',
      "[1 2]",
      '{"a" 1}',
      "\u{feff}{}",
    ]) {
      expect(parseJson(text), text).toMatchObject({ ok: false, error: { code: "INVALID_JSON" } });
    }
  });

  it("rejects numbers other than safe integers", () => {
    for (const text of [
      "1.5",
      "1e3",
      "1.0",
      "-0",
      "9007199254740993",
      "12345678901234567890",
      "-9007199254740992",
    ]) {
      expect(parseJson(text), text).toMatchObject({ ok: false, error: { code: "INVALID_JSON" } });
    }
    expect(parsed("9007199254740991")).toBe(9007199254740991);
    expect(parsed("-42")).toBe(-42);
  });

  it("rejects unpaired surrogates, escaped or raw", () => {
    expect(parseJson('"\\ud800"')).toMatchObject({ ok: false });
    expect(parseJson('"\\udc00\\ud800"')).toMatchObject({ ok: false });
    expect(parseJson(`"${String.fromCharCode(0xd800)}"`)).toMatchObject({ ok: false });
  });

  it("limits nesting depth", () => {
    const deep = (levels: number): string => "[".repeat(levels) + "]".repeat(levels);
    expect(parseJson(deep(LIMITS.maxJsonDepth)).ok).toBe(true);
    expect(parseJson(deep(LIMITS.maxJsonDepth + 5))).toMatchObject({ ok: false });
    // Must fail cleanly, not overflow the stack.
    expect(parseJson(deep(100_000))).toMatchObject({ ok: false });
  });

  it("enforces the payload size limit in bytes, not characters", () => {
    const limit = 1000;
    expect(parseJson(`"${"a".repeat(limit - 2)}"`, { maxBytes: limit }).ok).toBe(true);
    expect(parseJson(`"${"a".repeat(limit - 1)}"`, { maxBytes: limit })).toMatchObject({
      ok: false,
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
    // 400 three-byte characters are only 400 UTF-16 units but 1200 bytes.
    expect(parseJson(`"${"€".repeat(400)}"`, { maxBytes: limit })).toMatchObject({
      ok: false,
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
  });

  it("rejects a giant payload without trying to parse it", () => {
    const giant = `"${"x".repeat(LIMITS.maxDocumentBytes)}"`;
    expect(parseJson(giant)).toMatchObject({ ok: false, error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it("agrees with JSON.parse on everything it accepts (property)", () => {
    const json = fc.jsonValue().map((value) => JSON.stringify(value));
    fc.assert(
      fc.property(json, (text) => {
        const result = parseJson(text);
        if (!result.ok) return true; // stricter than JSON.parse is allowed (fractions, -0, ...)
        return JSON.stringify(result.value) === JSON.stringify(JSON.parse(text));
      }),
    );
  });

  it("never throws, whatever the input (property)", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (text) => {
        const result = parseJson(text);
        return typeof result.ok === "boolean";
      }),
      { numRuns: 500 },
    );
  });
});
