# @developer-footprint/core

Parse, validate, canonicalize, **sign** and **verify** [Developer Footprint](https://github.com/Ahmedz182/developer-footprint#readme)
documents: verifiable authorship and provenance for software projects.

> Developer Footprint does not track application users, collect hidden telemetry, or require
> runtime network requests. This package performs **no I/O at all**: no HTTP, no filesystem, no
> analytics. Importing it has no side effects, and it has zero runtime dependencies (it uses the
> platform's WebCrypto).

```bash
npm install @developer-footprint/core        # Node >= 22, modern browsers, edge runtimes
```

## Sixty seconds

```ts
import {
  PrivateKey,
  addIdentityKey,
  createFootprint,
  createIdentity,
  generateId,
  generateKeyPair,
  signFootprint,
  unwrap,
  verifyFootprint,
} from "@developer-footprint/core";

// 1. An identity. Ids are random and generated locally: no registration, no network.
const person = unwrap(
  createIdentity({ type: "Person", name: "Sarah", canonicalUrl: "https://sarah.example" }),
);

// 2. A key. The private half never leaves your control.
const { publicKey, privateKey } = unwrap(await generateKeyPair());
const keyId = generateId("key");
const identity = unwrap(addIdentityKey(person, { id: keyId, publicKey }));

// 3. A footprint. There is deliberately no default role: you say who did what.
const footprint = unwrap(
  createFootprint({
    project: { name: "MyCoolApp", url: "https://mycoolapp.example" },
    contributors: [{ identity, role: "creator" }],
  }),
);

// 4. Sign it, then verify it with nothing but the three documents.
const signature = unwrap(await signFootprint({ footprint, identity, keyId, privateKey }));
const result = await verifyFootprint({ footprint, signature, identity });

result.valid; // true
result.checks.payloadDigest; // { status: "pass", message: "the footprint has not changed since it was signed" }
result.checks.claimCurrent; // { status: "not_checked", … }   offline verification never pretends
```

## Design

- **Results, not exceptions.** Validation returns `{ ok: true, value } | { ok: false, error }` with
  stable `code`s and JSON-Pointer `issues`. `unwrap()` is there for scripts and tests.
- **Strict.** `parseJson` rejects duplicate keys, lone surrogates, fractions, deep nesting and
  oversized input. Validators reject unknown fields and never repair input; they return a fresh copy.
- **Granular verification.** `verifyFootprint` reports each check separately (schema, signer binding,
  key lookup, key validity window, digest, signature, signer credited) plus the checks that need
  the network (`not_checked`). It never throws on bad input.
- **Key rotation and revocation** are in the data model (`retiredAt`, `revokedAt`).
- **Weak keys** (small-order Ed25519 points) are rejected.
- `PrivateKey` renders as `[REDACTED …]` in logs, JSON and `util.inspect`.

See the specification in `spec/SPEC.md` for the exact rules and `spec/test-vectors/` for
language-independent vectors.

## API

`parseJson`, `canonicalize`, `digestDocument`, `validateIdentity`, `validateFootprint`,
`validateProject`, `validateSignatureEnvelope`, `createIdentity`, `addIdentityKey`,
`createFootprint`, `generateKeyPair`, `PrivateKey`, `signFootprint`, `verifyFootprint`,
`generateId`, `normalizeUrl`, `wellKnownUrlFor`, `evaluateKeyAt`, `getKeyStatus`, and the types.
