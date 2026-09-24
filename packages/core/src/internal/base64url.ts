const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const DECODE: Readonly<Record<string, number>> = Object.fromEntries(
  [...ALPHABET].map((char, index) => [char, index]),
);

/** RFC 4648 §5 base64url, no padding. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!;
    out += ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

/**
 * Strict decoder: rejects padding, characters outside the URL-safe alphabet, impossible lengths
 * and non-zero trailing bits. Accepting only the canonical encoding means one byte string has
 * exactly one textual form, which removes a class of signature-malleability tricks.
 */
export function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (text.length % 4 === 1) return undefined;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const value = DECODE[char];
    if (value === undefined) return undefined;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (buffer >> bits) & 0xff;
      buffer &= (1 << bits) - 1;
    }
  }
  if (buffer !== 0) return undefined; // non-canonical trailing bits
  return out;
}
