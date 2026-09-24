import { canonicalizeToBytes } from "../canonical/canonicalize.js";
import type { Result } from "../errors/result.js";
import { encodeBase64Url } from "../internal/base64url.js";
import {
  KEY_ALGORITHMS,
  SPEC_VERSION,
  type SignatureEnvelope,
  type SignatureStatement,
} from "../types/index.js";
import {
  readBytes,
  readEnum,
  readId,
  readIdentityDocumentUrl,
  readRecord,
  readSpecVersion,
  readString,
  readTimestamp,
} from "../validation/fields.js";
import { runValidation } from "../validation/validation.js";
import { DIGEST_PREFIX } from "../canonical/digest.js";

export const ENVELOPE_TYPE = "FootprintSignature" as const;

/**
 * Validates a signature envelope (SPEC.md §10). Returns a fresh copy of the known fields.
 * Only the shape is checked here; whether the signature is correct is {@link verifyFootprint}'s job.
 */
export function validateSignatureEnvelope(input: unknown): Result<SignatureEnvelope> {
  return runValidation((v) => {
    const record = readRecord(v, input, "", {
      required: [
        "type",
        "specVersion",
        "algorithm",
        "signer",
        "signerId",
        "keyId",
        "signedAt",
        "subject",
        "signature",
      ],
    });
    if (record === undefined || !readSpecVersion(v, record, "")) return undefined;

    const type = readString(v, record, "type", "", (value) =>
      value === ENVELOPE_TYPE
        ? undefined
        : { code: "invalid_value", message: `must be "${ENVELOPE_TYPE}"` },
    );
    const algorithm = readEnum(v, record, "algorithm", "", KEY_ALGORITHMS);
    const signer = readIdentityDocumentUrl(v, record, "signer", "");
    const signerId = readId(v, record, "signerId", "", "identity");
    const keyId = readId(v, record, "keyId", "", "key");
    const signedAt = readTimestamp(v, record, "signedAt", "");
    const signatureBytes = readBytes(v, record, "signature", "", 64);

    const subject = readRecord(v, record["subject"], "/subject", {
      required: ["type", "id", "digest"],
    });
    let subjectId: string | undefined;
    let digestBytes: Uint8Array | undefined;
    if (subject !== undefined) {
      readString(v, subject, "type", "/subject", (value) =>
        value === "footprint"
          ? undefined
          : { code: "invalid_value", message: 'must be "footprint"' },
      );
      subjectId = readId(v, subject, "id", "/subject", "footprint");
      digestBytes = readBytes(v, subject, "digest", "/subject", 32, DIGEST_PREFIX);
    }

    if (
      type === undefined ||
      algorithm === undefined ||
      signer === undefined ||
      signerId === undefined ||
      keyId === undefined ||
      signedAt === undefined ||
      signatureBytes === undefined ||
      subject === undefined ||
      subjectId === undefined ||
      digestBytes === undefined
    ) {
      return undefined;
    }
    return {
      type: ENVELOPE_TYPE,
      specVersion: SPEC_VERSION,
      algorithm,
      signer,
      signerId,
      keyId,
      signedAt,
      subject: {
        type: "footprint",
        id: subjectId,
        digest: `${DIGEST_PREFIX}${encodeBase64Url(digestBytes)}`,
      },
      signature: encodeBase64Url(signatureBytes),
    };
  });
}

/** The envelope without its signature value: exactly what the signature covers. */
export function statementOf(envelope: SignatureEnvelope): SignatureStatement {
  return {
    type: envelope.type,
    specVersion: envelope.specVersion,
    algorithm: envelope.algorithm,
    signer: envelope.signer,
    signerId: envelope.signerId,
    keyId: envelope.keyId,
    signedAt: envelope.signedAt,
    subject: {
      type: envelope.subject.type,
      id: envelope.subject.id,
      digest: envelope.subject.digest,
    },
  };
}

/**
 * The bytes that are signed: the canonical form of the statement. Binding signer, key, time and
 * the footprint digest into the signed bytes means a signature cannot be moved to another
 * footprint, attributed to another key or identity, or re-dated.
 */
export function canonicalStatementBytes(statement: SignatureStatement): Result<Uint8Array> {
  return canonicalizeToBytes(statement);
}
