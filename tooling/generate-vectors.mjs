// Regenerates spec/test-vectors/*.json from the built core.
//
//   pnpm --filter @developer-footprint/core build && node tooling/generate-vectors.mjs
//
// The vectors are committed. They are anchored to values that do not come from this code base
// (RFC 8032 key and signature, RFC 8785 ordering, SHA-256 of ""), and packages/core/test/vectors.test.ts
// re-checks them, including the signature via node:crypto, so a stale or wrong vector fails CI.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PrivateKey,
  addIdentityKey,
  canonicalStatementBytes,
  canonicalize,
  createFootprint,
  createIdentity,
  decodeBase64Url,
  digestDocument,
  encodeBase64Url,
  signFootprint,
  statementOf,
  unwrap,
  verifyFootprint,
} from "../packages/core/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "spec", "test-vectors");
mkdirSync(outDir, { recursive: true });

const write = (name, value) =>
  writeFileSync(join(outDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));
const hex = (bytes) => Buffer.from(bytes).toString("hex");

// ---------------------------------------------------------------------------------------------
// 1. Canonicalization (SPEC.md §8)
// ---------------------------------------------------------------------------------------------
// Escapes are assembled from data (never typed as \u sequences in source), so no tool or editor
// can silently turn them into raw invisible characters.
const BS = String.fromCharCode(92);
const jsonEscape = (code) => `${BS}u${code.toString(16).padStart(4, "0")}`;
const cp = (...codes) => String.fromCodePoint(...codes);

// [key as written in the JSON text, the key's actual value, the member's value]
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const sortingMembers = [
  [jsonEscape(0x20ac), cp(0x20ac), "Euro Sign"],
  [BS + "r", CR, "Carriage Return"],
  [jsonEscape(0xfb33), cp(0xfb33), "Hebrew Letter Dalet With Dagesh"],
  ["1", "1", "One"],
  [jsonEscape(0xd83d) + jsonEscape(0xde00), cp(0x1f600), "Emoji: Grinning Face"],
  [jsonEscape(0x80), cp(0x80), "Control"],
  [jsonEscape(0xf6), cp(0xf6), "Latin Small Letter O With Diaeresis"],
];
const sortingInput =
  "{" +
  NL +
  sortingMembers.map(([text, , value]) => '  "' + text + '": "' + value + '"').join("," + NL) +
  NL +
  "}";
// Expected order per RFC 8785 section 3.2.3 (UTF-16 code unit order), built with plain
// JSON.stringify so it is independent of core.
const sortingOrder = [CR, "1", cp(0x80), cp(0xf6), cp(0x20ac), cp(0x1f600), cp(0xfb33)];
const sortingCanonical =
  "{" +
  sortingOrder
    .map(
      (key) =>
        JSON.stringify(key) +
        ":" +
        JSON.stringify(sortingMembers.find(([, value]) => value === key)[2]),
    )
    .join(",") +
  "}";

