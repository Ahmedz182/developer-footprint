import { decodeBase64Url } from "../internal/base64url.js";
import { describeTextProblem } from "../internal/text.js";
import { isValidTimestamp } from "../internal/timestamp.js";
import { isId, type IdKind } from "../ids/ids.js";
import { SPEC_VERSION } from "../types/index.js";
import { describeUrlProblem, isIdentityDocumentUrl } from "../url/url.js";
import { pointer, type Validation } from "./validation.js";

/** A one-time, prototype-free copy of an input object's known fields. */
export type Snapshot = Readonly<Record<string, unknown>>;

export interface Shape {
  readonly required: readonly string[];
  readonly optional?: readonly string[];
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Reads `value` as a strict record: it must be a plain object, contain no field outside
 * `shape`, and contain every required field. Each property is read exactly once, so a hostile
 * object cannot present different values to validation and to later serialization.
 * `undefined`-valued properties count as absent.
 */
export function readRecord(
  v: Validation,
  value: unknown,
  path: string,
  shape: Shape,
): Snapshot | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !isPlainObject(value)
  ) {
    v.add(path, "invalid_type", "must be an object");
    return undefined;
  }
  const allowed = new Set([...shape.required, ...(shape.optional ?? [])]);
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      v.add(pointer(path, key), "unknown_field", `unknown field "${key}"`);
      continue;
    }
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) snapshot[key] = item;
  }
  for (const key of shape.required) {
    if (!(key in snapshot)) v.add(pointer(path, key), "missing_field", `"${key}" is required`);
  }
  return snapshot;
}

/** Reads and vets the `specVersion` field. Returns false if the document must not be read further. */
export function readSpecVersion(v: Validation, snapshot: Snapshot, path: string): boolean {
  const raw = snapshot["specVersion"];
  if (raw === undefined) return false; // reported as missing by readRecord
  if (raw === SPEC_VERSION) return true;
  if (typeof raw === "string" && /^\d+\.\d+$/.test(raw)) {
    v.unsupportedVersion = raw;
  } else {
    v.add(pointer(path, "specVersion"), "invalid_value", 'must be a version string such as "1.0"');
  }
  return false;
}

type FieldProblem = {
  readonly code: "invalid_value" | "invalid_url" | "not_normalized";
  readonly message: string;
};

/** Reads an optional-or-required string field, applying `check` to present values. */
export function readString(
  v: Validation,
  snapshot: Snapshot,
  key: string,
  path: string,
  check?: (value: string) => FieldProblem | undefined,
): string | undefined {
  const raw = snapshot[key];
  if (raw === undefined) return undefined;
  const fieldPath = pointer(path, key);
  if (typeof raw !== "string") {
    v.add(fieldPath, "invalid_type", "must be a string");
    return undefined;
  }
  const problem = check?.(raw);
  if (problem !== undefined) {
    v.add(fieldPath, problem.code, problem.message);
    return undefined;
  }
  return raw;
}

export function readText(
  v: Validation,
  snapshot: Snapshot,
  key: string,
  path: string,
  maxCodePoints: number,
): string | undefined {
  return readString(v, snapshot, key, path, (value) => {
    const problem = describeTextProblem(value, maxCodePoints);
    return problem === undefined ? undefined : { code: "invalid_value", message: problem };
  });
}

export function readTimestamp(
  v: Validation,
  snapshot: Snapshot,
  key: string,
  path: string,
): string | undefined {
  return readString(v, snapshot, key, path, (value) =>
    isValidTimestamp(value)
      ? undefined
      : { code: "invalid_value", message: "must be a UTC timestamp like 2026-09-24T00:00:00Z" },
  );
}

export function readUrl(
  v: Validation,
  snapshot: Snapshot,
  key: string,
  path: string,
): string | undefined {
  return readString(v, snapshot, key, path, describeUrlProblem);
}

export function readIdentityDocumentUrl(
  v: Validation,
  snapshot: Snapshot,
  key: string,
  path: string,
): string | undefined {
  return readString(v, snapshot, key, path, (value) => {
    const problem = describeUrlProblem(value);
    if (problem !== undefined) return problem;
    return isIdentityDocumentUrl(value)
      ? undefined
      : {
          code: "invalid_value",
          message: "must be an identity document URL (/.well-known/developer-footprint.json)",
        };
  });
}

export function readId(
  v: Validation,
  snapshot: Snapshot,
  key: string,
  path: string,
  kind: IdKind,
): string | undefined {
  return readString(v, snapshot, key, path, (value) =>
    isId(kind, value)
      ? undefined
      : { code: "invalid_value", message: `must be a valid ${kind} id` },
  );
}

export function readEnum<T extends string>(
  v: Validation,
  snapshot: Snapshot,
  key: string,
  path: string,
  allowed: readonly T[],
): T | undefined {
  const value = readString(v, snapshot, key, path, (candidate) =>
    (allowed as readonly string[]).includes(candidate)
      ? undefined
      : { code: "invalid_value", message: `must be one of: ${allowed.join(", ")}` },
  );
  return value as T | undefined;
}

/** A canonical base64url string that decodes to exactly `byteLength` bytes. */
export function readBytes(
  v: Validation,
  snapshot: Snapshot,
  key: string,
  path: string,
  byteLength: number,
  prefix = "",
): Uint8Array | undefined {
  const text = readString(v, snapshot, key, path);
  if (text === undefined) return undefined;
  const decoded = text.startsWith(prefix) ? decodeBase64Url(text.slice(prefix.length)) : undefined;
  if (decoded?.length !== byteLength) {
    v.add(
      pointer(path, key),
      "invalid_value",
      `must be ${prefix}base64url (no padding) encoding exactly ${byteLength} bytes`,
    );
    return undefined;
  }
  return decoded;
}

/** Reads a bounded array into a fresh copy. */
export function readArray(
  v: Validation,
  snapshot: Snapshot,
  key: string,
  path: string,
  bounds: { readonly min: number; readonly max: number },
): readonly unknown[] | undefined {
  const raw = snapshot[key];
  if (raw === undefined) return undefined;
  const fieldPath = pointer(path, key);
  if (!Array.isArray(raw)) {
    v.add(fieldPath, "invalid_type", "must be an array");
    return undefined;
  }
  if (raw.length < bounds.min || raw.length > bounds.max) {
    v.add(fieldPath, "out_of_range", `must contain between ${bounds.min} and ${bounds.max} items`);
    return undefined;
  }
  return Array.from({ length: raw.length }, (_, index) => (raw as unknown[])[index]);
}
