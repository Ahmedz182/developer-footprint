import { err, ok, type Result } from "../errors/result.js";
import { hasLoneSurrogate } from "../internal/text.js";
import { LIMITS } from "../limits.js";

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface ParseJsonOptions {
  /** Upper bound on the UTF-8 size of `text`. Defaults to {@link LIMITS.maxDocumentBytes}. */
  readonly maxBytes?: number;
}

class ParseError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

class Parser {
  private index = 0;

  constructor(private readonly text: string) {}

  parseDocument(): JsonValue {
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index < this.text.length) this.fail("unexpected trailing content");
    return value;
  }

  private fail(message: string): never {
    throw new ParseError(message, this.index);
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length && WHITESPACE.has(this.text[this.index]!)) this.index++;
  }

  private parseValue(depth: number): JsonValue {
    if (depth > LIMITS.maxJsonDepth) this.fail(`nesting deeper than ${LIMITS.maxJsonDepth}`);
    this.skipWhitespace();
    const char = this.text[this.index];
    switch (char) {
      case "{":
        return this.parseObject(depth);
      case "[":
        return this.parseArray(depth);
      case '"':
        return this.parseString();
      case "t":
        return this.parseLiteral("true", true);
      case "f":
        return this.parseLiteral("false", false);
      case "n":
        return this.parseLiteral("null", null);
      case undefined:
        return this.fail("unexpected end of input");
      default:
        return this.parseNumber();
    }
  }

  private parseLiteral<T extends boolean | null>(word: string, value: T): T {
    if (!this.text.startsWith(word, this.index)) this.fail("unexpected token");
    this.index += word.length;
    return value;
  }

  private parseNumber(): number {
    const match = NUMBER.exec(this.text.slice(this.index, this.index + 400));
    if (match === null) return this.fail("unexpected token");
    const token = match[0];
    // Protocol documents contain no fractional numbers: they would need a number-formatting
    // rule that every implementation must reproduce bit-for-bit. Integers in the I-JSON safe
    // range serialize identically everywhere.
    if (/[.eE]/.test(token)) this.fail("only integers are allowed");
    const value = Number(token);
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      this.fail("integer is outside the interoperable range");
    }
    this.index += token.length;
    return value;
  }

  private parseString(): string {
    this.index++; // opening quote
    let out = "";
    for (;;) {
      const char = this.text[this.index];
      if (char === undefined) return this.fail("unterminated string");
      if (char === '"') {
        this.index++;
        break;
      }
      if (char.charCodeAt(0) < 0x20) return this.fail("unescaped control character in string");
      if (char === "\\") {
        const escape = this.text[this.index + 1];
        if (escape === "u") {
          const hex = this.text.slice(this.index + 2, this.index + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return this.fail("invalid unicode escape");
          out += String.fromCharCode(parseInt(hex, 16));
          this.index += 6;
        } else if (escape !== undefined && Object.hasOwn(ESCAPES, escape)) {
          out += ESCAPES[escape]!;
          this.index += 2;
        } else {
          return this.fail("invalid escape sequence");
        }
      } else {
        out += char;
        this.index++;
      }
    }
    // I-JSON (RFC 7493): a lone surrogate has no UTF-8 encoding, so implementations disagree on it.
    if (hasLoneSurrogate(out)) this.fail("string contains an unpaired surrogate");
    return out;
  }

  private parseArray(depth: number): JsonValue {
    this.index++; // [
    const items: JsonValue[] = [];
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index++;
      return items;
    }
    for (;;) {
      items.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const char = this.text[this.index];
      this.index++;
      if (char === "]") return items;
      if (char !== ",") {
        this.index--;
        return this.fail("expected ',' or ']'");
      }
    }
  }

  private parseObject(depth: number): JsonValue {
    this.index++; // {
    const entries: Record<string, JsonValue> = {};
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index++;
      return entries;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') return this.fail("expected a string key");
      const keyOffset = this.index;
      const key = this.parseString();
      // JSON.parse silently keeps the last duplicate, so two parsers can read different
      // documents from the same bytes. The protocol forbids duplicates outright.
      if (Object.hasOwn(entries, key)) throw new ParseError(`duplicate key "${key}"`, keyOffset);
      this.skipWhitespace();
      if (this.text[this.index] !== ":") return this.fail("expected ':'");
      this.index++;
      // defineProperty makes "__proto__" an ordinary own property instead of invoking the setter.
      Object.defineProperty(entries, key, {
        value: this.parseValue(depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.skipWhitespace();
      const char = this.text[this.index];
      this.index++;
      if (char === "}") return entries;
      if (char !== ",") {
        this.index--;
        return this.fail("expected ',' or '}'");
      }
    }
  }
}

/**
 * Strict JSON parser for untrusted protocol documents. Stricter than `JSON.parse`: duplicate
 * keys, lone surrogates, non-integer numbers, excessive nesting and oversized input are errors,
 * and `__proto__` cannot pollute prototypes. A leading byte-order mark is an error (RFC 8259 §8.1);
 * callers reading files should strip it first.
 */
export function parseJson(text: string, options: ParseJsonOptions = {}): Result<JsonValue> {
  const maxBytes = options.maxBytes ?? LIMITS.maxDocumentBytes;
  // Every UTF-16 code unit takes at least one UTF-8 byte, so this bound needs no encoding pass.
  if (text.length > maxBytes || new TextEncoder().encode(text).length > maxBytes) {
    return err("PAYLOAD_TOO_LARGE", `document exceeds the ${maxBytes}-byte limit`);
  }
  try {
    return ok(new Parser(text).parseDocument());
  } catch (error) {
    if (error instanceof ParseError) {
      return err("INVALID_JSON", `${error.message} at offset ${error.offset}`);
    }
    throw error;
  }
}
