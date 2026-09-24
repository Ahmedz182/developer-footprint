import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  canonicalizeToBytes,
  digestDocument,
  parseJson,
  sha256Digest,
  type JsonValue,
} from "../src/index.js";

function canon(value: unknown): string {
  const result = canonicalize(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("canonicalize (RFC 8785 profile)", () => {
  it("sorts keys by UTF-16 code unit, as in RFC 8785 §3.2.3", () => {
    // The sorting example from the RFC, expressed with escapes so no editor can normalize it.
    const input = parseJson(
      String.raw`{
        "€": "Euro Sign",
        "\r": "Carriage Return",
        "דּ": "Hebrew Letter Dalet With Dagesh",
        "1": "One",
        "😀": "Emoji: Grinning Face",
        "\u0080": "Control",
        "ö": "Latin Small Letter O With Diaeresis"
      }`,
    );
    expect(input.ok).toBe(true);
    if (!input.ok) return;
    const order: [string, string][] = [
      ["\r", "Carriage Return"],
      ["1", "One"],
      ["\u0080", "Control"],
      ["ö", "Latin Small Letter O With Diaeresis"],
      ["€", "Euro Sign"],
      ["\u{1F600}", "Emoji: Grinning Face"],
      ["דּ", "Hebrew Letter Dalet With Dagesh"],
    ];
    const expected = `{${order.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",")}}`;
    expect(canon(input.value)).toBe(expected);
  });

  it("emits no whitespace and sorts nested objects", () => {
    expect(canon({ b: [3, 2, 1], a: { d: 1, c: true }, e: null })).toBe(
      '{"a":{"c":true,"d":1},"b":[3,2,1],"e":null}',
    );
  });

  it("preserves array order", () => {
    expect(canon(["b", "a"])).toBe('["b","a"]');
  });

  it("escapes only what RFC 8785 §3.2.2.2 requires", () => {
    expect(canon('\b\t\n\f\r"\\\u0001\u001f')).toBe('"\\b\\t\\n\\f\\r\\"\\\\\\u0001\\u001f"');
    // DEL, U+2028/2029 and non-ASCII stay literal.
    expect(canon("\u007f\u{2028}é€😀")).toBe('"\u007f\u{2028}é€😀"');
    expect(canon("</script>")).toBe('"</script>"');
  });

  it("does not depend on the property insertion order", () => {
    expect(canon({ a: 1, b: 2 })).toBe(canon({ b: 2, a: 1 }));
  });

  it("produces UTF-8 bytes", () => {
    const bytes = canonicalizeToBytes({ k: "é" });
    expect(bytes.ok && Array.from(bytes.value)).toEqual(
      Array.from(new TextEncoder().encode('{"k":"é"}')),
    );
  });

  it("rejects values that cannot be represented identically everywhere", () => {
    const rejected: unknown[] = [
      undefined,
      () => 1,
      Symbol("x"),
      10n,
      1.5,
      Number.NaN,
      Infinity,
      -0,
      2 ** 53,
      new Date(0),
      new Map(),
      new (class Foo {})(),
      { a: undefined },
      [undefined],
      // eslint-disable-next-line no-sparse-arrays
      [1, , 3],
      "\ud800",
      { "\ud800": 1 },
    ];
    for (const value of rejected) {
      expect(canonicalize(value), String(typeof value)).toMatchObject({
        ok: false,
        error: { code: "UNCANONICALIZABLE" },
      });
    }
  });

  it("rejects cyclic structures instead of overflowing the stack", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(canonicalize(cyclic)).toMatchObject({ ok: false, error: { code: "UNCANONICALIZABLE" } });
  });

  it("locates the offending value", () => {
    const result = canonicalize({ a: [{ b: 1.5 }] });
    expect(result.ok ? "" : result.error.message).toContain("/a/0/b");
  });

  const jsonValue = fc
    .jsonValue()
    .map((value) => JSON.parse(JSON.stringify(value)) as JsonValue)
    .filter((value) => canonicalize(value).ok);

  it("is idempotent: canonicalizing its own output changes nothing (property)", () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        const once = canon(value);
        const reparsed = parseJson(once);
        return reparsed.ok && canon(reparsed.value) === once;
      }),
    );
  });

  it("ignores key order (property)", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.integer()), (record) => {
        const reversed = Object.fromEntries(Object.entries(record).reverse());
        return canon(record) === canon(reversed);
      }),
    );
  });
});

describe("digests", () => {
  it("matches the SHA-256 test vector for the empty string", async () => {
    const digest = await sha256Digest(new Uint8Array());
    // SHA-256("") = e3b0c442 98fc1c14 9afbf4c8 996fb924 27ae41e4 649b934c a495991b 7852b855
    expect(digest).toEqual({
      ok: true,
      value: "sha256:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    });
  });

  it("digests the canonical form, so key order does not matter", async () => {
    const a = await digestDocument({ x: 1, y: 2 });
    const b = await digestDocument({ y: 2, x: 1 });
    expect(a).toEqual(b);
    expect(a.ok && a.value).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
  });

  it("refuses to digest something uncanonicalizable", async () => {
    expect(await digestDocument({ x: 1.5 })).toMatchObject({ ok: false });
  });
});
