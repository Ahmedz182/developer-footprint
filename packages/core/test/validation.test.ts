import { describe, expect, it } from "vitest";
import {
  LIMITS,
  encodeBase64Url,
  addIdentityKey,
  createFootprint,
  createIdentity,
  evaluateKeyAt,
  getKeyStatus,
  parseJson,
  unwrap,
  validateFootprint,
  validateIdentity,
  validateProject,
  validateSignatureEnvelope,
  type IdentityKey,
} from "../src/index.js";
import {
  CREATED,
  FOOTPRINT_ID,
  IDENTITY_ID,
  JOHN_IDENTITY_URL,
  KEY_ID,
  KEY_ID_2,
  PROJECT_ID,
  SARAH_IDENTITY_URL,
  buildFixture,
  clone,
  fixedRandom,
  hexToBytes,
} from "./support.js";

const fixture = await buildFixture();

function problems(result: {
  ok: boolean;
  error?: { code: string; issues?: readonly { path: string; code: string }[] };
}): string[] {
  return (result.error?.issues ?? []).map((issue) => `${issue.path}:${issue.code}`);
}

describe("validateIdentity", () => {
  it("accepts a complete identity and returns an independent copy", () => {
    const input = clone(fixture.identity);
    const result = validateIdentity(input);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value).toEqual(fixture.identity);
    input.name = "Mallory";
    expect(result.value.name).toBe("Sarah");
  });

  it("accepts an organization and an identity with no keys or profiles", () => {
    const identity = unwrap(
      createIdentity({
        type: "Organization",
        name: "Acme Engineering",
        canonicalUrl: "https://acme.example",
      }),
    );
    expect(identity.keys).toEqual([]);
    expect(identity.profiles).toBeUndefined();
    expect(validateIdentity(identity).ok).toBe(true);
  });

  it("rejects unknown fields, because unsigned extras must not ride along", () => {
    const result = validateIdentity({ ...clone(fixture.identity), admin: true });
    expect(problems(result)).toEqual(["/admin:unknown_field"]);
  });

  it("reports every missing field", () => {
    const result = validateIdentity({ specVersion: "1.0" });
    expect(problems(result).sort()).toEqual(
      ["/canonicalUrl", "/id", "/keys", "/name", "/type", "/updatedAt"].map(
        (p) => `${p}:missing_field`,
      ),
    );
  });

  it("rejects wrong types instead of coercing them", () => {
    for (const bad of [null, undefined, 1, "x", [], () => 1, new Map(), new Date()]) {
      expect(validateIdentity(bad), Object.prototype.toString.call(bad)).toMatchObject({
        ok: false,
        error: { code: "INVALID_SCHEMA" },
      });
    }
    const wrongTypes = { ...clone(fixture.identity), name: 42, keys: {}, type: ["Person"] };
    expect(problems(validateIdentity(wrongTypes)).sort()).toEqual([
      "/keys:invalid_type",
      "/name:invalid_type",
      "/type:invalid_type",
    ]);
  });

  it("does not accept null for an absent optional field", () => {
    expect(validateIdentity({ ...clone(fixture.identity), profiles: null })).toMatchObject({
      ok: false,
    });
  });

  it("rejects a __proto__ member as an unknown field, not a prototype change", () => {
    const parsed = parseJson(`{"__proto__":{"admin":true},"specVersion":"1.0"}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = validateIdentity(parsed.value);
    expect(problems(result)).toContain("/__proto__:unknown_field");
  });

  describe("protocol version", () => {
    it("rejects a newer or different version as unsupported, not as malformed", () => {
      for (const version of ["2.0", "1.1", "0.9", "10.0"]) {
        const result = validateIdentity({ ...clone(fixture.identity), specVersion: version });
        expect(result, version).toMatchObject({
          ok: false,
          error: { code: "UNSUPPORTED_VERSION" },
        });
      }
    });

    it("does not read a future document as if it were V1, even if it looks like one", () => {
      const future = { ...clone(fixture.identity), specVersion: "2.0", newField: "surprise" };
      expect(validateIdentity(future)).toMatchObject({
        ok: false,
        error: { code: "UNSUPPORTED_VERSION" },
      });
    });

    it("rejects malformed versions", () => {
      for (const version of [1, 1.0, "v1", "1", "1.0.0", "", null, "1.0 "]) {
        const result = validateIdentity({ ...clone(fixture.identity), specVersion: version });
        expect(result, String(version)).toMatchObject({
          ok: false,
          error: { code: "INVALID_SCHEMA" },
        });
      }
    });
  });

  describe("names and URLs", () => {
    const withField = (field: string, value: unknown) =>
      validateIdentity({ ...clone(fixture.identity), [field]: value });

    it("rejects spoofable names", () => {
      expect(withField("name", "Sarah\u{202e}gnp")).toMatchObject({ ok: false });
      expect(withField("name", "Sarah\u001b[2J")).toMatchObject({ ok: false });
      expect(withField("name", "")).toMatchObject({ ok: false });
      expect(withField("name", "x".repeat(LIMITS.maxNameCodePoints + 1))).toMatchObject({
        ok: false,
      });
    });

    it("keeps markup as data: a script tag is a valid, inert name", () => {
      const result = withField("name", "<img src=x onerror=alert(1)>");
      expect(result).toMatchObject({ ok: true });
    });

    it("rejects unsafe or unnormalized canonical URLs", () => {
      for (const url of [
        "javascript:alert(1)",
        "http://sarah.example/",
        "https://sarah.example",
        "https://SARAH.example/",
        "https://localhost/",
        "https://127.0.0.1/",
        "https://[::1]/",
        "https://user:pw@sarah.example/",
        "https://sarah.example/?x=1",
      ]) {
        expect(withField("canonicalUrl", url), url).toMatchObject({ ok: false });
      }
    });

    it("validates profile platforms and links", () => {
      expect(
        withField("profiles", {
          github: "https://github.com/sarah",
          linkedin: "https://linkedin.com/in/sarah",
        }),
      ).toMatchObject({ ok: true });
      expect(problems(withField("profiles", { GitHub: "https://github.com/sarah" }))).toEqual([
        "/profiles/GitHub:invalid_value",
      ]);
      expect(problems(withField("profiles", { __proto__x: "https://github.com/sarah" }))).toEqual([
        "/profiles/__proto__x:invalid_value",
      ]);
      expect(problems(withField("profiles", { github: "javascript:alert(1)" }))).toEqual([
        "/profiles/github:invalid_url",
      ]);
      expect(problems(withField("profiles", { github: 5 }))).toEqual([
        "/profiles/github:invalid_type",
      ]);
      expect(withField("profiles", ["https://github.com/sarah"])).toMatchObject({ ok: false });
      const tooMany = Object.fromEntries(
        Array.from({ length: LIMITS.maxProfiles + 1 }, (_, i) => [
          `site${String(i).padStart(2, "0")}`,
          `https://site${i}.example/x`,
        ]),
      );
      expect(withField("profiles", tooMany)).toMatchObject({ ok: false });
    });
  });

  describe("keys", () => {
    const publicKey = fixture.identity.keys[0]!.publicKey;
    const key = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: KEY_ID,
      algorithm: "Ed25519",
      publicKey,
      createdAt: "2026-09-24T00:00:00Z",
      ...overrides,
    });
    const withKeys = (...keys: Record<string, unknown>[]) =>
      validateIdentity({ ...clone(fixture.identity), keys });

    it("accepts active, retired and revoked keys", () => {
      const other = "G_XWTZ7ZTwIl3xN0Fj9bYq4pE8mQ2u1uHc5oKk3lY6c"; // any canonical 32-byte value
      const result = withKeys(
        key(),
        key({
          id: KEY_ID_2,
          publicKey: other,
          retiredAt: "2026-10-01T00:00:00Z",
          revokedAt: "2026-11-01T00:00:00Z",
        }),
      );
      expect(result).toMatchObject({ ok: true });
    });

    it("rejects an unknown algorithm", () => {
      expect(problems(withKeys(key({ algorithm: "RSA" })))).toEqual([
        "/keys/0/algorithm:invalid_value",
      ]);
    });

    it("rejects malformed public keys", () => {
      for (const bad of [
        "",
        "short",
        `${publicKey}=`,
        publicKey.slice(0, -1),
        `${publicKey}A`,
        publicKey.replace(/.$/, "B"),
      ]) {
        expect(withKeys(key({ publicKey: bad })), bad).toMatchObject({ ok: false });
      }
    });

    it("rejects small-order and non-canonical public keys", () => {
      const identityPoint = encodeBase64Url(hexToBytes(`01${"00".repeat(31)}`)); // y = 1
      expect(problems(withKeys(key({ publicKey: identityPoint })))).toEqual([
        "/keys/0/publicKey:invalid_value",
      ]);
    });

    it("rejects duplicate key ids and duplicate public keys", () => {
      expect(problems(withKeys(key(), key()))).toContain("/keys/1/id:duplicate");
      expect(problems(withKeys(key(), key({ id: KEY_ID_2 })))).toEqual([
        "/keys/1/publicKey:duplicate",
      ]);
    });

    it("rejects impossible key lifecycles", () => {
      expect(problems(withKeys(key({ retiredAt: "2026-01-01T00:00:00Z" })))).toEqual([
        "/keys/0/retiredAt:inconsistent",
      ]);
      expect(problems(withKeys(key({ revokedAt: "2026-01-01T00:00:00Z" })))).toEqual([
        "/keys/0/revokedAt:inconsistent",
      ]);
      expect(
        problems(
          withKeys(key({ retiredAt: "2026-11-01T00:00:00Z", revokedAt: "2026-10-01T00:00:00Z" })),
        ),
      ).toEqual(["/keys/0/revokedAt:inconsistent"]);
    });

    it("limits the number of keys", () => {
      const suffixes = "GHJKMNPQRSTVWXYZ0"; // 17 distinct, valid final characters
      const many = Array.from({ length: LIMITS.maxKeys + 1 }, (_, i) =>
        key({ id: `key_01J8Y5N3ZT7YXP9Q5S2V0AEZF${suffixes[i]}` }),
      );
      expect(many).toHaveLength(17);
      expect(problems(withKeys(...many))).toEqual(["/keys:out_of_range"]);
    });
  });

  describe("hostile input", () => {
    it("turns throwing getters into a validation failure, not an exception", () => {
      const hostile = Object.defineProperty({}, "specVersion", {
        enumerable: true,
        get() {
          throw new Error("boom");
        },
      });
      expect(validateIdentity(hostile)).toMatchObject({
        ok: false,
        error: { code: "INVALID_SCHEMA" },
      });
    });

    it("turns a throwing proxy into a validation failure", () => {
      const proxy = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("boom");
          },
        },
      );
      expect(validateIdentity(proxy)).toMatchObject({ ok: false });
    });

    it("reads each property once, so a getter cannot show validation one value and signing another", () => {
      let reads = 0;
      const shifty = clone(fixture.identity) as unknown as Record<string, unknown>;
      Object.defineProperty(shifty, "name", {
        enumerable: true,
        get() {
          reads++;
          return reads === 1 ? "Sarah" : "Mallory";
        },
      });
      const result = validateIdentity(shifty);
      expect(result.ok && result.value.name).toBe("Sarah");
      expect(reads).toBe(1);
    });

    it("ignores symbol-keyed and non-enumerable properties", () => {
      const input = clone(fixture.identity) as unknown as Record<string | symbol, unknown>;
      input[Symbol("x")] = "hidden";
      Object.defineProperty(input, "stealth", { value: 1, enumerable: false });
      expect(validateIdentity(input)).toMatchObject({ ok: true });
    });

    it("rejects instances of classes", () => {
      class Sneaky {}
      expect(validateIdentity(Object.assign(new Sneaky(), clone(fixture.identity)))).toMatchObject({
        ok: false,
      });
    });
  });
});