write("canonicalization.json", {
  description:
    "Each case gives JSON text. `canonical` is the exact output of the SPEC.md §8 canonicalization of the parsed value; `reject` means a conforming implementation MUST refuse the input at parse or canonicalization time.",
  cases: [
    { name: "rfc8785-sorting", input: sortingInput, canonical: sortingCanonical },
    {
      name: "nested-objects-and-arrays",
      input: '{"b":[3,2,1],"a":{"d":1,"c":true},"e":null}',
      canonical: '{"a":{"c":true,"d":1},"b":[3,2,1],"e":null}',
    },
    {
      name: "insignificant-whitespace",
      input: ' \n{ "b" : 1 ,\t"a" :\r\n [ ] } ',
      canonical: '{"a":[],"b":1}',
    },
    { name: "empty-containers", input: '{"a":[],"b":{}}', canonical: '{"a":[],"b":{}}' },
    {
      name: "string-escapes",
      input: `"${["0041", "000a", "0009", "0022", "005c", "00e9", "d83d", "de00", "007f", "2028"].map((hex) => `${BS}u${hex}`).join("")}"`,
      canonical: `"A${BS}n${BS}t${BS}"${BS}${BS}${cp(0xe9, 0x1f600, 0x7f, 0x2028)}"`,
    },
    {
      name: "control-characters-use-lowercase-hex",
      input: String.raw`"\u0001\u001f\u001F"`,
      canonical: '"\\u0001\\u001f\\u001f"',
    },
    {
      name: "integers",
      input: "[0,-1,9007199254740991,-9007199254740991]",
      canonical: "[0,-1,9007199254740991,-9007199254740991]",
    },
    {
      name: "solidus-is-not-escaped",
      input: String.raw`"a\/b"`,
      canonical: '"a/b"',
    },
    { name: "reject-duplicate-keys", input: '{"a":1,"a":2}', reject: "duplicate object key" },
    {
      name: "reject-duplicate-keys-after-unescaping",
      input: `{"a":1,"${BS}u0061":2}`,
      reject: "duplicate object key",
    },
    {
      name: "reject-unpaired-surrogate",
      input: String.raw`"\ud800"`,
      reject: "unpaired surrogate",
    },
    { name: "reject-fraction", input: "1.5", reject: "only integers are allowed" },
    { name: "reject-exponent", input: "1e2", reject: "only integers are allowed" },
    { name: "reject-negative-zero", input: "-0", reject: "only integers are allowed" },
    { name: "reject-unsafe-integer", input: "9007199254740992", reject: "integer out of range" },
    { name: "reject-trailing-comma", input: '{"a":1,}', reject: "not JSON" },
    { name: "reject-leading-zero", input: "[01]", reject: "not JSON" },
    { name: "reject-byte-order-mark", input: "\u{feff}{}", reject: "not JSON" },
    { name: "reject-nan", input: "NaN", reject: "not JSON" },
    { name: "reject-single-quotes", input: "{'a':1}", reject: "not JSON" },
  ],
});

// ---------------------------------------------------------------------------------------------
// 2. The reference fixture (all keys are PUBLICLY KNOWN test keys)
// ---------------------------------------------------------------------------------------------
const IDS = {
  identity: "df:identity:01J8Y5N3ZQ4VTK6M2P9R7XBWCD",
  project: "df:project:01J8Y5N3ZR5WVM7N3Q0S8YCXDE",
  footprint: "fp_01J8Y5N3ZS6XWN8P4R1T9ZDYEF",
  key: "key_01J8Y5N3ZT7YXP9Q5S2V0AEZFG",
  key2: "key_01J8Y5N3ZV8ZYQ0R6T3W1BFAGH",
};
const CREATED = new Date("2026-09-24T00:00:00Z");
const SIGNED = new Date("2026-09-24T12:00:00Z");
const JOHN = "https://john.example/.well-known/developer-footprint.json";

// RFC 8032 §7.1 test vector 1. Anyone can sign with this key; it exists only for test vectors.
const seedHex = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const seed = Uint8Array.from(Buffer.from(seedHex, "hex"));
const privateKey = unwrap(PrivateKey.fromSeed(seed));
const publicKey = unwrap(await privateKey.publicKey());

const identity = unwrap(
  addIdentityKey(
    unwrap(
      createIdentity(
        {
          id: IDS.identity,
          type: "Person",
          name: "Sarah",
          canonicalUrl: "https://sarah.example",
          profiles: { github: "https://github.com/sarah" },
        },
        { now: CREATED },
      ),
    ),
    { id: IDS.key, publicKey },
    { now: CREATED },
  ),
);
const footprint = unwrap(
  createFootprint(
    {
      id: IDS.footprint,
      project: {
        id: IDS.project,
        name: "MyCoolApp",
        description: "Example application",
        url: "https://mycoolapp.example",
        repository: "https://github.com/sarah/mycoolapp",
        version: "1.0.0",
      },
      contributors: [
        { identity, role: "creator" },
        { identity: JOHN, role: "contributor" },
      ],
    },
    { now: CREATED },
  ),
);
const sign = async (fp, id, keyId, key, signedAt = SIGNED) =>
  unwrap(await signFootprint({ footprint: fp, identity: id, keyId, privateKey: key, signedAt }));
const envelope = await sign(footprint, identity, IDS.key, privateKey);
const statementBytes = unwrap(canonicalStatementBytes(statementOf(envelope)));

