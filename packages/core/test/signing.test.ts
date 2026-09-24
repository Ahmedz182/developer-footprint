import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  OFFLINE_CHECKS,
  addIdentityKey,
  canonicalize,
  createFootprint,
  decodeBase64Url,
  encodeBase64Url,
  generateKeyPair,
  signFootprint,
  unwrap,
  verifyFootprint,
  type CheckName,
  type Footprint,
  type Identity,
  type SignatureEnvelope,
  type VerificationResult,
} from "../src/index.js";
import {
  CREATED,
  IDENTITY_ID,
  JOHN_IDENTITY_URL,
  KEY_ID,
  KEY_ID_2,
  RFC8032_SEED_2,
  SIGNED,
  buildFixture,
  clone,
  fixedRandom,
  privateKey,
  publicKeyOf,
} from "./support.js";

const fixture = await buildFixture();

function verify(
  overrides: { footprint?: unknown; signature?: unknown; identity?: unknown } = {},
): Promise<VerificationResult> {
  return verifyFootprint({
    footprint: fixture.footprint,
    signature: fixture.envelope,
    identity: fixture.identity,
    ...overrides,
  });
}

function statuses(result: VerificationResult): Partial<Record<CheckName, string>> {
  return Object.fromEntries(
    Object.entries(result.checks).map(([name, check]) => [name, check.status]),
  );
}

function failed(result: VerificationResult): CheckName[] {
  return (Object.entries(result.checks) as [CheckName, { status: string }][])
    .filter(([, check]) => check.status === "fail")
    .map(([name]) => name);
}

