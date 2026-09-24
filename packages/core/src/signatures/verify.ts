import { digestDocument } from "../canonical/digest.js";
import { verifyEd25519 } from "../crypto/ed25519.js";
import type { FootprintError, Result } from "../errors/result.js";
import { validateFootprint } from "../footprint/validate.js";
import { evaluateKeyAt, findKey } from "../identity/keys.js";
import { validateIdentity } from "../identity/validate.js";
import { wellKnownUrlFor } from "../url/url.js";
import { canonicalStatementBytes, statementOf, validateSignatureEnvelope } from "./envelope.js";

export type CheckName =
  | "footprintSchema"
  | "identitySchema"
  | "signatureSchema"
  | "signerBinding"
  | "keyLookup"
  | "keyStateAtSigning"
  | "payloadDigest"
  | "signature"
  | "signerListed"
  | "identityDocumentResolved"
  | "domainRelationship"
  | "claimCurrent";

export type CheckStatus = "pass" | "fail" | "not_checked";

export interface VerificationCheck {
  readonly status: CheckStatus;
  readonly message: string;
}

export type WarningCode = "KEY_RETIRED_LATER" | "KEY_REVOKED_LATER" | "SIGNED_BEFORE_CREATED";

export interface VerificationWarning {
  readonly code: WarningCode;
  readonly message: string;
}

/**
 * Checks that offline verification can answer. The remaining three depend on the network or on
 * registry state and are reported as `not_checked` instead of being silently assumed.
 */
export const OFFLINE_CHECKS: readonly CheckName[] = [
  "footprintSchema",
  "identitySchema",
  "signatureSchema",
  "signerBinding",
  "keyLookup",
  "keyStateAtSigning",
  "payloadDigest",
  "signature",
  "signerListed",
];

export interface VerificationResult {
  /**
   * True only if every offline check passed. This is cryptographic and structural validity of
   * the supplied material; it does NOT establish that `identity` really is what the signer's
   * domain publishes (see the `not_checked` entries), nor that the claim is still current.
   */
  readonly valid: boolean;
  readonly checks: Readonly<Record<CheckName, VerificationCheck>>;
  readonly warnings: readonly VerificationWarning[];
  readonly errors: readonly FootprintError[];
  readonly signer?: { readonly url: string; readonly id: string; readonly keyId: string };
  readonly signedAt?: string;
}

export interface VerifyFootprintInput {
  readonly footprint: unknown;
  readonly signature: unknown;
  /** The identity document for the signer. Verification never fetches it. */
  readonly identity: unknown;
}

const NETWORK_NOTE = "not evaluated by offline verification";

/**
 * Verifies a signed footprint using only the supplied material (SPEC.md §11). Never throws on
 * bad input and never touches the network: every problem becomes a failed check, so callers can
 * show precisely what does and does not hold instead of a single misleading "verified".
 */