describe("key status", () => {
  const base: IdentityKey = {
    id: KEY_ID,
    algorithm: "Ed25519",
    publicKey: "x",
    createdAt: "2026-01-01T00:00:00Z",
  };

  it("derives status from the lifecycle timestamps", () => {
    expect(getKeyStatus(base)).toBe("active");
    expect(getKeyStatus({ ...base, retiredAt: "2026-02-01T00:00:00Z" })).toBe("retired");
    expect(
      getKeyStatus({
        ...base,
        retiredAt: "2026-02-01T00:00:00Z",
        revokedAt: "2026-03-01T00:00:00Z",
      }),
    ).toBe("revoked");
  });

  it("allows signing from creation until retirement, end exclusive", () => {
    const key = { ...base, retiredAt: "2026-02-01T00:00:00Z" };
    expect(evaluateKeyAt(key, "2025-12-31T23:59:59Z")).toMatchObject({ usable: false });
    expect(evaluateKeyAt(key, "2026-01-01T00:00:00Z")).toMatchObject({
      usable: true,
      retiredLater: true,
    });
    expect(evaluateKeyAt(key, "2026-01-31T23:59:59Z")).toMatchObject({ usable: true });
    expect(evaluateKeyAt(key, "2026-02-01T00:00:00Z")).toMatchObject({ usable: false });
  });

  it("stops at revocation even if retirement was later", () => {
    const key = { ...base, retiredAt: "2026-06-01T00:00:00Z", revokedAt: "2026-02-01T00:00:00Z" };
    expect(evaluateKeyAt(key, "2026-03-01T00:00:00Z")).toMatchObject({ usable: false });
  });
});

