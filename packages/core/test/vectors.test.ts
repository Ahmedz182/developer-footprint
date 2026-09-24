import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  PrivateKey,
  canonicalize,
  decodeBase64Url,
  encodeBase64Url,
  parseJson,
  signFootprint,
  unwrap,
  validateFootprint,
  validateIdentity,
  validateSignatureEnvelope,
  verifyFootprint,
  type Result,
} from "../src/index.js";

const specDir = fileURLToPath(new URL("../../../spec/", import.meta.url));
const readJson = (relative: string): unknown =>
  JSON.parse(readFileSync(`${specDir}${relative}`, "utf8"));

interface CanonCase {
  name: string;
  input: string;
  canonical?: string;
  reject?: string;
}
interface DocCase {
  name: string;
  kind: "identity" | "footprint" | "signature";
  document: unknown;
  layer?: "schema" | "semantic";
  error?: { code: string; path?: string };
}

const canonVectors = readJson("test-vectors/canonicalization.json") as { cases: CanonCase[] };
const docVectors = readJson("test-vectors/documents.json") as {
  valid: DocCase[];
  invalid: DocCase[];
};
const signingVectors = readJson("test-vectors/signing.json") as {
  key: { seed: string; publicKeyHex: string; publicKey: string };
  identity: unknown;
  footprint: unknown;
  canonicalFootprint: string;
  footprintDigest: string;
  canonicalStatement: string;
  signature: Record<string, unknown> & { signature: string; subject: { digest: string } };
  cases: {
    name: string;
    footprint: unknown;
    signature: unknown;
    identity: unknown;
    expect: { valid: boolean; failedChecks: string[]; warnings: string[] };
  }[];
};

const validators: Record<DocCase["kind"], (input: unknown) => Result<unknown>> = {
  identity: validateIdentity,
  footprint: validateFootprint,
  signature: validateSignatureEnvelope,
};

// JSON Schema (normative, structural) — compiled with the strictest Ajv settings.
const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const file of ["common", "project", "identity", "footprint", "signature"]) {
  ajv.addSchema(readJson(`schemas/${file}.v1.schema.json`) as object);
}
const schemaFor: Record<DocCase["kind"], string> = {
  identity: "urn:developer-footprint:schema:v1:identity",
  footprint: "urn:developer-footprint:schema:v1:footprint",
  signature: "urn:developer-footprint:schema:v1:signature",
};
const schemaAccepts = (kind: DocCase["kind"], document: unknown): boolean => {
  const validate = ajv.getSchema(schemaFor[kind]);
  if (validate === undefined) throw new Error(`schema for ${kind} is not registered`);
  const outcome = validate(document);
  // Our schemas contain no async keywords, so validation is synchronous.
  if (typeof outcome !== "boolean") throw new Error("unexpected asynchronous schema validation");
  return outcome;
};

describe("canonicalization vectors", () => {
  for (const vector of canonVectors.cases) {
    it(vector.name, () => {
      const parsed = parseJson(vector.input);
      if (vector.reject !== undefined) {
        const outcome = parsed.ok ? canonicalize(parsed.value) : parsed;
        expect(outcome.ok, `must reject: ${vector.reject}`).toBe(false);
        return;
      }
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(canonicalize(parsed.value)).toEqual({ ok: true, value: vector.canonical });
    });
  }
});

describe("document vectors", () => {
  for (const vector of docVectors.valid) {
    it(`accepts ${vector.kind}: ${vector.name}`, () => {
      expect(validators[vector.kind](vector.document)).toMatchObject({ ok: true });
      expect(schemaAccepts(vector.kind, vector.document), "JSON Schema must accept it too").toBe(
        true,
      );
    });
  }

  for (const vector of docVectors.invalid) {
    it(`rejects ${vector.kind}: ${vector.name}`, () => {
      const result = validators[vector.kind](vector.document);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(vector.error?.code);
      if (vector.error?.path !== undefined) {
        expect(result.error.issues?.[0]?.path).toBe(vector.error.path);
      }
      if (vector.layer === "schema") {
        expect(schemaAccepts(vector.kind, vector.document), "JSON Schema must reject it too").toBe(
          false,
        );
      }
    });
  }

  it("has vectors in both layers, so the split is actually exercised", () => {
    const layers = new Set(docVectors.invalid.map((vector) => vector.layer));
    expect(layers).toEqual(new Set(["schema", "semantic"]));
  });
});

/** Minimal independent JCS for the ASCII-only fixture documents: sorted keys + JSON.stringify. */
function independentCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(independentCanonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${independentCanonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("signing vector (independently checked)", () => {
  const vector = signingVectors;
  const envelope = vector.signature;
  const { signature, ...statement } = envelope;

  it("uses the public RFC 8032 test-1 key", () => {
    // Literal, not read from the file: the anchor must not come from the thing being tested.
    expect(vector.key.publicKeyHex).toBe(
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    );
    expect(Buffer.from(decodeBase64Url(vector.key.publicKey) ?? []).toString("hex")).toBe(
      vector.key.publicKeyHex,
    );
  });

  it("canonical footprint, digest and statement match a from-scratch computation", () => {
    expect(vector.canonicalFootprint).toBe(independentCanonical(vector.footprint));
    const digest = createHash("sha256").update(vector.canonicalFootprint, "utf8").digest();
    expect(vector.footprintDigest).toBe(`sha256:${encodeBase64Url(digest)}`);
    expect(envelope.subject.digest).toBe(vector.footprintDigest);
    expect(vector.canonicalStatement).toBe(independentCanonical(statement));
  });

  it("the signature verifies with node:crypto, a different code path from the SDK", () => {
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const key = createPublicKey({
      key: Buffer.concat([spkiPrefix, Buffer.from(vector.key.publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
    const raw = Buffer.from(decodeBase64Url(signature) ?? []);
    expect(raw.length).toBe(64);
    expect(nodeVerify(null, Buffer.from(vector.canonicalStatement, "utf8"), key, raw)).toBe(true);
    expect(nodeVerify(null, Buffer.from(`${vector.canonicalStatement} `, "utf8"), key, raw)).toBe(
      false,
    );
  });

  it("the SDK reproduces the committed signature byte for byte", async () => {
    const privateKey = unwrap(PrivateKey.fromExportedSeed(vector.key.seed));
    const produced = unwrap(
      await signFootprint({
        footprint: vector.footprint,
        identity: vector.identity,
        keyId: envelope["keyId"] as string,
        privateKey,
        signedAt: envelope["signedAt"] as string,
      }),
    );
    expect(produced).toEqual(envelope);
  });

  for (const vectorCase of vector.cases) {
    it(`verification outcome: ${vectorCase.name}`, async () => {
      const result = await verifyFootprint({
        footprint: vectorCase.footprint,
        signature: vectorCase.signature,
        identity: vectorCase.identity,
      });
      const failedChecks = Object.entries(result.checks)
        .filter(([, check]) => check.status === "fail")
        .map(([name]) => name);
      expect({
        valid: result.valid,
        failedChecks,
        warnings: result.warnings.map((w) => w.code),
      }).toEqual(vectorCase.expect);
    });
  }
});
