/**
 * Ed25519 public keys that must never be accepted. WebCrypto (OpenSSL) happily imports the eight
 * small-order points and non-canonical encodings, and under a small-order key a forged signature
 * such as (R = identity, S = 0) verifies for *every* message. A published key like that would
 * make signature verification meaningless.
 *
 * A point has small order exactly when its y coordinate is one of five values:
 * 0, 1, -1, and the two order-8 values below (derived from the curve equation
 * d*u^2 - 2u - 1 = 0 with u = x^2, and cross-checked against the runtime in the test suite).
 * The sign of x does not matter, and a y that is not reduced mod p is a non-canonical encoding.
 */
const P = (1n << 255n) - 19n;

function fromLittleEndianHex(hex: string): bigint {
  let value = 0n;
  for (let i = hex.length - 2; i >= 0; i -= 2)
    value = (value << 8n) | BigInt(parseInt(hex.slice(i, i + 2), 16));
  return value;
}

const SMALL_ORDER_Y: ReadonlySet<bigint> = new Set([
  0n,
  1n,
  P - 1n,
  fromLittleEndianHex("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05"),
  fromLittleEndianHex("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"),
]);

/** True if the raw 32-byte key has small order or is not the canonical encoding of its point. */
export function isWeakEd25519PublicKey(key: Uint8Array): boolean {
  if (key.length !== 32) return true;
  let y = 0n;
  for (let i = 31; i >= 0; i--) {
    const byte = i === 31 ? key[i]! & 0x7f : key[i]!; // drop the sign bit of x
    y = (y << 8n) | BigInt(byte);
  }
  return y >= P || SMALL_ORDER_Y.has(y);
}