describe("validateFootprint", () => {
  it("accepts the fixture and returns an independent copy", () => {
    const input = clone(fixture.footprint);
    const result = validateFootprint(input);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value).toEqual(fixture.footprint);
    input.contributors[0]!.role = "owner";
    expect(result.value.contributors[0]!.role).toBe("creator");
  });

  it("accepts every V1 role and nothing else", () => {
    for (const role of [
      "creator",
      "author",
      "maintainer",
      "contributor",
      "owner",
      "organization",
    ]) {
      const result = validateFootprint({
        ...clone(fixture.footprint),
        contributors: [{ identity: SARAH_IDENTITY_URL, role }],
      });
      expect(result, role).toMatchObject({ ok: true });
    }
    for (const role of ["admin", "Creator", "OWNER", "", "co-founder", null, 1]) {
      const result = validateFootprint({
        ...clone(fixture.footprint),
        contributors: [{ identity: SARAH_IDENTITY_URL, role }],
      });
      expect(result, String(role)).toMatchObject({ ok: false });
    }
  });

  it("requires an explicit role: there is no default", () => {
    const result = validateFootprint({
      ...clone(fixture.footprint),
      contributors: [{ identity: SARAH_IDENTITY_URL }],
    });
    expect(problems(result)).toEqual(["/contributors/0/role:missing_field"]);
  });

  it("requires at least one contributor and bounds the list", () => {
    expect(validateFootprint({ ...clone(fixture.footprint), contributors: [] })).toMatchObject({
      ok: false,
    });
    const many = Array.from({ length: LIMITS.maxContributors + 1 }, (_, i) => ({
      identity: `https://c${i}.example/.well-known/developer-footprint.json`,
      role: "contributor",
    }));
    expect(validateFootprint({ ...clone(fixture.footprint), contributors: many })).toMatchObject({
      ok: false,
    });
  });

  it("rejects repeating the same claim, but allows one person several roles", () => {
    const twice = [
      { identity: SARAH_IDENTITY_URL, role: "creator" },
      { identity: SARAH_IDENTITY_URL, role: "creator" },
    ];
    expect(
      problems(validateFootprint({ ...clone(fixture.footprint), contributors: twice })),
    ).toEqual(["/contributors/1:duplicate"]);
    const twoRoles = [
      { identity: SARAH_IDENTITY_URL, role: "creator" },
      { identity: SARAH_IDENTITY_URL, role: "maintainer" },
    ];
    expect(
      validateFootprint({ ...clone(fixture.footprint), contributors: twoRoles }),
    ).toMatchObject({ ok: true });
  });

  it("requires contributors to be identified by identity-document URLs", () => {
    for (const identity of [
      "https://sarah.example/",
      "https://sarah.example",
      "sarah",
      "df:identity:01J8Y5N3ZQ4VTK6M2P9R7XBWCD",
      "http://sarah.example/.well-known/developer-footprint.json",
      "https://127.0.0.1/.well-known/developer-footprint.json",
      "javascript:alert(1)//.well-known/developer-footprint.json",
    ]) {
      const result = validateFootprint({
        ...clone(fixture.footprint),
        contributors: [{ identity, role: "creator" }],
      });
      expect(result, identity).toMatchObject({ ok: false });
    }
  });

  it("validates the embedded project", () => {
    const project = (patch: Record<string, unknown>) =>
      validateFootprint({
        ...clone(fixture.footprint),
        project: { ...clone(fixture.footprint.project), ...patch },
      });
    expect(project({})).toMatchObject({ ok: true });
    expect(problems(project({ url: "javascript:alert(1)" }))).toEqual(["/project/url:invalid_url"]);
    expect(problems(project({ repository: "git@github.com:sarah/mycoolapp.git" }))).toEqual([
      "/project/repository:invalid_url",
    ]);
    expect(problems(project({ id: "df:project:nope" }))).toEqual(["/project/id:invalid_value"]);
    expect(problems(project({ version: "1.0.0; rm -rf /" }))).toEqual([
      "/project/version:invalid_value",
    ]);
    expect(problems(project({ owner: "sarah" }))).toEqual(["/project/owner:unknown_field"]);
    expect(project({ description: "x".repeat(LIMITS.maxDescriptionCodePoints + 1) })).toMatchObject(
      { ok: false },
    );
    expect(project({ description: "line one\nline two" })).toMatchObject({ ok: false });
  });

  it("rejects a project that is missing or the wrong shape", () => {
    const { project: _omitted, ...rest } = clone(fixture.footprint);
    expect(problems(validateFootprint(rest))).toEqual(["/project:missing_field"]);
    expect(validateFootprint({ ...clone(fixture.footprint), project: "MyCoolApp" })).toMatchObject({
      ok: false,
    });
  });

  it("validates supersession", () => {
    const older = "fp_01J8Y5N3Z0AAAAAAAAAAAAAAAA";
    expect(validateFootprint({ ...clone(fixture.footprint), supersedes: older })).toMatchObject({
      ok: true,
    });
    expect(
      problems(validateFootprint({ ...clone(fixture.footprint), supersedes: FOOTPRINT_ID })),
    ).toEqual(["/supersedes:inconsistent"]);
    expect(validateFootprint({ ...clone(fixture.footprint), supersedes: "fp_nope" })).toMatchObject(
      { ok: false },
    );
  });

  it("rejects unsupported versions and malformed timestamps", () => {
    expect(validateFootprint({ ...clone(fixture.footprint), specVersion: "2.0" })).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_VERSION" },
    });
    expect(
      problems(validateFootprint({ ...clone(fixture.footprint), createdAt: "yesterday" })),
    ).toEqual(["/createdAt:invalid_value"]);
  });
});

