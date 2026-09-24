import { describe, expect, it } from "vitest";
import {
  decodeBase64Url,
  encodeBase64Url,
  generateKeyPair,
  unwrap,
  verifyEd25519,
} from "../src/index.js";
import { isWeakEd25519PublicKey } from "../src/internal/weak-keys.js";
import {
  RFC8032_PUBLIC_HEX,
  RFC8032_SEED_2,
  hexToBytes,
  privateKey,
  publicKeyOf,
} from "./support.js";

/** Encodings of the eight small-order points, plus non-canonical ones. */
const WEAK: Record<string, string> = {
  "identity (y=1)": "0100000000000000000000000000000000000000000000000000000000000000",
  "order 2 (y=-1)": "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "order 4 (y=0, x+)": "0000000000000000000000000000000000000000000000000000000000000000",
  "order 4 (y=0, x-)": "0000000000000000000000000000000000000000000000000000000000000080",
  "order 8 a": "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "order 8 a (x-)": "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  "order 8 b": "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "order 8 b (x-)": "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
  "non-canonical y=p": "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "non-canonical y=p+1": "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
};

describe("weak Ed25519 public keys", () => {
  for (const [label, hex] of Object.entries(WEAK)) {
    it(`flags ${label}`, () => {
      expect(isWeakEd25519PublicKey(hexToBytes(hex))).toBe(true);
    });
  }

  it("does not flag ordinary keys", async () => {
    expect(isWeakEd25519PublicKey(hexToBytes(RFC8032_PUBLIC_HEX))).toBe(false);

    // Published RFC 8032 §7.1 test 2 key, derived from its seed rather than typed in.
    const second = await publicKeyOf(privateKey(RFC8032_SEED_2));
    expect(Buffer.from(decodeBase64Url(second) ?? []).toString("hex")).toBe(
      "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    );

    for (let i = 0; i < 100; i++) {
      const pair = unwrap(await generateKeyPair());
      expect(isWeakEd25519PublicKey(decodeBase64Url(pair.publicKey) ?? new Uint8Array())).toBe(
        false,
      );
    }
  });

  it("flags keys of the wrong length", () => {
    expect(isWeakEd25519PublicKey(new Uint8Array(31))).toBe(true);
    expect(isWeakEd25519PublicKey(new Uint8Array(33))).toBe(true);
  });

  it("refuses the classic forgery under the identity key", async () => {
    // As of Node 22.18, WebCrypto imports small-order keys and accepts (R = identity, S = 0)
    // for every message. The verifier must refuse regardless of what the runtime does.
    const identity = hexToBytes(WEAK["identity (y=1)"]!);
    const forged = new Uint8Array(64);
    forged.set(identity, 0);
    const message = new TextEncoder().encode("any message at all");
    expect(
      await verifyEd25519(encodeBase64Url(identity), message, encodeBase64Url(forged)),
    ).toEqual({
      ok: true,
      value: false,
    });
  });

  it("refuses every weak key on every message, valid-looking signature or not", async () => {
    const message = new TextEncoder().encode("hello");
    const zeroSignature = encodeBase64Url(new Uint8Array(64));
    for (const [label, hex] of Object.entries(WEAK)) {
      const result = await verifyEd25519(encodeBase64Url(hexToBytes(hex)), message, zeroSignature);
      expect(result, label).toEqual({ ok: true, value: false });
    }
  });
});