describe("signFootprint", () => {
  it("produces a well-formed, deterministic envelope", async () => {
    expect(fixture.envelope).toMatchObject({
      type: "FootprintSignature",
      specVersion: "1.0",
      algorithm: "Ed25519",
      signer: "https://sarah.example/.well-known/developer-footprint.json",
      signerId: IDENTITY_ID,
      keyId: KEY_ID,
      signedAt: "2026-09-24T12:00:00Z",
      subject: { type: "footprint", id: fixture.footprint.id },
    });
    expect(fixture.envelope.subject.digest).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
    expect(decodeBase64Url(fixture.envelope.signature)?.length).toBe(64);

    // Ed25519 is deterministic: same inputs, same signature, on every run and machine.
    const again = unwrap(
      await signFootprint({
        footprint: fixture.footprint,
        identity: fixture.identity,
        keyId: KEY_ID,
        privateKey: fixture.key,
        signedAt: SIGNED,
      }),
    );
    expect(again).toEqual(fixture.envelope);
  });

  it("signs the validated copy, so extra or reordered input cannot change the result", async () => {
    const reordered = Object.fromEntries(Object.entries(clone(fixture.footprint)).reverse());
    const envelope = unwrap(
      await signFootprint({
        footprint: reordered,
        identity: fixture.identity,
        keyId: KEY_ID,
        privateKey: fixture.key,
        signedAt: SIGNED,
      }),
    );
    expect(envelope).toEqual(fixture.envelope);
    const extra = await signFootprint({
      footprint: { ...clone(fixture.footprint), owner: "me" },
      identity: fixture.identity,
      keyId: KEY_ID,
      privateKey: fixture.key,
    });
    expect(extra).toMatchObject({ ok: false, error: { code: "INVALID_SCHEMA" } });
  });

  it("uses the current time when no signing time is given", async () => {
    // A key created well in the past, so this test does not depend on the wall clock.
    const established = clone(fixture.identity);
    established.keys = [{ ...established.keys[0]!, createdAt: "2026-01-01T00:00:00Z" }];
    const before = Date.now();
    const envelope = unwrap(
      await signFootprint({
        footprint: fixture.footprint,
        identity: established,
        keyId: KEY_ID,
        privateKey: fixture.key,
      }),
    );
    const signedAt = Date.parse(envelope.signedAt);
    expect(signedAt).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(signedAt).toBeLessThanOrEqual(Date.now());
  });

  it("refuses invalid documents", async () => {
    const badFootprint = await signFootprint({
      footprint: { nope: 1 },
      identity: fixture.identity,
      keyId: KEY_ID,
      privateKey: fixture.key,
    });
    expect(badFootprint).toMatchObject({ ok: false, error: { code: "INVALID_SCHEMA" } });
    const badIdentity = await signFootprint({
      footprint: fixture.footprint,
      identity: {},
      keyId: KEY_ID,
      privateKey: fixture.key,
    });
    expect(badIdentity).toMatchObject({ ok: false, error: { code: "INVALID_SCHEMA" } });
    const badTime = await signFootprint({
      footprint: fixture.footprint,
      identity: fixture.identity,
      keyId: KEY_ID,
      privateKey: fixture.key,
      signedAt: "tomorrow",
    });
    expect(badTime).toMatchObject({ ok: false, error: { code: "INVALID_SCHEMA" } });
  });

  it("refuses an unknown key id", async () => {
    const result = await signFootprint({
      footprint: fixture.footprint,
      identity: fixture.identity,
      keyId: KEY_ID_2,
      privateKey: fixture.key,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "KEY_NOT_FOUND" } });
  });

  it("refuses a private key that does not match the published key", async () => {
    const result = await signFootprint({
      footprint: fixture.footprint,
      identity: fixture.identity,
      keyId: KEY_ID,
      privateKey: privateKey(RFC8032_SEED_2),
      signedAt: SIGNED,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_KEY" } });
  });

  it("refuses to sign as an identity that the footprint does not credit", async () => {
    const stranger = unwrap(
      addIdentityKey(
        unwrap(
          await import("../src/index.js").then((m) =>
            m.createIdentity(
              {
                id: "df:identity:01J8Y5N3ZW9ZZR1S7V4X2CGBHJ",
                type: "Person",
                name: "Mallory",
                canonicalUrl: "https://mallory.example",
              },
              { now: CREATED },
            ),
          ),
        ),
        { id: KEY_ID_2, publicKey: await publicKeyOf(privateKey(RFC8032_SEED_2)) },
        { now: CREATED },
      ),
    );
    const result = await signFootprint({
      footprint: fixture.footprint,
      identity: stranger,
      keyId: KEY_ID_2,
      privateKey: privateKey(RFC8032_SEED_2),
      signedAt: SIGNED,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "SIGNER_MISMATCH" } });
  });

  it("refuses to sign with a key outside its validity window", async () => {
    const retired = clone(fixture.identity);
    retired.keys = [{ ...retired.keys[0]!, retiredAt: "2026-09-24T06:00:00Z" }];
    const late = await signFootprint({
      footprint: fixture.footprint,
      identity: retired,
      keyId: KEY_ID,
      privateKey: fixture.key,
      signedAt: SIGNED,
    });
    expect(late).toMatchObject({ ok: false, error: { code: "KEY_NOT_USABLE" } });

    const early = await signFootprint({
      footprint: fixture.footprint,
      identity: fixture.identity,
      keyId: KEY_ID,
      privateKey: fixture.key,
      signedAt: "2026-09-23T23:59:59Z",
    });
    expect(early).toMatchObject({ ok: false, error: { code: "KEY_NOT_USABLE" } });
  });
});

describe("verifyFootprint: the honest path", () => {
  it("passes every offline check and admits what it did not check", async () => {
    const result = await verify();
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    for (const name of OFFLINE_CHECKS) expect(result.checks[name].status, name).toBe("pass");
    // Verification is offline: it must not claim things only the network can establish.
    expect(result.checks.identityDocumentResolved.status).toBe("not_checked");
    expect(result.checks.domainRelationship.status).toBe("not_checked");
    expect(result.checks.claimCurrent.status).toBe("not_checked");
    expect(result.signer).toEqual({
      url: "https://sarah.example/.well-known/developer-footprint.json",
      id: IDENTITY_ID,
      keyId: KEY_ID,
    });
    expect(result.signedAt).toBe("2026-09-24T12:00:00Z");
  });

  it("accepts documents re-read from JSON text", async () => {
    const reread = await verifyFootprint({
      footprint: JSON.parse(JSON.stringify(fixture.footprint)),
      signature: JSON.parse(JSON.stringify(fixture.envelope)),
      identity: JSON.parse(JSON.stringify(fixture.identity)),
    });
    expect(reread.valid).toBe(true);
  });
});

