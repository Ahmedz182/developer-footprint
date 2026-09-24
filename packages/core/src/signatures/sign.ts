import { digestDocument } from "../canonical/digest.js";
import { verifyEd25519, type PrivateKey } from "../crypto/ed25519.js";
import { err, ok, type Result } from "../errors/result.js";
import { validateFootprint } from "../footprint/validate.js";
import { evaluateKeyAt, findKey } from "../identity/keys.js";
import { validateIdentity } from "../identity/validate.js";
import { encodeBase64Url } from "../internal/base64url.js";
import { formatTimestamp, isValidTimestamp } from "../internal/timestamp.js";
import { SPEC_VERSION, type SignatureEnvelope, type SignatureStatement } from "../types/index.js";
import { wellKnownUrlFor } from "../url/url.js";
import { canonicalStatementBytes, ENVELOPE_TYPE } from "./envelope.js";

export interface SignFootprintInput {
  /** Untrusted-shaped input: it is validated, and the validated copy is what gets signed. */
  readonly footprint: unknown;
  /** The signer's identity document, which must list `keyId`. */
  readonly identity: unknown;
  readonly keyId: string;
  readonly privateKey: PrivateKey;
  /** Defaults to now. A string must already be a protocol timestamp. */
  readonly signedAt?: Date | string;
}

/**
 * Signs a footprint (SPEC.md §10). The pipeline is validate -> canonicalize -> digest -> sign ->
 * self-verify; nothing is signed unless both documents are valid, the key may sign at
 * `signedAt`, and the signer is one of the footprint's listed contributors.
 */
export async function signFootprint(input: SignFootprintInput): Promise<Result<SignatureEnvelope>> {
  const footprint = validateFootprint(input.footprint);
  if (!footprint.ok) return footprint;
  const identity = validateIdentity(input.identity);
  if (!identity.ok) return identity;

  const key = findKey(identity.value, input.keyId);
  if (key === undefined) {
    return err("KEY_NOT_FOUND", `identity ${identity.value.id} does not list key ${input.keyId}`);
  }

  let signedAt: string;
  if (typeof input.signedAt === "string") {
    if (!isValidTimestamp(input.signedAt)) {
      return err("INVALID_SCHEMA", "signedAt must be a UTC timestamp like 2026-09-24T00:00:00Z");
    }
    signedAt = input.signedAt;
  } else {
    signedAt = formatTimestamp(input.signedAt ?? new Date());
  }

  const window = evaluateKeyAt(key, signedAt);
  if (!window.usable) return err("KEY_NOT_USABLE", window.reason);

  const signer = wellKnownUrlFor(identity.value.canonicalUrl);
  if (!signer.ok) return signer;
  if (!footprint.value.contributors.some((contributor) => contributor.identity === signer.value)) {
    return err(
      "SIGNER_MISMATCH",
      `the signer (${signer.value}) is not listed as a contributor of this footprint`,
    );
  }

  const digest = await digestDocument(footprint.value);
  if (!digest.ok) return digest;

  const statement: SignatureStatement = {
    type: ENVELOPE_TYPE,
    specVersion: SPEC_VERSION,
    algorithm: key.algorithm,
    signer: signer.value,
    signerId: identity.value.id,
    keyId: key.id,
    signedAt,
    subject: { type: "footprint", id: footprint.value.id, digest: digest.value },
  };
  const bytes = canonicalStatementBytes(statement);
  if (!bytes.ok) return bytes;

  const rawSignature = await input.privateKey.sign(bytes.value);
  if (!rawSignature.ok) return rawSignature;
  const signature = encodeBase64Url(rawSignature.value);

  // Refuse to emit a signature that the published key would not accept: this catches a private
  // key that does not belong to `keyId` before a bad claim is ever written to disk.
  const selfCheck = await verifyEd25519(key.publicKey, bytes.value, signature);
  if (!selfCheck.ok) return selfCheck;
  if (!selfCheck.value) {
    return err(
      "INVALID_KEY",
      `the private key does not match public key ${key.id} in the identity`,
    );
  }
  return ok({ ...statement, signature });
}
