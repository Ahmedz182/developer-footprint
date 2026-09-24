/**
 * @developer-footprint/core
 *
 * Parse, validate, canonicalize, sign and verify Developer Footprint documents.
 * Deterministic, portable, and network-free: nothing in this package performs I/O, and
 * importing it has no side effects.
 */

// Protocol types and constants
export {
  IDENTITY_TYPES,
  KEY_ALGORITHMS,
  ROLES,
  SPEC_VERSION,
  type Contributor,
  type Footprint,
  type Identity,
  type IdentityKey,
  type IdentityType,
  type KeyAlgorithm,
  type KeyStatus,
  type Project,
  type Role,
  type SignatureEnvelope,
  type SignatureStatement,
  type SpecVersion,
} from "./types/index.js";
export { LIMITS, WELL_KNOWN_PATH } from "./limits.js";

// Errors
export {
  FootprintException,
  err,
  failure,
  ok,
  unwrap,
  type FootprintError,
  type FootprintErrorCode,
  type Issue,
  type IssueCode,
  type Result,
} from "./errors/result.js";

// Parsing and canonicalization
export { parseJson, type JsonValue, type ParseJsonOptions } from "./json/parse.js";
export { canonicalize, canonicalizeToBytes } from "./canonical/canonicalize.js";
export { DIGEST_PREFIX, digestDocument, sha256Digest } from "./canonical/digest.js";

// Identifiers, URLs, encodings
export { generateId, isId, type IdKind, type IdOptions } from "./ids/ids.js";
export {
  describeUrlProblem,
  isIdentityDocumentUrl,
  normalizeUrl,
  wellKnownUrlFor,
} from "./url/url.js";
export { decodeBase64Url, encodeBase64Url } from "./internal/base64url.js";

// Identity
export { validateIdentity } from "./identity/validate.js";
export {
  addIdentityKey,
  createIdentity,
  type CreateIdentityInput,
  type NewIdentityKey,
} from "./identity/create.js";
export { evaluateKeyAt, findKey, getKeyStatus, type KeyWindow } from "./identity/keys.js";

// Project and footprint
export { validateProject } from "./project/validate.js";
export { validateFootprint } from "./footprint/validate.js";
export { createFootprint, type CreateFootprintInput } from "./footprint/create.js";

// Keys and signatures
export {
  PrivateKey,
  generateKeyPair,
  isEd25519Supported,
  verifyEd25519,
  type GenerateKeyPairOptions,
  type GeneratedKeyPair,
} from "./crypto/ed25519.js";
export {
  ENVELOPE_TYPE,
  canonicalStatementBytes,
  statementOf,
  validateSignatureEnvelope,
} from "./signatures/envelope.js";
export { signFootprint, type SignFootprintInput } from "./signatures/sign.js";
export {
  OFFLINE_CHECKS,
  verifyFootprint,
  type CheckName,
  type CheckStatus,
  type VerificationCheck,
  type VerificationResult,
  type VerificationWarning,
  type VerifyFootprintInput,
  type WarningCode,
} from "./signatures/verify.js";