describe("verifyFootprint: tampering", () => {
  it("detects any change to the footprint after signing", async () => {
    const edits: Record<string, (f: Footprint) => unknown> = {
      "project name": (f) => ({ ...f, project: { ...f.project, name: "MyCoolApp Pro" } }),
      "project url": (f) => ({ ...f, project: { ...f.project, url: "https://evil.example/" } }),
      "role escalated to owner": (f) => ({
        ...f,
        contributors: [
          { identity: f.contributors[1]!.identity, role: "owner" },
          f.contributors[0]!,
        ],
      }),
      "contributor added": (f) => ({
        ...f,
        contributors: [
          ...f.contributors,
          {
            identity: "https://mallory.example/.well-known/developer-footprint.json",
            role: "owner",
          },
        ],
      }),
      "contributor removed": (f) => ({ ...f, contributors: [f.contributors[0]!] }),
      "contributor order": (f) => ({ ...f, contributors: [...f.contributors].reverse() }),
      "created date": (f) => ({ ...f, createdAt: "2020-01-01T00:00:00Z" }),
      "supersedes added": (f) => ({ ...f, supersedes: "fp_01J8Y5N3Z0AAAAAAAAAAAAAAAA" }),
    };
    for (const [label, edit] of Object.entries(edits)) {
      const result = await verify({ footprint: edit(clone(fixture.footprint)) });
      expect(result.valid, label).toBe(false);
      expect(failed(result), label).toEqual(["payloadDigest"]);
      expect(
        result.errors.map((e) => e.code),
        label,
      ).toEqual(["DIGEST_MISMATCH"]);
      // The signature itself is still intact: the checks pinpoint what broke.
      expect(result.checks.signature.status, label).toBe("pass");
    }
  });

  it("detects a swapped footprint id even if the content is unchanged", async () => {
    const other = { ...clone(fixture.footprint), id: "fp_01J8Y5N3ZS6XWN8P4R1T9ZDYEG" };
    const result = await verify({ footprint: other });
    expect(failed(result)).toEqual(["payloadDigest"]);
  });

  it("detects any change to the signed statement", async () => {
    const edits: Record<string, Partial<SignatureEnvelope>> = {
      "signing time": { signedAt: "2026-09-24T12:00:01Z" },
      "signed digest": {
        subject: { ...fixture.envelope.subject, digest: `sha256:${"A".repeat(43)}` },
      },
      "subject id": {
        subject: { ...fixture.envelope.subject, id: "fp_01J8Y5N3ZS6XWN8P4R1T9ZDYEG" },
      },
    };
    for (const [label, edit] of Object.entries(edits)) {
      const result = await verify({ signature: { ...clone(fixture.envelope), ...edit } });
      expect(result.valid, label).toBe(false);
      expect(failed(result), label).toContain("signature");
    }
  });

  it("rejects a flipped bit anywhere in the signature", async () => {
    const raw = decodeBase64Url(fixture.envelope.signature)!;
    for (let byte = 0; byte < 64; byte += 7) {
      const damaged = raw.slice();
      damaged[byte] = damaged[byte]! ^ 0x01;
      const result = await verify({
        signature: { ...clone(fixture.envelope), signature: encodeBase64Url(damaged) },
      });
      expect(result.valid, `byte ${byte}`).toBe(false);
      expect(failed(result), `byte ${byte}`).toEqual(["signature"]);
      expect(result.errors[0]?.code).toBe("INVALID_SIGNATURE");
    }
  });

  it("rejects the malleable twin (S + L) of a valid signature", async () => {
    const L = (1n << 252n) + 27742317777372353535851937790883648493n;
    const raw = decodeBase64Url(fixture.envelope.signature)!;
    let s = 0n;
    for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(raw[i]!);
    let twin = s + L;
    const mauled = raw.slice();
    for (let i = 32; i < 64; i++) {
      mauled[i] = Number(twin & 0xffn);
      twin >>= 8n;
    }
    const result = await verify({
      signature: { ...clone(fixture.envelope), signature: encodeBase64Url(mauled) },
    });
    expect(failed(result)).toEqual(["signature"]);
  });

  it("rejects an all-zero signature and a truncated one", async () => {
    const zero = await verify({
      signature: { ...clone(fixture.envelope), signature: encodeBase64Url(new Uint8Array(64)) },
    });
    expect(failed(zero)).toEqual(["signature"]);
    const short = await verify({
      signature: { ...clone(fixture.envelope), signature: encodeBase64Url(new Uint8Array(63)) },
    });
    expect(failed(short)).toEqual(["signatureSchema"]);
  });

  it("rejects malformed envelopes without ever reaching the crypto", async () => {
    for (const signature of [
      null,
      undefined,
      "signature",
      [],
      { ...clone(fixture.envelope), extra: 1 },
      { ...clone(fixture.envelope), signature: "***" },
    ]) {
      const result = await verify({ signature });
      expect(result.valid).toBe(false);
      expect(result.checks.signatureSchema.status).toBe("fail");
      expect(result.checks.signature.status).toBe("not_checked");
    }
  });
});