// ---------------------------------------------------------------------------------------------
// 3. Signing and verification (SPEC.md §9-§11)
// ---------------------------------------------------------------------------------------------
async function outcome(name, description, fp, sig, id) {
  const result = await verifyFootprint({ footprint: fp, signature: sig, identity: id });
  return {
    name,
    description,
    footprint: fp,
    signature: sig,
    identity: id,
    expect: {
      valid: result.valid,
      failedChecks: Object.entries(result.checks)
        .filter(([, check]) => check.status === "fail")
        .map(([checkName]) => checkName),
      warnings: result.warnings.map((warning) => warning.code),
    },
  };
}
const withKey = (patch) => {
  const copy = clone(identity);
  copy.keys[0] = { ...copy.keys[0], ...patch };
  return copy;
};
const flipBit = (sig, byte) => {
  const raw = decodeBase64Url(sig.signature);
  raw[byte] ^= 1;
  return { ...clone(sig), signature: encodeBase64Url(raw) };
};

// A validly signed footprint whose signer is not credited in it: only `signerListed` may fail.
const johnOnly = unwrap(
  createFootprint(
    {
      id: IDS.footprint,
      project: { id: IDS.project, name: "MyCoolApp" },
      contributors: [{ identity: JOHN, role: "creator" }],
    },
    { now: CREATED },
  ),
);
const johnOnlyDigest = unwrap(await digestDocument(johnOnly));
const uncreditedStatement = {
  ...statementOf(envelope),
  subject: { ...envelope.subject, digest: johnOnlyDigest },
};
const uncreditedSignature = encodeBase64Url(
  unwrap(await privateKey.sign(unwrap(canonicalStatementBytes(uncreditedStatement)))),
);

const impostor = unwrap(
  addIdentityKey(
    unwrap(
      createIdentity(
        {
          id: IDS.identity,
          type: "Person",
          name: "Sarah",
          canonicalUrl: "https://sarah-dev.example",
        },
        { now: CREATED },
      ),
    ),
    { id: IDS.key, publicKey },
    { now: CREATED },
  ),
);

write("signing.json", {
  description:
    "End-to-end signing vector and verification outcomes (SPEC.md §9-§11). Ed25519 is deterministic (RFC 8032), so every implementation MUST reproduce `canonicalFootprint`, `footprintDigest`, `canonicalStatement` and `signature` exactly. The private key is RFC 8032 §7.1 test vector 1: it is public, and must never be used for a real identity.",
  key: {
    algorithm: "Ed25519",
    source: "RFC 8032 section 7.1, TEST 1",
    seedHex,
    seed: encodeBase64Url(seed),
    publicKeyHex: hex(decodeBase64Url(publicKey)),
    publicKey,
  },
  identity,
  footprint,
  canonicalFootprint: unwrap(canonicalize(footprint)),
  footprintDigest: envelope.subject.digest,
  canonicalStatement: new TextDecoder().decode(statementBytes),
  signature: envelope,
  cases: [
    await outcome("valid", "The reference signature verifies.", footprint, envelope, identity),
    await outcome(
      "role-escalated",
      "A contributor's role was changed from `contributor` to `owner` after signing.",
      {
        ...clone(footprint),
        contributors: [footprint.contributors[0], { identity: JOHN, role: "owner" }],
      },
      envelope,
      identity,
    ),
    await outcome(
      "project-renamed",
      "The project name was changed after signing.",
      { ...clone(footprint), project: { ...footprint.project, name: "MyCoolApp Pro" } },
      envelope,
      identity,
    ),
    await outcome(
      "signature-bit-flipped",
      "One bit of the signature value was flipped.",
      footprint,
      flipBit(envelope, 10),
      identity,
    ),
    await outcome(
      "signing-time-altered",
      "`signedAt` was changed; it is part of the signed statement.",
      footprint,
      { ...clone(envelope), signedAt: "2026-09-24T12:00:01Z" },
      identity,
    ),
    await outcome(
      "wrong-public-key",
      "The identity publishes a different key under the signing key's id.",
      footprint,
      envelope,
      withKey({ publicKey: "G_XWTZ7ZTwIl3xN0Fj9bYq4pE8mQ2u1uHc5oKk3lY6c" }),
    ),
    await outcome(
      "unknown-key-id",
      "The signature names a key the identity does not list.",
      footprint,
      { ...clone(envelope), keyId: IDS.key2 },
      identity,
    ),
    await outcome(
      "key-retired-before-signing",
      "The key was retired before `signedAt`.",
      footprint,
      envelope,
      withKey({ retiredAt: "2026-09-24T06:00:00Z" }),
    ),
    await outcome(
      "key-not-yet-created",
      "The key was created after `signedAt`.",
      footprint,
      envelope,
      withKey({ createdAt: "2026-09-25T00:00:00Z" }),
    ),
    await outcome(
      "key-retired-after-signing",
      "The key was retired after `signedAt`: still valid, with a warning.",
      footprint,
      envelope,
      withKey({ retiredAt: "2026-10-01T00:00:00Z" }),
    ),
    await outcome(
      "key-revoked-after-signing",
      "The key was revoked after `signedAt`: valid, with a warning that the timeline is self-asserted.",
      footprint,
      envelope,
      withKey({ revokedAt: "2026-10-01T00:00:00Z" }),
    ),
    await outcome(
      "key-revoked-before-signing",
      "The key was revoked before `signedAt`.",
      footprint,
      envelope,
      withKey({ revokedAt: "2026-09-24T06:00:00Z" }),
    ),
    await outcome(
      "identity-from-another-domain",
      "A document with the same key and id but a different canonical URL.",
      footprint,
      envelope,
      impostor,
    ),
    await outcome(
      "unsupported-footprint-version",
      "The footprint declares specVersion 2.0.",
      { ...clone(footprint), specVersion: "2.0" },
      envelope,
      identity,
    ),
    await outcome(
      "signer-not-credited",
      "The signature is cryptographically valid but the signer is not a contributor of the footprint.",
      johnOnly,
      {
        ...clone(envelope),
        subject: { ...envelope.subject, digest: johnOnlyDigest },
        signature: uncreditedSignature,
      },
      identity,
    ),
    await outcome(
      "small-order-key",
      "The identity publishes a small-order key and the signature is the classic forgery (R = identity element, S = 0).",
      footprint,
      { ...clone(envelope), signature: encodeBase64Url(Uint8Array.of(1, ...new Uint8Array(63))) },
      withKey({ publicKey: encodeBase64Url(Uint8Array.of(1, ...new Uint8Array(31))) }),
    ),
  ],
});

