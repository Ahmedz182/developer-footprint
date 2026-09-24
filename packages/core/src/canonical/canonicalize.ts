import { err, ok, type Result } from "../errors/result.js";
import { hasLoneSurrogate } from "../internal/text.js";
import { LIMITS } from "../limits.js";

class Uncanonicalizable extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
  }
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function serialize(value: unknown, path: string, depth: number): string {
  if (depth > LIMITS.maxJsonDepth) throw new Uncanonicalizable("nesting is too deep", path);
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      if (hasLoneSurrogate(value)) throw new Uncanonicalizable("unpaired surrogate", path);
      // JSON.stringify string escaping is identical to RFC 8785 §3.2.2.2 for well-formed strings.
      return JSON.stringify(value);
    case "number":
      // Integers in the I-JSON safe range print identically in every implementation.
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        throw new Uncanonicalizable("only safe integers are supported", path);
      }
      return String(value);
    case "object":
      break;
    default:
      throw new Uncanonicalizable(`unsupported value of type ${typeof value}`, path);
  }

  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) {
      // Reading by index turns array holes into `undefined`, which is rejected above.
      items.push(serialize(value[i], `${path}/${i}`, depth + 1));
    }
    return `[${items.join(",")}]`;
  }

  if (!isPlainObject(value)) throw new Uncanonicalizable("not a plain object", path);
  const record = value as Record<string, unknown>;
  // Default sort compares UTF-16 code units, which is exactly RFC 8785 §3.2.3 ordering.
  const keys = Object.keys(record).sort();
  const members: string[] = [];
  for (const key of keys) {
    if (hasLoneSurrogate(key)) throw new Uncanonicalizable("unpaired surrogate in key", path);
    members.push(
      `${JSON.stringify(key)}:${serialize(record[key], `${path}/${escapePointer(key)}`, depth + 1)}`,
    );
  }
  return `{${members.join(",")}}`;
}

/**
 * Canonical JSON text of `value`: the RFC 8785 (JCS) profile defined in SPEC.md §8. Keys are
 * sorted by UTF-16 code unit, no insignificant whitespace, minimal string escaping, integers
 * only. `undefined`, non-finite/fractional numbers, lone surrogates and non-plain objects are
 * rejected rather than silently dropped or coerced, so a value that cannot be represented
 * identically everywhere can never be signed.
 */
export function canonicalize(value: unknown): Result<string> {
  try {
    return ok(serialize(value, "", 0));
  } catch (error) {
    if (error instanceof Uncanonicalizable) {
      return err(
        "UNCANONICALIZABLE",
        `cannot canonicalize${error.path === "" ? " document" : ` at ${error.path}`}: ${error.message}`,
      );
    }
    throw error;
  }
}

/** Canonical form as UTF-8 bytes: the exact input to hashing and signing. */
export function canonicalizeToBytes(value: unknown): Result<Uint8Array> {
  const text = canonicalize(value);
  return text.ok ? ok(new TextEncoder().encode(text.value)) : text;
}