describe("verifyFootprint: key and identity confusion", () => {
  it("rejects a valid signature checked against the wrong public key", async () => {
    const other = unwrap(await generateKeyPair({ randomBytes: fixedRandom(9) }));
    const swapped = clone(fixture.identity);
    swapped.keys = [{ ...swapped.keys[0]!, publicKey: other.publicKey }];
    const result = await verify({ identity: swapped });
    expect(failed(result)).toEqual(["signature"]);
  });

  it("rejects a signature that names a key the identity does not list", async () => {
    const result = await verify({ signature: { ...clone(fixture.envelope), keyId: KEY_ID_2 } });
    expect(failed(result)).toEqual(["keyLookup"]);
    expect(result.errors[0]?.code).toBe("KEY_NOT_FOUND");
    expect(result.checks.signature.status).toBe("not_checked");
  });

  it("rejects an identity document that is not the one the signature names", async () => {
    // Same key, different domain: an attacker republishing Sarah's public key under their own site.
    const impostor = unwrap(
      await import("../src/index.js").then((m) =>
        m.createIdentity(
          {
            id: IDENTITY_ID,
            type: "Person",
            name: "Sarah",
            canonicalUrl: "https://sarah-dev.example",
          },
          { now: CREATED },
        ),
      ),
    );
    const withKey = unwrap(
      addIdentityKey(
        impostor,
        { id: KEY_ID, publicKey: fixture.identity.keys[0]!.publicKey },
        { now: CREATED },
      ),
    );
    const result = await verify({ identity: withKey });
    expect(failed(result)).toEqual(["signerBinding"]);
    expect(result.errors[0]?.code).toBe("SIGNER_MISMATCH");
    // ...even though the signature itself is mathematically fine.
    expect(result.checks.signature.status).toBe("pass");
  });

  it("rejects a different identity id on the same domain", async () => {
    const result = await verify({
      identity: { ...clone(fixture.identity), id: "df:identity:01J8Y5N3ZW9ZZR1S7V4X2CGBHJ" },
    });
    expect(failed(result)).toEqual(["signerBinding"]);
  });

  it("rejects an identity that publishes a small-order key, even with a 'valid' forged signature", async () => {
    const weak = clone(fixture.identity);
    weak.keys = [
      { ...weak.keys[0]!, publicKey: encodeBase64Url(Uint8Array.of(1, ...new Uint8Array(31))) },
    ];
    const forged = encodeBase64Url(Uint8Array.of(1, ...new Uint8Array(63))); // (R = identity, S = 0)
    const result = await verify({
      identity: weak,
      signature: { ...clone(fixture.envelope), signature: forged },
    });
    expect(result.valid).toBe(false);
    expect(failed(result)).toContain("identitySchema");
  });

  it("requires the signer to be a credited contributor", async () => {
    const footprint = unwrap(
      createFootprint(
        {
          id: fixture.footprint.id,
          project: { id: fixture.footprint.project.id, name: "MyCoolApp" },
          contributors: [{ identity: JOHN_IDENTITY_URL, role: "creator" }],
        },
        { now: CREATED },
      ),
    );
    // Forge the digest so only the contributor rule is in play.
    const { digestDocument } = await import("../src/index.js");
    const digest = unwrap(await digestDocument(footprint));
    const statementBase = {
      ...clone(fixture.envelope),
      subject: { ...fixture.envelope.subject, digest },
    };
    // The signature no longer matches, but signerListed must still fail on its own merits.
    const result = await verify({ footprint, signature: statementBase });
    expect(result.checks.signerListed.status).toBe("fail");
    expect(result.checks.payloadDigest.status).toBe("pass");
    expect(result.valid).toBe(false);
  });
});