// ---------------------------------------------------------------------------------------------
// 4. Documents: valid and invalid (SPEC.md §4-§6, §10)
// ---------------------------------------------------------------------------------------------
const identityInvalid = [];
const footprintInvalid = [];
const signatureInvalid = [];

const bad = (list, kind, name, layer, code, path, document) =>
  list.push({
    name,
    kind,
    layer,
    error: { code, ...(path === undefined ? {} : { path }) },
    document,
  });
const editIdentity = (fn) => {
  const copy = clone(identity);
  fn(copy);
  return copy;
};
const editFootprint = (fn) => {
  const copy = clone(footprint);
  fn(copy);
  return copy;
};
const editEnvelope = (fn) => {
  const copy = clone(envelope);
  fn(copy);
  return copy;
};
const S = "INVALID_SCHEMA";
const I = identityInvalid;
const F = footprintInvalid;
const G = signatureInvalid;

bad(I, "identity", "unknown-field", "schema", S, "/admin", { ...clone(identity), admin: true });
bad(
  I,
  "identity",
  "missing-keys",
  "schema",
  S,
  "/keys",
  editIdentity((d) => delete d.keys),
);
bad(
  I,
  "identity",
  "name-wrong-type",
  "schema",
  S,
  "/name",
  editIdentity((d) => (d.name = 42)),
);
bad(
  I,
  "identity",
  "null-optional-field",
  "schema",
  S,
  "/profiles",
  editIdentity((d) => (d.profiles = null)),
);
bad(
  I,
  "identity",
  "unsupported-version",
  "schema",
  "UNSUPPORTED_VERSION",
  undefined,
  editIdentity((d) => (d.specVersion = "2.0")),
);
bad(
  I,
  "identity",
  "unsupported-minor-version",
  "schema",
  "UNSUPPORTED_VERSION",
  undefined,
  editIdentity((d) => (d.specVersion = "1.1")),
);
bad(
  I,
  "identity",
  "unknown-type",
  "schema",
  S,
  "/type",
  editIdentity((d) => (d.type = "Robot")),
);
bad(
  I,
  "identity",
  "malformed-id",
  "schema",
  S,
  "/id",
  editIdentity((d) => (d.id = "df:identity:sarah")),
);
bad(
  I,
  "identity",
  "lookalike-id-character",
  "schema",
  S,
  "/id",
  editIdentity((d) => (d.id = d.id.replace("0", "\u{41e}"))),
);
bad(
  I,
  "identity",
  "http-url",
  "schema",
  S,
  "/canonicalUrl",
  editIdentity((d) => (d.canonicalUrl = "http://sarah.example/")),
);
bad(
  I,
  "identity",
  "javascript-url",
  "schema",
  S,
  "/canonicalUrl",
  editIdentity((d) => (d.canonicalUrl = "javascript:alert(1)")),
);
bad(
  I,
  "identity",
  "url-not-normalized-host-case",
  "schema",
  S,
  "/canonicalUrl",
  editIdentity((d) => (d.canonicalUrl = "https://SARAH.example/")),
);
bad(
  I,
  "identity",
  "url-not-normalized-missing-slash",
  "semantic",
  S,
  "/canonicalUrl",
  editIdentity((d) => (d.canonicalUrl = "https://sarah.example")),
);
bad(
  I,
  "identity",
  "url-with-credentials",
  "schema",
  S,
  "/canonicalUrl",
  editIdentity((d) => (d.canonicalUrl = "https://user:pw@sarah.example/")),
);
bad(
  I,
  "identity",
  "url-with-port",
  "schema",
  S,
  "/canonicalUrl",
  editIdentity((d) => (d.canonicalUrl = "https://sarah.example:8443/")),
);
bad(
  I,
  "identity",
  "url-with-query",
  "schema",
  S,
  "/canonicalUrl",
  editIdentity((d) => (d.canonicalUrl = "https://sarah.example/?a=1")),
);
bad(
  I,
  "identity",
  "url-localhost",
  "semantic",
  S,
  "/canonicalUrl",
  editIdentity((d) => (d.canonicalUrl = "https://localhost/")),
);
bad(
  I,
  "identity",
  "url-ipv4-literal",
  "semantic",
  S,
  "/canonicalUrl",
  editIdentity((d) => (d.canonicalUrl = "https://127.0.0.1/")),
);
bad(
  I,
  "identity",
  "url-cloud-metadata-address",
  "semantic",
  S,
  "/canonicalUrl",
  editIdentity((d) => (d.canonicalUrl = "https://169.254.169.254/")),
);
bad(
  I,
  "identity",
  "url-ipv6-literal",
  "schema",
  S,
  "/canonicalUrl",
  editIdentity((d) => (d.canonicalUrl = "https://[::1]/")),
);
bad(
  I,
  "identity",
  "url-internal-suffix",
  "semantic",
  S,
  "/canonicalUrl",
  editIdentity((d) => (d.canonicalUrl = "https://db.internal/")),
);
bad(
  I,
  "identity",
  "url-idn-not-punycode",
  "schema",
  S,
  "/canonicalUrl",
  editIdentity((d) => (d.canonicalUrl = "https://\u{430}pple.com/")),
);
bad(
  I,
  "identity",
  "name-empty",
  "schema",
  S,
  "/name",
  editIdentity((d) => (d.name = "")),
);
bad(
  I,
  "identity",
  "name-bidi-override",
  "semantic",
  S,
  "/name",
  editIdentity((d) => (d.name = "Sarah\u{202e}gnp.exe")),
);
bad(
  I,
  "identity",
  "name-control-character",
  "semantic",
  S,
  "/name",
  editIdentity((d) => (d.name = "Sarah\u001b[2J")),
);
bad(
  I,
  "identity",
  "name-zero-width-space",
  "semantic",
  S,
  "/name",
  editIdentity((d) => (d.name = "Sa\u{200b}rah")),
);
bad(
  I,
  "identity",
  "name-leading-space",
  "semantic",
  S,
  "/name",
  editIdentity((d) => (d.name = " Sarah")),
);
bad(
  I,
  "identity",
  "name-not-nfc",
  "semantic",
  S,
  "/name",
  editIdentity((d) => (d.name = "Cafe\u{301}")),
);
bad(
  I,
  "identity",
  "name-too-long",
  "schema",
  S,
  "/name",
  editIdentity((d) => (d.name = "x".repeat(101))),
);
bad(
  I,
  "identity",
  "profile-bad-platform-name",
  "schema",
  S,
  "/profiles/GitHub",
  editIdentity((d) => (d.profiles = { GitHub: "https://github.com/sarah" })),
);
bad(
  I,
  "identity",
  "profile-javascript-url",
  "schema",
  S,
  "/profiles/github",
  editIdentity((d) => (d.profiles = { github: "javascript:alert(1)" })),
);
bad(
  I,
  "identity",
  "key-unknown-algorithm",
  "schema",
  S,
  "/keys/0/algorithm",
  editIdentity((d) => (d.keys[0].algorithm = "RSA")),
);
bad(
  I,
  "identity",
  "key-public-key-padded",
  "schema",
  S,
  "/keys/0/publicKey",
  editIdentity((d) => (d.keys[0].publicKey += "=")),
);
bad(
  I,
  "identity",
  "key-public-key-noncanonical-encoding",
  "schema",
  S,
  "/keys/0/publicKey",
  editIdentity((d) => (d.keys[0].publicKey = d.keys[0].publicKey.slice(0, -1) + "B")),
);
bad(
  I,
  "identity",
  "key-public-key-wrong-length",
  "schema",
  S,
  "/keys/0/publicKey",
  editIdentity((d) => (d.keys[0].publicKey = d.keys[0].publicKey.slice(0, 40))),
);
bad(
  I,
  "identity",
  "key-small-order-public-key",
  "semantic",
  S,
  "/keys/0/publicKey",
  editIdentity(
    (d) => (d.keys[0].publicKey = encodeBase64Url(Uint8Array.of(1, ...new Uint8Array(31)))),
  ),
);
bad(
  I,
  "identity",
  "key-noncanonical-point-encoding",
  "semantic",
  S,
  "/keys/0/publicKey",
  editIdentity(
    (d) =>
      (d.keys[0].publicKey = encodeBase64Url(
        Uint8Array.from([0xee, ...new Array(30).fill(0xff), 0x7f]),
      )),
  ),
);
bad(
  I,
  "identity",
  "key-duplicate-id",
  "semantic",
  S,
  "/keys/1/id",
  editIdentity((d) =>
    d.keys.push({ ...d.keys[0], publicKey: "G_XWTZ7ZTwIl3xN0Fj9bYq4pE8mQ2u1uHc5oKk3lY6c" }),
  ),
);
bad(
  I,
  "identity",
  "key-duplicate-public-key",
  "semantic",
  S,
  "/keys/1/publicKey",
  editIdentity((d) => d.keys.push({ ...d.keys[0], id: IDS.key2 })),
);
bad(
  I,
  "identity",
  "key-retired-before-created",
  "semantic",
  S,
  "/keys/0/retiredAt",
  editIdentity((d) => (d.keys[0].retiredAt = "2026-01-01T00:00:00Z")),
);
bad(
  I,
  "identity",
  "key-revoked-before-retired",
  "semantic",
  S,
  "/keys/0/revokedAt",
  editIdentity((d) => {
    d.keys[0].retiredAt = "2026-11-01T00:00:00Z";
    d.keys[0].revokedAt = "2026-10-01T00:00:00Z";
  }),
);
bad(
  I,
  "identity",
  "timestamp-fractional-seconds",
  "schema",
  S,
  "/updatedAt",
  editIdentity((d) => (d.updatedAt = "2026-09-24T00:00:00.000Z")),
);
bad(
  I,
  "identity",
  "timestamp-offset",
  "schema",
  S,
  "/updatedAt",
  editIdentity((d) => (d.updatedAt = "2026-09-24T00:00:00+00:00")),
);
bad(
  I,
  "identity",
  "timestamp-impossible-date",
  "semantic",
  S,
  "/updatedAt",
  editIdentity((d) => (d.updatedAt = "2026-02-30T00:00:00Z")),
);
bad(
  I,
  "identity",
  "timestamp-leap-second",
  "semantic",
  S,
  "/updatedAt",
  editIdentity((d) => (d.updatedAt = "2026-06-30T23:59:60Z")),
);

