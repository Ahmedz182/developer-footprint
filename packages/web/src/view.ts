import type { CheckName } from "@developer-footprint/core";
import type { LoadProblem, LoadedVerification } from "./load.js";

export type BadgeState = "loading" | "verified" | "invalid" | "error" | "unconfigured";

export interface BadgeRow {
  readonly label: string;
  readonly status: "pass" | "fail" | "not_checked";
  readonly message: string;
}

export interface BadgeClaim {
  readonly role: string;
  readonly who: string;
  readonly isSigner: boolean;
}

/** Everything the badge shows, as plain data, so the wording is testable without a DOM. */
export interface BadgeView {
  readonly state: BadgeState;
  readonly headline: string;
  readonly subline: string;
  readonly claims: readonly BadgeClaim[];
  readonly rows: readonly BadgeRow[];
  readonly notes: readonly string[];
}

const LABELS: Readonly<Record<CheckName, string>> = {
  footprintSchema: "Footprint document",
  identitySchema: "Identity document",
  signatureSchema: "Signature envelope",
  signerBinding: "Signer identity",
  keyLookup: "Signing key",
  keyStateAtSigning: "Key valid when signed",
  payloadDigest: "Footprint unchanged",
  signature: "Signature",
  signerListed: "Signer credited",
  identityDocumentResolved: "Identity fetched from its domain",
  domainRelationship: "Domain controls identity",
  claimCurrent: "Claim is current",
};

const ORDER: readonly CheckName[] = [
  "footprintSchema",
  "identitySchema",
  "signatureSchema",
  "signerBinding",
  "keyLookup",
  "keyStateAtSigning",
  "payloadDigest",
  "signature",
  "signerListed",
  "identityDocumentResolved",
  "domainRelationship",
  "claimCurrent",
];

const host = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export const LOADING_VIEW: BadgeView = {
  state: "loading",
  headline: "Checking signature…",
  subline: "",
  claims: [],
  rows: [],
  notes: [],
};

export const UNCONFIGURED_VIEW: BadgeView = {
  state: "unconfigured",
  headline: "Developer Footprint",
  subline: 'Set the "src" attribute to the folder that holds footprint.json and footprint.sig.',
  claims: [],
  rows: [],
  notes: [],
};

export function describeProblem(problem: LoadProblem): BadgeView {
  const what = {
    footprint: "the footprint",
    signature: "the signature",
    identity: "the signer's identity document",
  }[problem.what];
  return {
    state: "error",
    headline: "Could not check this footprint",
    subline: `Unable to load ${what}: ${problem.message}.`,
    claims: [],
    rows: [],
    notes: [
      `Address: ${problem.url}`,
      "Nothing is wrong with the claim itself; it simply could not be checked from here.",
    ],
  };
}

/**
 * Wording rules (ARCHITECTURE.md §69, §71): say exactly what is established, never a stronger
 * ownership claim than the signed data states, and never treat a failure as proof of bad faith.
 */
export function describeVerification(loaded: LoadedVerification): BadgeView {
  const { result, footprint, identity } = loaded;
  const rows: BadgeRow[] = ORDER.map((name) => ({
    label: LABELS[name],
    status: result.checks[name].status,
    message: result.checks[name].message,
  }));
  const notes: string[] = result.warnings.map((warning) => warning.message);

  if (!result.valid) {
    return {
      state: "invalid",
      headline: "Could not verify this claim",
      subline: result.errors[0]?.message ?? "The documents did not pass verification.",
      claims: [],
      rows,
      notes: [
        ...notes,
        "This does not prove malicious behavior. It means these documents cannot currently be cryptographically verified.",
      ],
    };
  }

  const signerUrl = result.signer?.url ?? "";
  const claims: BadgeClaim[] = (footprint?.contributors ?? []).map((contributor) => ({
    role: contributor.role,
    who:
      contributor.identity === signerUrl && identity !== undefined
        ? `${identity.name} (${host(contributor.identity)})`
        : host(contributor.identity),
    isSigner: contributor.identity === signerUrl,
  }));
  if (claims.some((claim) => !claim.isSigner)) {
    notes.push(
      "Roles for other identities are asserted by the signer; those identities have not confirmed them.",
    );
  }
  if (result.checks.claimCurrent.status === "not_checked") {
    notes.push("Whether this claim has since been superseded or revoked is not checked here.");
  }

  const signedOn = (result.signedAt ?? "").slice(0, 10);
  const who = identity === undefined ? host(signerUrl) : `${identity.name} (${host(signerUrl)})`;
  return {
    state: "verified",
    headline: "Signature verified",
    subline: `${footprint?.project.name ?? "This project"}: signed by ${who}${signedOn === "" ? "" : ` on ${signedOn}`}`,
    claims,
    rows,
    notes,
  };
}