describe("verifyFootprint: replay and transplant", () => {
  it("does not let a signature be reused for a different footprint", async () => {
    const otherFootprint = unwrap(
      createFootprint(
        {
          id: "fp_01J8Y5N3ZS6XWN8P4R1T9ZDYEG",
          project: { id: fixture.footprint.project.id, name: "MyCoolApp" },
          contributors: [{ identity: fixture.identity, role: "creator" }],
        },
        { now: CREATED },
      ),
    );
    const result = await verify({ footprint: otherFootprint });
    expect(result.valid).toBe(false);
    expect(failed(result)).toEqual(["payloadDigest"]);
  });

  it("does not let an old signature vouch for a modified successor", async () => {
    const v2 = unwrap(
      createFootprint(
        {
          id: "fp_01J8Y5N3ZS6XWN8P4R1T9ZDYEG",
          supersedes: fixture.footprint.id,
          project: { id: fixture.footprint.project.id, name: "MyCoolApp", version: "2.0.0" },
          contributors: [{ identity: fixture.identity, role: "creator" }],
        },
        { now: new Date("2026-10-01T00:00:00Z") },
      ),
    );
    expect((await verify({ footprint: v2 })).valid).toBe(false);
    // The original stays verifiable: signed history is never rewritten by a successor.
    expect((await verify()).valid).toBe(true);
  });
});

describe("verifyFootprint: protocol version", () => {
  it("does not interpret unknown versions as V1", async () => {
    for (const [name, doc] of [
      ["footprint", { ...clone(fixture.footprint), specVersion: "2.0" }],
      ["identity", { ...clone(fixture.identity), specVersion: "1.1" }],
      ["signature", { ...clone(fixture.envelope), specVersion: "2.0" }],
    ] as const) {
      const key = name === "signature" ? "signature" : name;
      const result = await verify({ [key]: doc });
      expect(result.valid, name).toBe(false);
      expect(result.errors[0]?.code, name).toBe("UNSUPPORTED_VERSION");
    }
  });
});