bad(F, "footprint", "unknown-field", "schema", S, "/owner", {
  ...clone(footprint),
  owner: "sarah",
});
bad(
  F,
  "footprint",
  "unsupported-version",
  "schema",
  "UNSUPPORTED_VERSION",
  undefined,
  editFootprint((d) => (d.specVersion = "2.0")),
);
bad(
  F,
  "footprint",
  "missing-project",
  "schema",
  S,
  "/project",
  editFootprint((d) => delete d.project),
);
bad(
  F,
  "footprint",
  "project-missing-id",
  "schema",
  S,
  "/project/id",
  editFootprint((d) => delete d.project.id),
);
bad(
  F,
  "footprint",
  "project-unknown-field",
  "schema",
  S,
  "/project/owner",
  editFootprint((d) => (d.project.owner = "sarah")),
);
bad(
  F,
  "footprint",
  "project-javascript-url",
  "schema",
  S,
  "/project/url",
  editFootprint((d) => (d.project.url = "javascript:alert(1)")),
);
bad(
  F,
  "footprint",
  "project-ssh-repository",
  "schema",
  S,
  "/project/repository",
  editFootprint((d) => (d.project.repository = "git@github.com:sarah/mycoolapp.git")),
);
bad(
  F,
  "footprint",
  "project-version-with-shell-metacharacters",
  "schema",
  S,
  "/project/version",
  editFootprint((d) => (d.project.version = "1.0.0; rm -rf /")),
);
bad(
  F,
  "footprint",
  "project-description-multiline",
  "semantic",
  S,
  "/project/description",
  editFootprint((d) => (d.project.description = "line one\nline two")),
);
bad(
  F,
  "footprint",
  "no-contributors",
  "schema",
  S,
  "/contributors",
  editFootprint((d) => (d.contributors = [])),
);
bad(
  F,
  "footprint",
  "role-unknown",
  "schema",
  S,
  "/contributors/0/role",
  editFootprint((d) => (d.contributors[0].role = "admin")),
);
bad(
  F,
  "footprint",
  "role-wrong-case",
  "schema",
  S,
  "/contributors/0/role",
  editFootprint((d) => (d.contributors[0].role = "Creator")),
);
bad(
  F,
  "footprint",
  "role-missing",
  "schema",
  S,
  "/contributors/0/role",
  editFootprint((d) => delete d.contributors[0].role),
);
bad(
  F,
  "footprint",
  "contributor-not-identity-document-url",
  "schema",
  S,
  "/contributors/0/identity",
  editFootprint((d) => (d.contributors[0].identity = "https://sarah.example/")),
);
bad(
  F,
  "footprint",
  "contributor-identity-by-id",
  "schema",
  S,
  "/contributors/0/identity",
  editFootprint((d) => (d.contributors[0].identity = IDS.identity)),
);
bad(
  F,
  "footprint",
  "contributor-http-identity",
  "schema",
  S,
  "/contributors/0/identity",
  editFootprint(
    (d) =>
      (d.contributors[0].identity = "http://sarah.example/.well-known/developer-footprint.json"),
  ),
);
bad(
  F,
  "footprint",
  "contributor-duplicate-claim",
  "semantic",
  S,
  "/contributors/2",
  editFootprint((d) => d.contributors.push(clone(d.contributors[0]))),
);
bad(
  F,
  "footprint",
  "supersedes-itself",
  "semantic",
  S,
  "/supersedes",
  editFootprint((d) => (d.supersedes = d.id)),
);
bad(
  F,
  "footprint",
  "supersedes-malformed",
  "schema",
  S,
  "/supersedes",
  editFootprint((d) => (d.supersedes = "fp_nope")),
);
bad(
  F,
  "footprint",
  "created-at-not-utc",
  "schema",
  S,
  "/createdAt",
  editFootprint((d) => (d.createdAt = "2026-09-24T05:00:00+05:00")),
);

