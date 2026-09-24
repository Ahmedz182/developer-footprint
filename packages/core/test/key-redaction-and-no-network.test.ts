import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  PrivateKey,
  decodeBase64Url,
  encodeBase64Url,
  generateKeyPair,
  isEd25519Supported,
  unwrap,
  verifyEd25519,
} from "../src/index.js";
import {
  RFC8032_PUBLIC_HEX,
  RFC8032_SEED,
  buildFixture,
  hexToBytes,
  privateKey,
  publicKeyOf,
} from "./support.js";

describe("PrivateKey", () => {
  const key = privateKey();
  const seedText = encodeBase64Url(RFC8032_SEED);

  it("derives the public key published in RFC 8032", async () => {
    const derived = decodeBase64Url(await publicKeyOf(key));
    expect(Buffer.from(derived ?? []).toString("hex")).toBe(RFC8032_PUBLIC_HEX);
  });

  it("reproduces the RFC 8032 test-1 signature of the empty message", async () => {
    const signature = unwrap(await key.sign(new Uint8Array()));
    expect(Buffer.from(signature).toString("hex")).toBe(
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    );
    expect(
      await verifyEd25519(await publicKeyOf(key), new Uint8Array(), encodeBase64Url(signature)),
    ).toEqual({ ok: true, value: true });
  });

  it("never reveals the seed through logging, serialization or inspection", () => {
    const renderings = [
      JSON.stringify(key),
      JSON.stringify({ nested: { key } }),
      String(key),
      // Deliberate: interpolating the key is exactly the accident this test guards against.
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      `${key}`,
      inspect(key),
      inspect({ key }, { depth: 5, showHidden: true }),
      JSON.stringify(Object.keys(key)),
      JSON.stringify(Object.getOwnPropertyNames(key)),
      JSON.stringify({ ...key }),
    ];
    for (const text of renderings) {
      expect(text).not.toContain(seedText);
      expect(text.toLowerCase()).not.toContain(Buffer.from(RFC8032_SEED).toString("hex"));
    }
    expect(JSON.stringify(key)).toBe('"[REDACTED Ed25519 private key]"');
  });

  it("exports the seed only on explicit request and round-trips it", async () => {
    expect(key.exportSeed()).toBe(seedText);
    const restored = unwrap(PrivateKey.fromExportedSeed(key.exportSeed()));
    expect(await publicKeyOf(restored)).toBe(await publicKeyOf(key));
  });

  it("rejects malformed seeds", () => {
    expect(PrivateKey.fromSeed(new Uint8Array(31))).toMatchObject({
      ok: false,
      error: { code: "INVALID_KEY" },
    });
    expect(PrivateKey.fromSeed(new Uint8Array(33))).toMatchObject({ ok: false });
    expect(PrivateKey.fromExportedSeed("not base64url!")).toMatchObject({
      ok: false,
      error: { code: "INVALID_KEY" },
    });
    expect(PrivateKey.fromExportedSeed(`${seedText}A`)).toMatchObject({ ok: false });
  });

  it("copies the seed, so later changes to the caller's buffer cannot affect the key", () => {
    const seed = Uint8Array.from(RFC8032_SEED);
    const copy = unwrap(PrivateKey.fromSeed(seed));
    seed.fill(0);
    expect(copy.exportSeed()).toBe(seedText);
  });

  it("generates distinct valid key pairs from real randomness", async () => {
    const a = unwrap(await generateKeyPair());
    const b = unwrap(await generateKeyPair());
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
    expect(await publicKeyOf(a.privateKey)).toBe(a.publicKey);
  });

  it("reports that Ed25519 is available on this runtime", async () => {
    expect(await isEd25519Supported()).toBe(true);
    expect(hexToBytes("00ff")).toEqual(Uint8Array.of(0, 255));
  });
});

describe("zero network (ARCHITECTURE.md §2.4)", () => {
  it("performs no network calls while importing or running the whole pipeline", async () => {
    const trap = vi.fn(() => {
      throw new Error("network access attempted");
    });
    class TrapConstructor {
      constructor() {
        trap();
      }
    }
    vi.stubGlobal("fetch", trap);
    vi.stubGlobal("XMLHttpRequest", TrapConstructor);
    vi.stubGlobal("WebSocket", TrapConstructor);
    vi.stubGlobal("EventSource", TrapConstructor);
    vi.stubGlobal("navigator", { sendBeacon: trap });
    try {
      vi.resetModules();
      await import("../src/index.js"); // importing must be side-effect free
      const fixture = await buildFixture(); // create + sign
      const { verifyFootprint } = await import("../src/index.js");
      const result = await verifyFootprint({
        footprint: fixture.footprint,
        signature: fixture.envelope,
        identity: fixture.identity,
      });
      expect(result.valid).toBe(true);
      expect(trap).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