describe("verifyFootprint: key rotation and revocation", () => {
  const identityWith = (patch: Partial<Identity["keys"][number]>): Identity => {
    const identity = clone(fixture.identity);
    identity.keys = [{ ...identity.keys[0]!, ...patch }];
    return identity;
  };

  it("accepts an old signature after the key was retired, and says so", async () => {
    const result = await verify({ identity: identityWith({ retiredAt: "2026-10-01T00:00:00Z" }) });
    expect(result.valid).toBe(true);
    expect(result.warnings.map((w) => w.code)).toEqual(["KEY_RETIRED_LATER"]);
  });

  it("accepts a signature made before revocation but warns that the timeline is self-asserted", async () => {
    const result = await verify({ identity: identityWith({ revokedAt: "2026-10-01T00:00:00Z" }) });
    expect(result.valid).toBe(true);
    expect(result.warnings.map((w) => w.code)).toEqual(["KEY_REVOKED_LATER"]);
    expect(result.warnings[0]?.message).toContain("self-asserted");
  });

  it("rejects a signature dated after the key was retired or revoked", async () => {
    for (const patch of [
      { retiredAt: "2026-09-24T06:00:00Z" },
      { revokedAt: "2026-09-24T06:00:00Z" },
    ]) {
      const result = await verify({ identity: identityWith(patch) });
      expect(result.valid).toBe(false);
      expect(failed(result)).toEqual(["keyStateAtSigning"]);
      expect(result.errors[0]?.code).toBe("KEY_NOT_USABLE");
    }
  });

  it("rejects a signature dated before the key existed", async () => {
    const result = await verify({ identity: identityWith({ createdAt: "2026-09-25T00:00:00Z" }) });
    expect(failed(result)).toEqual(["keyStateAtSigning"]);
  });

  it("supports several keys: verifies against the one that signed", async () => {
    const second = unwrap(await generateKeyPair({ randomBytes: fixedRandom(3) }));
    const rotated = unwrap(
      addIdentityKey(
        fixture.identity,
        { id: KEY_ID_2, publicKey: second.publicKey },
        { now: new Date("2026-09-24T01:00:00Z") },
      ),
    );
    expect((await verify({ identity: rotated })).valid).toBe(true);
    const signedWithSecond = unwrap(
      await signFootprint({
        footprint: fixture.footprint,
        identity: rotated,
        keyId: KEY_ID_2,
        privateKey: second.privateKey,
        signedAt: SIGNED,
      }),
    );
    const viaSecond = await verify({ identity: rotated, signature: signedWithSecond });
    expect(viaSecond.valid).toBe(true);
    expect(viaSecond.signer?.keyId).toBe(KEY_ID_2);
  });
});

describe("verifyFootprint: warnings", () => {
  it("flags a signature dated before the footprint existed", async () => {
    const early = unwrap(
      await signFootprint({
        footprint: fixture.footprint,
        identity: fixture.identity,
        keyId: KEY_ID,
        privateKey: fixture.key,
        signedAt: "2026-09-24T00:00:00Z",
      }),
    );
    const earlier = { ...fixture.footprint, createdAt: "2026-09-24T09:00:00Z" };
    // createdAt is part of the digest, so re-sign the modified footprint at the earlier time.
    const resigned = unwrap(
      await signFootprint({
        footprint: earlier,
        identity: fixture.identity,
        keyId: KEY_ID,
        privateKey: fixture.key,
        signedAt: "2026-09-24T08:00:00Z",
      }),
    );
    const result = await verify({ footprint: earlier, signature: resigned });
    expect(result.valid).toBe(true);
    expect(result.warnings.map((w) => w.code)).toEqual(["SIGNED_BEFORE_CREATED"]);
    expect(early.signedAt).toBe("2026-09-24T00:00:00Z");
  });
});

describe("verifyFootprint: robustness", () => {
  it("never throws and never reports valid for arbitrary garbage (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.anything(),
        fc.anything(),
        fc.anything(),
        async (footprint, signature, identity) => {
          const result = await verifyFootprint({ footprint, signature, identity });
          return result.valid === false;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("handles hostile objects", async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
        ownKeys() {
          throw new Error("boom");
        },
      },
    );
    const result = await verify({ footprint: hostile, identity: hostile, signature: hostile });
    expect(result.valid).toBe(false);
    expect(statuses(result).footprintSchema).toBe("fail");
  });

  it("canonical statement is stable across runs", () => {
    const { signature: _signature, ...statement } = fixture.envelope;
    expect(canonicalize(statement)).toEqual({
      ok: true,
      value: `{"algorithm":"Ed25519","keyId":"${KEY_ID}","signedAt":"2026-09-24T12:00:00Z","signer":"https://sarah.example/.well-known/developer-footprint.json","signerId":"${IDENTITY_ID}","specVersion":"1.0","subject":{"digest":"${fixture.envelope.subject.digest}","id":"${fixture.footprint.id}","type":"footprint"},"type":"FootprintSignature"}`,
    });
  });
});