bad(G, "signature", "unknown-field", "schema", S, "/extra", { ...clone(envelope), extra: 1 });
bad(
  G,
  "signature",
  "wrong-type",
  "schema",
  S,
  "/type",
  editEnvelope((d) => (d.type = "IdentitySignature")),
);
bad(
  G,
  "signature",
  "unsupported-version",
  "schema",
  "UNSUPPORTED_VERSION",
  undefined,
  editEnvelope((d) => (d.specVersion = "2.0")),
);
bad(
  G,
  "signature",
  "unknown-algorithm",
  "schema",
  S,
  "/algorithm",
  editEnvelope((d) => (d.algorithm = "Ed448")),
);
bad(
  G,
  "signature",
  "signer-not-identity-document-url",
  "schema",
  S,
  "/signer",
  editEnvelope((d) => (d.signer = "https://sarah.example/")),
);
bad(
  G,
  "signature",
  "signature-too-short",
  "schema",
  S,
  "/signature",
  editEnvelope((d) => (d.signature = d.signature.slice(0, -2))),
);
bad(
  G,
  "signature",
  "signature-noncanonical-encoding",
  "schema",
  S,
  "/signature",
  editEnvelope((d) => (d.signature = d.signature.slice(0, -1) + "B")),
);
bad(
  G,
  "signature",
  "signature-padded",
  "schema",
  S,
  "/signature",
  editEnvelope((d) => (d.signature += "==")),
);
bad(
  G,
  "signature",
  "digest-wrong-prefix",
  "schema",
  S,
  "/subject/digest",
  editEnvelope((d) => (d.subject.digest = d.subject.digest.replace("sha256:", "sha1:"))),
);
bad(
  G,
  "signature",
  "digest-too-short",
  "schema",
  S,
  "/subject/digest",
  editEnvelope((d) => (d.subject.digest = "sha256:abc")),
);
bad(
  G,
  "signature",
  "subject-wrong-type",
  "schema",
  S,
  "/subject/type",
  editEnvelope((d) => (d.subject.type = "identity")),
);
bad(
  G,
  "signature",
  "subject-unknown-field",
  "schema",
  S,
  "/subject/extra",
  editEnvelope((d) => (d.subject.extra = 1)),
);
bad(
  G,
  "signature",
  "signed-at-date-only",
  "schema",
  S,
  "/signedAt",
  editEnvelope((d) => (d.signedAt = "2026-09-24")),
);

