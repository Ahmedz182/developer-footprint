import { err, type Result } from "../errors/result.js";
import { generateId, type IdOptions } from "../ids/ids.js";
import { normalizeText } from "../internal/text.js";
import { formatTimestamp } from "../internal/timestamp.js";
import { SPEC_VERSION, type Identity, type IdentityType } from "../types/index.js";
import { normalizeUrl } from "../url/url.js";
import { validateIdentity } from "./validate.js";

export interface CreateIdentityInput {
  readonly type: IdentityType;
  readonly name: string;
  /** The identity's website. Normalized for you; must be a public https URL. */
  readonly canonicalUrl: string;
  /** Platform slug -> profile URL, e.g. `{ github: "https://github.com/sarah" }`. */
  readonly profiles?: Readonly<Record<string, string>>;
  /** Supply to keep an existing id; otherwise a new one is generated. */
  readonly id?: string;
}

/** Normalizes `value` as a URL, attributing any failure to the named field. */
export function normalizeUrlField(field: string, value: string): Result<string> {
  const normalized = normalizeUrl(value);
  return normalized.ok
    ? normalized
    : err("INVALID_SCHEMA", `${field}: ${normalized.error.message}`, [
        { path: `/${field}`, code: "invalid_url", message: normalized.error.message },
      ]);
}

/**
 * Builds a valid identity document from user-supplied values, applying the protocol's
 * normalization (Unicode NFC, trimmed text, normalized URLs). The result has no keys yet; add
 * them with {@link addIdentityKey}. Nothing is published or signed.
 */
export function createIdentity(
  input: CreateIdentityInput,
  options: IdOptions = {},
): Result<Identity> {
  const canonicalUrl = normalizeUrlField("canonicalUrl", input.canonicalUrl);
  if (!canonicalUrl.ok) return canonicalUrl;

  let profiles: Record<string, string> | undefined;
  if (input.profiles !== undefined) {
    profiles = {};
    for (const [platform, url] of Object.entries(input.profiles)) {
      const normalized = normalizeUrlField(`profiles/${platform}`, url);
      if (!normalized.ok) return normalized;
      profiles = { ...profiles, [platform]: normalized.value };
    }
  }

  return validateIdentity({
    specVersion: SPEC_VERSION,
    id: input.id ?? generateId("identity", options),
    type: input.type,
    name: normalizeText(input.name),
    canonicalUrl: canonicalUrl.value,
    ...(profiles === undefined || Object.keys(profiles).length === 0 ? {} : { profiles }),
    keys: [],
    updatedAt: formatTimestamp(options.now ?? new Date()),
  });
}

export interface NewIdentityKey {
  readonly id: string;
  readonly publicKey: string;
}

/** Returns a copy of `identity` with `key` added as an active key and `updatedAt` refreshed. */
export function addIdentityKey(
  identity: Identity,
  key: NewIdentityKey,
  options: IdOptions = {},
): Result<Identity> {
  const now = formatTimestamp(options.now ?? new Date());
  return validateIdentity({
    ...identity,
    keys: [
      ...identity.keys,
      { id: key.id, algorithm: "Ed25519", publicKey: key.publicKey, createdAt: now },
    ],
    updatedAt: now,
  });
}