describe("validateProject", () => {
  it("validates a standalone project", () => {
    expect(validateProject({ id: PROJECT_ID, name: "MyCoolApp" })).toMatchObject({ ok: true });
    expect(validateProject({ name: "MyCoolApp" })).toMatchObject({ ok: false });
  });
});

describe("factories", () => {
  it("createIdentity normalizes user input", () => {
    const identity = unwrap(
      createIdentity(
        {
          type: "Person",
          name: "  Zoe\u{301}  ",
          canonicalUrl: "HTTPS://Sarah.Example",
          profiles: { github: "https://GitHub.com/sarah" },
        },
        { now: CREATED, randomBytes: fixedRandom(7) },
      ),
    );
    expect(identity.name).toBe("Zoé");
    expect(identity.canonicalUrl).toBe("https://sarah.example/");
    expect(identity.profiles).toEqual({ github: "https://github.com/sarah" });
    expect(identity.updatedAt).toBe("2026-09-24T00:00:00Z");
    expect(identity.id).toMatch(/^df:identity:/);
  });

  it("createIdentity reports which field is wrong", () => {
    expect(
      createIdentity({ type: "Person", name: "Sarah", canonicalUrl: "http://sarah.example" }),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_SCHEMA", message: expect.stringContaining("canonicalUrl") as string },
    });
    expect(
      createIdentity({
        type: "Person",
        name: "Sarah",
        canonicalUrl: "https://sarah.example",
        profiles: { github: "nope" },
      }),
    ).toMatchObject({ ok: false });
    expect(
      createIdentity({ type: "Person", name: "", canonicalUrl: "https://sarah.example" }),
    ).toMatchObject({ ok: false });
    expect(
      createIdentity({
        type: "Robot" as "Person",
        name: "R2",
        canonicalUrl: "https://sarah.example",
      }),
    ).toMatchObject({ ok: false });
  });

  it("addIdentityKey appends an active key and refreshes updatedAt", () => {
    const later = new Date("2026-10-01T00:00:00Z");
    const updated = unwrap(
      addIdentityKey(
        fixture.identity,
        { id: KEY_ID_2, publicKey: "G_XWTZ7ZTwIl3xN0Fj9bYq4pE8mQ2u1uHc5oKk3lY6c" },
        { now: later },
      ),
    );
    expect(updated.keys).toHaveLength(2);
    expect(updated.keys[1]).toMatchObject({ id: KEY_ID_2, createdAt: "2026-10-01T00:00:00Z" });
    expect(updated.updatedAt).toBe("2026-10-01T00:00:00Z");
    expect(fixture.identity.keys).toHaveLength(1); // original untouched
    expect(
      addIdentityKey(fixture.identity, {
        id: KEY_ID,
        publicKey: fixture.identity.keys[0]!.publicKey,
      }),
    ).toMatchObject({ ok: false });
  });

  it("createFootprint derives contributor URLs and never invents a role", () => {
    const footprint = unwrap(
      createFootprint(
        {
          project: { name: "  MyCoolApp ", url: "https://MyCoolApp.example" },
          contributors: [
            { identity: fixture.identity, role: "maintainer" },
            {
              identity: "https://John.Example/.well-known/developer-footprint.json",
              role: "contributor",
            },
          ],
        },
        { now: CREATED },
      ),
    );
    expect(footprint.project.name).toBe("MyCoolApp");
    expect(footprint.project.url).toBe("https://mycoolapp.example/");
    expect(footprint.contributors[0]).toEqual({ identity: SARAH_IDENTITY_URL, role: "maintainer" });
    expect(footprint.contributors[1]).toEqual({ identity: JOHN_IDENTITY_URL, role: "contributor" });
    expect(footprint.project.id).toMatch(/^df:project:/);
    expect(footprint.id).toMatch(/^fp_/);
    // Omitting a role is a type error; at runtime it is still rejected.
    const missingRole = createFootprint({
      project: { name: "X" },
      contributors: [{ identity: fixture.identity } as never],
    });
    expect(missingRole).toMatchObject({ ok: false });
  });

  it("createFootprint rejects bad input with a located error", () => {
    const result = createFootprint({
      project: { name: "X", url: "javascript:alert(1)" },
      contributors: [{ identity: fixture.identity, role: "creator" }],
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("project/url") as string },
    });
    expect(createFootprint({ project: { name: "X" }, contributors: [] })).toMatchObject({
      ok: false,
    });
    expect(
      createFootprint({
        project: { name: "X" },
        contributors: [{ identity: "https://sarah.example", role: "creator" }],
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("validateSignatureEnvelope", () => {
  const valid = clone(fixture.envelope);

  it("accepts the fixture envelope", () => {
    expect(validateSignatureEnvelope(valid)).toEqual({ ok: true, value: fixture.envelope });
  });

  it("rejects malformed or extra members", () => {
    const patch = (changes: Record<string, unknown>) =>
      validateSignatureEnvelope({ ...clone(valid), ...changes });
    expect(patch({ signature: "" })).toMatchObject({ ok: false });
    expect(patch({ signature: valid.signature.slice(0, -1) })).toMatchObject({ ok: false });
    expect(patch({ signature: `${valid.signature}A` })).toMatchObject({ ok: false });
    expect(patch({ signature: `${valid.signature.slice(0, -1)}B` })).toMatchObject({ ok: false }); // non-canonical trailing bits
    expect(patch({ type: "IdentitySignature" })).toMatchObject({ ok: false });
    expect(patch({ algorithm: "Ed448" })).toMatchObject({ ok: false });
    expect(patch({ extra: 1 })).toMatchObject({ ok: false });
    expect(patch({ subject: { ...valid.subject, type: "identity" } })).toMatchObject({ ok: false });
    expect(patch({ subject: { ...valid.subject, digest: "sha256:abc" } })).toMatchObject({
      ok: false,
    });
    expect(
      patch({
        subject: { ...valid.subject, digest: valid.subject.digest.replace("sha256:", "md5:") },
      }),
    ).toMatchObject({ ok: false });
    expect(patch({ subject: { ...valid.subject, extra: 1 } })).toMatchObject({ ok: false });
    expect(patch({ signedAt: "2026-09-24" })).toMatchObject({ ok: false });
    expect(patch({ signer: "https://sarah.example/" })).toMatchObject({ ok: false });
    expect(patch({ specVersion: "2.0" })).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_VERSION" },
    });
  });
});

describe("identity constants", () => {
  it("fixtures use the ids the tests assume", () => {
    expect(fixture.identity.id).toBe(IDENTITY_ID);
    expect(fixture.footprint.project.id).toBe(PROJECT_ID);
  });
});
