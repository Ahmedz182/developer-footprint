import {
  validateFootprint,
  validateIdentity,
  validateSignatureEnvelope,
  verifyFootprint,
  type Footprint,
  type Identity,
  type VerificationResult,
} from "@developer-footprint/core";
import { fetchDocument, type FetchOptions, type FetchProblem } from "./fetch.js";

export interface LoadOptions extends FetchOptions {
  /** URL of the footprint document (`footprint.json`). */
  readonly footprint: string;
  /** URL of the signature envelope (`footprint.sig`). */
  readonly signature: string;
  /**
   * URL of the signer's identity document. Leave it out to fetch it from the signer's own domain,
   * as named (and signed) in the signature. Supply it to verify against a copy you control.
   */
  readonly identity?: string;
}

export interface LoadedVerification {
  /** The core result. `valid` is exactly what offline verification established. */
  readonly result: VerificationResult;
  readonly identitySource: "signer-domain" | "supplied";
  /** Where the identity document came from. Absent if the signature was too malformed to say. */
  readonly identityUrl?: string;
  /** The documents, when they were valid enough to read. */
  readonly footprint?: Footprint;
  readonly identity?: Identity;
}

export type LoadProblem = FetchProblem & { readonly what: "footprint" | "signature" | "identity" };

export type LoadOutcome =
  | { readonly ok: true; readonly value: LoadedVerification }
  | { readonly ok: false; readonly error: LoadProblem };

/**
 * Fetches a footprint, its signature and the signer's identity document, then verifies them
 * with the core SDK. This is the package's only network activity, and it happens only when you
 * call it. Failures to fetch are reported as problems; a bad or forged document is a normal
 * result with `valid: false`.
 *
 * When the identity comes from the signer's own domain, two checks that offline verification
 * cannot answer are answered here, and only here: the document was resolved, and it was served by
 * the domain the identity itself claims (the signature binds the signer URL, and a redirect to
 * another origin is refused). `claimCurrent` stays unchecked; that needs a registry.
 */
export async function loadAndVerify(options: LoadOptions): Promise<LoadOutcome> {
  const fetchOptions: FetchOptions = {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
  };

  const [footprint, signature] = await Promise.all([
    fetchDocument(options.footprint, fetchOptions),
    fetchDocument(options.signature, fetchOptions),
  ]);
  if (!footprint.ok) return { ok: false, error: { ...footprint.error, what: "footprint" } };
  if (!signature.ok) return { ok: false, error: { ...signature.error, what: "signature" } };

  let identityUrl = options.identity;
  const identitySource = options.identity === undefined ? "signer-domain" : "supplied";
  if (identityUrl === undefined) {
    const envelope = validateSignatureEnvelope(signature.value);
    // A malformed envelope names no signer: let verification report exactly what is wrong with it.
    if (envelope.ok) identityUrl = envelope.value.signer;
  }

  let identityDocument: unknown;
  if (identityUrl !== undefined) {
    const identity = await fetchDocument(identityUrl, fetchOptions);
    if (!identity.ok) return { ok: false, error: { ...identity.error, what: "identity" } };
    identityDocument = identity.value;
  }

  const verified = await verifyFootprint({
    footprint: footprint.value,
    signature: signature.value,
    identity: identityDocument,
  });

  let result = verified;
  if (identitySource === "signer-domain" && identityUrl !== undefined) {
    const host = new URL(identityUrl).host;
    const bound = verified.checks.signerBinding.status === "pass";
    result = {
      ...verified,
      checks: {
        ...verified.checks,
        identityDocumentResolved: {
          status: "pass",
          message: `fetched over HTTPS from ${host}`,
        },
        domainRelationship: bound
          ? { status: "pass", message: `served by ${host}, the domain this identity claims` }
          : {
              status: "fail",
              message: "the fetched document does not belong to the signer's domain",
            },
      },
    };
  }

  const parsedFootprint = validateFootprint(footprint.value);
  const parsedIdentity = validateIdentity(identityDocument);
  return {
    ok: true,
    value: {
      result,
      identitySource,
      ...(identityUrl === undefined ? {} : { identityUrl }),
      ...(parsedFootprint.ok ? { footprint: parsedFootprint.value } : {}),
      ...(parsedIdentity.ok ? { identity: parsedIdentity.value } : {}),
    },
  };
}