export async function verifyFootprint(input: VerifyFootprintInput): Promise<VerificationResult> {
  const checks: Record<CheckName, VerificationCheck> = {
    footprintSchema: { status: "not_checked", message: "not evaluated" },
    identitySchema: { status: "not_checked", message: "not evaluated" },
    signatureSchema: { status: "not_checked", message: "not evaluated" },
    signerBinding: { status: "not_checked", message: "skipped: a document is invalid" },
    keyLookup: { status: "not_checked", message: "skipped: a document is invalid" },
    keyStateAtSigning: { status: "not_checked", message: "skipped: the signing key was not found" },
    payloadDigest: { status: "not_checked", message: "skipped: a document is invalid" },
    signature: { status: "not_checked", message: "skipped: the signing key was not found" },
    signerListed: { status: "not_checked", message: "skipped: a document is invalid" },
    identityDocumentResolved: { status: "not_checked", message: NETWORK_NOTE },
    domainRelationship: { status: "not_checked", message: NETWORK_NOTE },
    claimCurrent: { status: "not_checked", message: NETWORK_NOTE },
  };
  const warnings: VerificationWarning[] = [];
  const errors: FootprintError[] = [];

  const setPass = (name: CheckName, message: string): void => {
    checks[name] = { status: "pass", message };
  };
  const setFail = (name: CheckName, error: FootprintError): void => {
    checks[name] = { status: "fail", message: error.message };
    errors.push(error);
  };
  const finish = (context?: {
    url: string;
    id: string;
    keyId: string;
    signedAt: string;
  }): VerificationResult => ({
    valid: OFFLINE_CHECKS.every((name) => checks[name].status === "pass"),
    checks,
    warnings,
    errors,
    ...(context === undefined
      ? {}
      : {
          signer: { url: context.url, id: context.id, keyId: context.keyId },
          signedAt: context.signedAt,
        }),
  });
  const record = <T>(name: CheckName, result: Result<T>, label: string): T | undefined => {
    if (result.ok) {
      setPass(name, `${label} follows Developer Footprint 1.0`);
      return result.value;
    }
    setFail(name, result.error);
    return undefined;
  };

  const footprint = record("footprintSchema", validateFootprint(input.footprint), "footprint");
  const identity = record("identitySchema", validateIdentity(input.identity), "identity document");
  const envelope = record(
    "signatureSchema",
    validateSignatureEnvelope(input.signature),
    "signature envelope",
  );
  if (footprint === undefined || identity === undefined || envelope === undefined) return finish();

  const context = {
    url: envelope.signer,
    id: envelope.signerId,
    keyId: envelope.keyId,
    signedAt: envelope.signedAt,
  };

  // The identity document must be the one the signature claims: same origin-derived URL, same id.
  const expectedSigner = wellKnownUrlFor(identity.canonicalUrl);
  if (
    expectedSigner.ok &&
    envelope.signer === expectedSigner.value &&
    envelope.signerId === identity.id
  ) {
    setPass("signerBinding", "the signature names the supplied identity");
  } else {
    setFail("signerBinding", {
      code: "SIGNER_MISMATCH",
      message: `the signature names ${envelope.signer} (${envelope.signerId}), which is not the supplied identity (${identity.id})`,
    });
  }

  const key = findKey(identity, envelope.keyId);
  if (key === undefined || key.algorithm !== envelope.algorithm) {
    setFail("keyLookup", {
      code: "KEY_NOT_FOUND",
      message: `the identity does not list an ${envelope.algorithm} key ${envelope.keyId}`,
    });
  } else {
    setPass("keyLookup", `key ${key.id} is listed by the identity`);
    const window = evaluateKeyAt(key, envelope.signedAt);
    if (window.usable) {
      setPass("keyStateAtSigning", `key ${key.id} could sign at ${envelope.signedAt}`);
      if (window.retiredLater) {
        warnings.push({
          code: "KEY_RETIRED_LATER",
          message: `key ${key.id} has since been retired; this does not invalidate earlier signatures`,
        });
      }
      if (window.revokedLater) {
        warnings.push({
          code: "KEY_REVOKED_LATER",
          message: `key ${key.id} was later revoked; the signing time is self-asserted, so confirm the timeline independently`,
        });
      }
    } else {
      setFail("keyStateAtSigning", { code: "KEY_NOT_USABLE", message: window.reason });
    }

    const statementBytes = canonicalStatementBytes(statementOf(envelope));
    if (!statementBytes.ok) {
      setFail("signature", statementBytes.error);
    } else {
      const verified = await verifyEd25519(key.publicKey, statementBytes.value, envelope.signature);
      if (!verified.ok) {
        setFail("signature", verified.error);
      } else if (verified.value) {
        setPass("signature", `the signature matches key ${key.id}`);
      } else {
        setFail("signature", {
          code: "INVALID_SIGNATURE",
          message: "the signature does not match the statement and public key",
        });
      }
    }
  }

  const digest = await digestDocument(footprint);
  if (!digest.ok) {
    setFail("payloadDigest", digest.error);
  } else if (digest.value === envelope.subject.digest && envelope.subject.id === footprint.id) {
    setPass("payloadDigest", "the footprint has not changed since it was signed");
  } else {
    setFail("payloadDigest", {
      code: "DIGEST_MISMATCH",
      message: "the footprint contents do not match the document that was signed",
    });
  }

  if (footprint.contributors.some((contributor) => contributor.identity === envelope.signer)) {
    setPass("signerListed", "the signer is listed as a contributor");
  } else {
    setFail("signerListed", {
      code: "SIGNER_MISMATCH",
      message: "the signer is not listed as a contributor of this footprint",
    });
  }

  if (envelope.signedAt < footprint.createdAt) {
    warnings.push({
      code: "SIGNED_BEFORE_CREATED",
      message: "the signature is dated before the footprint was created",
    });
  }

  return finish(context);
}
