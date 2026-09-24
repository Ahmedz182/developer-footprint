import type { Result } from "../errors/result.js";
import { encodeBase64Url } from "../internal/base64url.js";
import { isWeakEd25519PublicKey } from "../internal/weak-keys.js";
import { LIMITS } from "../limits.js";
import {
  IDENTITY_TYPES,
  KEY_ALGORITHMS,
  SPEC_VERSION,
  type Identity,
  type IdentityKey,
} from "../types/index.js";
import { describeUrlProblem } from "../url/url.js";
import {
  readArray,
  readBytes,
  readEnum,
  readId,
  readRecord,
  readSpecVersion,
  readText,
  readTimestamp,
  readUrl,
  type Snapshot,
} from "../validation/fields.js";
import { pointer, runValidation, type Validation } from "../validation/validation.js";

const PLATFORM_SLUG = /^[a-z][a-z0-9-]{1,31}$/;

export function validateIdentityKey(
  v: Validation,
  value: unknown,
  path: string,
): IdentityKey | undefined {
  const record = readRecord(v, value, path, {
    required: ["id", "algorithm", "publicKey", "createdAt"],
    optional: ["retiredAt", "revokedAt"],
  });
  if (record === undefined) return undefined;
  const id = readId(v, record, "id", path, "key");
  const algorithm = readEnum(v, record, "algorithm", path, KEY_ALGORITHMS);
  const publicKeyBytes = readBytes(v, record, "publicKey", path, 32);
  const createdAt = readTimestamp(v, record, "createdAt", path);
  const retiredAt = readTimestamp(v, record, "retiredAt", path);
  const revokedAt = readTimestamp(v, record, "revokedAt", path);

  if (publicKeyBytes !== undefined && isWeakEd25519PublicKey(publicKeyBytes)) {
    v.add(
      pointer(path, "publicKey"),
      "invalid_value",
      "must not be a small-order or non-canonical Ed25519 key",
    );
  }
  if (createdAt !== undefined && retiredAt !== undefined && retiredAt < createdAt) {
    v.add(pointer(path, "retiredAt"), "inconsistent", "must not be earlier than createdAt");
  }
  if (createdAt !== undefined && revokedAt !== undefined && revokedAt < createdAt) {
    v.add(pointer(path, "revokedAt"), "inconsistent", "must not be earlier than createdAt");
  }
  if (retiredAt !== undefined && revokedAt !== undefined && revokedAt < retiredAt) {
    v.add(pointer(path, "revokedAt"), "inconsistent", "must not be earlier than retiredAt");
  }

  if (
    id === undefined ||
    algorithm === undefined ||
    publicKeyBytes === undefined ||
    createdAt === undefined
  ) {
    return undefined;
  }
  return {
    id,
    algorithm,
    publicKey: encodeBase64Url(publicKeyBytes),
    createdAt,
    ...(retiredAt === undefined ? {} : { retiredAt }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

function readKeys(
  v: Validation,
  snapshot: Snapshot,
  path: string,
): readonly IdentityKey[] | undefined {
  const items = readArray(v, snapshot, "keys", path, { min: 0, max: LIMITS.maxKeys });
  if (items === undefined) return undefined;
  const keys: IdentityKey[] = [];
  const seenIds = new Map<string, number>();
  const seenPublicKeys = new Map<string, number>();
  items.forEach((item, index) => {
    const itemPath = pointer(pointer(path, "keys"), index);
    const key = validateIdentityKey(v, item, itemPath);
    if (key === undefined) return;
    if (seenIds.has(key.id)) {
      v.add(
        pointer(itemPath, "id"),
        "duplicate",
        `key id already used by /keys/${seenIds.get(key.id)}`,
      );
    }
    // The same public key under two ids would let one signature be attributed to either key.
    if (seenPublicKeys.has(key.publicKey)) {
      v.add(
        pointer(itemPath, "publicKey"),
        "duplicate",
        `public key already listed at /keys/${seenPublicKeys.get(key.publicKey)}`,
      );
    }
    seenIds.set(key.id, index);
    seenPublicKeys.set(key.publicKey, index);
    keys.push(key);
  });
  return keys;
}

/**
 * Validates an identity document (SPEC.md §4). Returns a fresh, normalized copy containing only
 * known fields; callers should sign and store that copy, never the raw input.
 */
export function validateIdentity(input: unknown): Result<Identity> {
  return runValidation((v) => {
    const record = readRecord(v, input, "", {
      required: ["specVersion", "id", "type", "name", "canonicalUrl", "keys", "updatedAt"],
      optional: ["profiles"],
    });
    if (record === undefined || !readSpecVersion(v, record, "")) return undefined;

    const id = readId(v, record, "id", "", "identity");
    const type = readEnum(v, record, "type", "", IDENTITY_TYPES);
    const name = readText(v, record, "name", "", LIMITS.maxNameCodePoints);
    const canonicalUrl = readUrl(v, record, "canonicalUrl", "");
    const profiles = readProfileMap(v, record);
    const keys = readKeys(v, record, "");
    const updatedAt = readTimestamp(v, record, "updatedAt", "");

    if (
      id === undefined ||
      type === undefined ||
      name === undefined ||
      canonicalUrl === undefined ||
      keys === undefined ||
      updatedAt === undefined
    ) {
      return undefined;
    }
    return {
      specVersion: SPEC_VERSION,
      id,
      type,
      name,
      canonicalUrl,
      ...(profiles === undefined ? {} : { profiles }),
      keys,
      updatedAt,
    };
  });
}

/** `profiles`: an open map from a platform slug to that platform's profile URL. */
function readProfileMap(
  v: Validation,
  snapshot: Snapshot,
): Readonly<Record<string, string>> | undefined {
  const raw = snapshot["profiles"];
  if (raw === undefined) return undefined;
  const path = "/profiles";
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    v.add(path, "invalid_type", "must be an object");
    return undefined;
  }
  const prototype = Object.getPrototypeOf(raw) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    v.add(path, "invalid_type", "must be a plain object");
    return undefined;
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > LIMITS.maxProfiles) {
    v.add(path, "out_of_range", `must contain at most ${LIMITS.maxProfiles} profiles`);
    return undefined;
  }
  const result: [string, string][] = [];
  for (const [platform, url] of entries) {
    const entryPath = pointer(path, platform);
    if (!PLATFORM_SLUG.test(platform)) {
      v.add(
        entryPath,
        "invalid_value",
        "platform name must be 2-32 lower-case letters, digits or hyphens",
      );
      continue;
    }
    if (typeof url !== "string") {
      v.add(entryPath, "invalid_type", "must be a string");
      continue;
    }
    const problem = describeUrlProblem(url);
    if (problem !== undefined) {
      v.add(entryPath, problem.code, problem.message);
      continue;
    }
    result.push([platform, url]);
  }
  return Object.fromEntries(result);
}
