/**
 * Machine-readable error codes. Human-readable messages are separate and may change between
 * releases; codes are part of the public contract (ARCHITECTURE.md §35).
 */
export type FootprintErrorCode =
  | "INVALID_JSON"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_SCHEMA"
  | "UNSUPPORTED_VERSION"
  | "UNCANONICALIZABLE"
  | "INVALID_KEY"
  | "KEY_NOT_FOUND"
  | "KEY_NOT_USABLE"
  | "DIGEST_MISMATCH"
  | "INVALID_SIGNATURE"
  | "SIGNER_MISMATCH"
  | "CRYPTO_UNAVAILABLE";

export type IssueCode =
  | "invalid_type"
  | "missing_field"
  | "unknown_field"
  | "invalid_value"
  | "invalid_url"
  | "not_normalized"
  | "duplicate"
  | "out_of_range"
  | "inconsistent";

/** One concrete problem inside a document. `path` is a JSON Pointer (RFC 6901); "" is the root. */
export interface Issue {
  readonly path: string;
  readonly code: IssueCode;
  readonly message: string;
}

export interface FootprintError {
  readonly code: FootprintErrorCode;
  readonly message: string;
  readonly issues?: readonly Issue[];
}

export type Result<T, E = FootprintError> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err(
  code: FootprintErrorCode,
  message: string,
  issues?: readonly Issue[],
): Result<never> {
  return { ok: false, error: issues === undefined ? { code, message } : { code, message, issues } };
}

export function failure(error: FootprintError): Result<never> {
  return { ok: false, error };
}

/** Thrown only by {@link unwrap}. Ordinary validation flow never throws. */
export class FootprintException extends Error {
  readonly code: FootprintErrorCode;
  readonly issues: readonly Issue[];

  constructor(error: FootprintError) {
    super(`${error.code}: ${error.message}`);
    this.name = "FootprintException";
    this.code = error.code;
    this.issues = error.issues ?? [];
  }
}

/** Convenience for callers (scripts, tests) that prefer exceptions over result handling. */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new FootprintException(result.error);
}
