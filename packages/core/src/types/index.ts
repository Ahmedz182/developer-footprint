/** The only protocol version this implementation understands. Unknown versions are rejected. */
export const SPEC_VERSION = "1.0" as const;
export type SpecVersion = typeof SPEC_VERSION;

export const IDENTITY_TYPES = ["Person", "Organization"] as const;
export type IdentityType = (typeof IDENTITY_TYPES)[number];

/**
 * Attribution roles (SPEC.md §7). A role is exactly the claim it names; consumers must never
 * present a weaker role as a stronger one (e.g. `contributor` as `owner`).
 */
export const ROLES = [
  "creator",
  "author",
  "maintainer",
  "contributor",
  "owner",
  "organization",
] as const;
export type Role = (typeof ROLES)[number];

export const KEY_ALGORITHMS = ["Ed25519"] as const;
export type KeyAlgorithm = (typeof KEY_ALGORITHMS)[number];

export type KeyStatus = "active" | "retired" | "revoked";

export interface IdentityKey {
  readonly id: string;
  readonly algorithm: KeyAlgorithm;
  /** Raw 32-byte Ed25519 public key, base64url without padding. */
  readonly publicKey: string;
  readonly createdAt: string;
  /** Set when the key stopped being used for new signatures. */
  readonly retiredAt?: string;
  /** Set when the key was declared compromised or otherwise untrustworthy. */
  readonly revokedAt?: string;
}

export interface Identity {
  readonly specVersion: SpecVersion;
  readonly id: string;
  readonly type: IdentityType;
  readonly name: string;
  readonly canonicalUrl: string;
  /** Unverified links to the identity's profiles on other platforms, keyed by platform slug. */
  readonly profiles?: Readonly<Record<string, string>>;
  readonly keys: readonly IdentityKey[];
  readonly updatedAt: string;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly url?: string;
  readonly repository?: string;
  readonly version?: string;
}

export interface Contributor {
  /** URL of the contributor's identity document (`/.well-known/developer-footprint.json`). */
  readonly identity: string;
  readonly role: Role;
}

export interface Footprint {
  readonly specVersion: SpecVersion;
  readonly id: string;
  readonly project: Project;
  readonly contributors: readonly Contributor[];
  readonly createdAt: string;
  /** Id of an earlier footprint this one replaces. Status is a resolver concern, not a signature one. */
  readonly supersedes?: string;
}

/** What a signature actually covers: the envelope without the signature value itself. */
export interface SignatureStatement {
  readonly type: "FootprintSignature";
  readonly specVersion: SpecVersion;
  readonly algorithm: KeyAlgorithm;
  /** Identity document URL of the signer. */
  readonly signer: string;
  readonly signerId: string;
  readonly keyId: string;
  readonly signedAt: string;
  readonly subject: {
    readonly type: "footprint";
    readonly id: string;
    /** `sha256:` + base64url of SHA-256 over the canonical footprint bytes. */
    readonly digest: string;
  };
}

export interface SignatureEnvelope extends SignatureStatement {
  /** Raw 64-byte Ed25519 signature over the canonical statement, base64url without padding. */
  readonly signature: string;
}