write("documents.json", {
  description:
    'Valid and invalid V1 documents. `layer: "schema"` means the JSON Schema in spec/schemas MUST also reject the document; `layer: "semantic"` means only the additional rules of SPEC.md do. `error.code` is the protocol error code; `error.path` is the JSON Pointer of the first problem (absent for UNSUPPORTED_VERSION).',
  valid: [
    { name: "person-with-key-and-profile", kind: "identity", document: identity },
    {
      name: "organization-without-keys",
      kind: "identity",
      document: unwrap(
        createIdentity(
          {
            id: "df:identity:01J8Y5N3ZX0ZZS2T8W5Y3DHCJK",
            type: "Organization",
            name: "Acme Engineering",
            canonicalUrl: "https://acme.example",
          },
          { now: CREATED },
        ),
      ),
    },
    {
      name: "person-with-retired-and-revoked-keys",
      kind: "identity",
      document: editIdentity((d) => {
        d.keys[0].retiredAt = "2026-10-01T00:00:00Z";
        d.keys.push({
          id: IDS.key2,
          algorithm: "Ed25519",
          publicKey: "G_XWTZ7ZTwIl3xN0Fj9bYq4pE8mQ2u1uHc5oKk3lY6c",
          createdAt: "2026-10-01T00:00:00Z",
          retiredAt: "2026-11-01T00:00:00Z",
          revokedAt: "2026-12-01T00:00:00Z",
        });
      }),
    },
    { name: "two-contributors-with-project-details", kind: "footprint", document: footprint },
    {
      name: "minimal-footprint",
      kind: "footprint",
      document: {
        specVersion: "1.0",
        id: "fp_01J8Y5N3ZY1AAT3V9X6Z4EJDKM",
        project: { id: "df:project:01J8Y5N3ZZ2BBV4W0Y7A5FKEMN", name: "Tiny" },
        contributors: [
          {
            identity: "https://sarah.example/.well-known/developer-footprint.json",
            role: "maintainer",
          },
        ],
        createdAt: "2026-09-24T00:00:00Z",
      },
    },
    {
      name: "footprint-superseding-another",
      kind: "footprint",
      document: editFootprint((d) => {
        d.id = "fp_01J8Y5N3ZY1AAT3V9X6Z4EJDKM";
        d.supersedes = IDS.footprint;
      }),
    },
    {
      name: "one-person-several-roles",
      kind: "footprint",
      document: editFootprint((d) =>
        d.contributors.push({ identity: d.contributors[0].identity, role: "maintainer" }),
      ),
    },
    {
      name: "markup-in-text-is-just-text",
      kind: "footprint",
      document: editFootprint((d) => (d.project.name = "<img src=x onerror=alert(1)>")),
    },
    { name: "reference-signature", kind: "signature", document: envelope },
  ],
  invalid: [...identityInvalid, ...footprintInvalid, ...signatureInvalid],
});

console.log(`Wrote vectors to ${outDir}`);

// ---------------------------------------------------------------------------------------------
// 5. Reference example (the same public-test-key documents, as plain files for spec readers)
// ---------------------------------------------------------------------------------------------
const examplesDir = join(root, "spec", "examples");
mkdirSync(examplesDir, { recursive: true });
const writeExample = (name, value) =>
  writeFileSync(join(examplesDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
writeExample("identity.json", identity);
writeExample("footprint.json", footprint);
writeExample("footprint.sig", envelope);
