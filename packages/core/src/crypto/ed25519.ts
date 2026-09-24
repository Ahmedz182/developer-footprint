import { err, ok, type Result } from "../errors/result.js";
import { decodeBase64Url, encodeBase64Url } from "../internal/base64url.js";
import { isWeakEd25519PublicKey } from "../internal/weak-keys.js";

const ED25519 = { name: "Ed25519" } as const;

/** PKCS#8 wrapper (RFC 8410) that turns a raw 32-byte seed into an importable private key. */
const PKCS8_PREFIX = Uint8Array.of(
  0x30,
  0x2e,
  0x02,
  0x01,
  0x00,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x04,
  0x22,
  0x04,
  0x20,
);

const REDACTED = "[REDACTED Ed25519 private key]";

function subtle(): Result<SubtleCrypto> {
  const candidate = (globalThis.crypto as Crypto | undefined)?.subtle;
  return candidate === undefined
    ? err("CRYPTO_UNAVAILABLE", "this runtime does not provide WebCrypto (crypto.subtle)")
    : ok(candidate);
}

/**
 * An Ed25519 private key. The seed is held in a private field and never appears in
 * `JSON.stringify`, `String()`, template literals or `util.inspect` output (ARCHITECTURE.md §12:
 * private keys are never logged). The only way out is the explicit {@link exportSeed}.
 */
export class PrivateKey {
  readonly #seed: Uint8Array<ArrayBuffer>;

  private constructor(seed: Uint8Array<ArrayBuffer>) {
    this.#seed = seed;
  }

  /** Wraps a raw 32-byte Ed25519 seed. The bytes are copied. */
  static fromSeed(seed: Uint8Array): Result<PrivateKey> {
    if (seed.length !== 32) return err("INVALID_KEY", "an Ed25519 seed must be exactly 32 bytes");
    return ok(new PrivateKey(Uint8Array.from(seed)));
  }

  /** Reads the base64url seed form produced by {@link exportSeed}. */
  static fromExportedSeed(text: string): Result<PrivateKey> {
    const bytes = decodeBase64Url(text);
    return bytes === undefined
      ? err("INVALID_KEY", "the private key is not canonical base64url")
      : PrivateKey.fromSeed(bytes);
  }

  /** Deliberately explicit: returns the secret seed as base64url. Handle the result as a secret. */
  exportSeed(): string {
    return encodeBase64Url(this.#seed);
  }

  async #cryptoKey(): Promise<Result<CryptoKey>> {
    const api = subtle();
    if (!api.ok) return api;
    const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + this.#seed.length);
    pkcs8.set(PKCS8_PREFIX, 0);
    pkcs8.set(this.#seed, PKCS8_PREFIX.length);
    try {
      return ok(await api.value.importKey("pkcs8", pkcs8, ED25519, true, ["sign"]));
    } catch {
      return err("CRYPTO_UNAVAILABLE", "this runtime does not support Ed25519 in WebCrypto");
    }
  }

  /** The matching public key: raw 32 bytes, base64url. */
  async publicKey(): Promise<Result<string>> {
    const key = await this.#cryptoKey();
    const api = subtle();
    if (!key.ok) return key;
    if (!api.ok) return api;
    const jwk = await api.value.exportKey("jwk", key.value);
    if (jwk.x === undefined) return err("INVALID_KEY", "could not derive the public key");
    return ok(jwk.x);
  }

  /** Ed25519 signature (RFC 8032, deterministic) over `message`. */
  async sign(message: Uint8Array): Promise<Result<Uint8Array>> {
    const key = await this.#cryptoKey();
    const api = subtle();
    if (!key.ok) return key;
    if (!api.ok) return api;
    const signature = await api.value.sign(ED25519, key.value, Uint8Array.from(message));
    return ok(new Uint8Array(signature));
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

export interface GeneratedKeyPair {
  readonly publicKey: string;
  readonly privateKey: PrivateKey;
}

export interface GenerateKeyPairOptions {
  /** Randomness source; defaults to `crypto.getRandomValues`. Inject only for deterministic tests. */
  readonly randomBytes?: (length: number) => Uint8Array;
}

export async function generateKeyPair(
  options: GenerateKeyPairOptions = {},
): Promise<Result<GeneratedKeyPair>> {
  const random =
    options.randomBytes ?? ((length) => globalThis.crypto.getRandomValues(new Uint8Array(length)));
  const privateKey = PrivateKey.fromSeed(random(32));
  if (!privateKey.ok) return privateKey;
  const publicKey = await privateKey.value.publicKey();
  if (!publicKey.ok) return publicKey;
  return ok({ publicKey: publicKey.value, privateKey: privateKey.value });
}

/**
 * Verifies an Ed25519 signature. Malformed or weak inputs yield `false`, never an exception; the
 * only error is a runtime without WebCrypto Ed25519. Small-order and non-canonical public keys
 * are refused here as well as in identity validation, so no caller can be tricked into using one.
 */
export async function verifyEd25519(
  publicKey: string,
  message: Uint8Array,
  signature: string,
): Promise<Result<boolean>> {
  const api = subtle();
  if (!api.ok) return api;
  const keyBytes = decodeBase64Url(publicKey);
  const signatureBytes = decodeBase64Url(signature);
  if (keyBytes?.length !== 32 || signatureBytes?.length !== 64) return ok(false);
  if (isWeakEd25519PublicKey(keyBytes)) return ok(false);
  try {
    const key = await api.value.importKey("raw", keyBytes, ED25519, false, ["verify"]);
    return ok(await api.value.verify(ED25519, key, signatureBytes, Uint8Array.from(message)));
  } catch {
    return ok(false);
  }
}

/** Whether this runtime can do Ed25519 at all; used by `doctor`. */
export async function isEd25519Supported(): Promise<boolean> {
  const pair = await generateKeyPair();
  if (!pair.ok) return false;
  const message = new TextEncoder().encode("developer-footprint");
  const signature = await pair.value.privateKey.sign(message);
  if (!signature.ok) return false;
  const verified = await verifyEd25519(
    pair.value.publicKey,
    message,
    encodeBase64Url(signature.value),
  );
  return verified.ok && verified.value;
}
