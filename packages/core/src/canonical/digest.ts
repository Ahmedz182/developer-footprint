import { err, ok, type Result } from "../errors/result.js";
import { encodeBase64Url } from "../internal/base64url.js";
import { canonicalizeToBytes } from "./canonicalize.js";

export const DIGEST_PREFIX = "sha256:";

/** SHA-256 of `bytes`, formatted `sha256:<base64url>`. */
export async function sha256Digest(bytes: Uint8Array): Promise<Result<string>> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    return err("CRYPTO_UNAVAILABLE", "this runtime does not provide WebCrypto (crypto.subtle)");
  }
  const hash = await subtle.digest("SHA-256", Uint8Array.from(bytes));
  return ok(`${DIGEST_PREFIX}${encodeBase64Url(new Uint8Array(hash))}`);
}

/** Digest of the canonical form of `value`. Callers pass an already-validated document. */
export async function digestDocument(value: unknown): Promise<Result<string>> {
  const bytes = canonicalizeToBytes(value);
  return bytes.ok ? sha256Digest(bytes.value) : bytes;
}
