import type { Identity, IdentityKey, KeyStatus } from "../types/index.js";

/** Current status of a key as published in the identity document. */
export function getKeyStatus(key: IdentityKey): KeyStatus {
  if (key.revokedAt !== undefined) return "revoked";
  if (key.retiredAt !== undefined) return "retired";
  return "active";
}

export function findKey(identity: Identity, keyId: string): IdentityKey | undefined {
  return identity.keys.find((key) => key.id === keyId);
}

export type KeyWindow =
  | {
      readonly usable: true;
      /** The key was retired after `at`: history is intact, but it no longer signs new claims. */
      readonly retiredLater: boolean;
      /**
       * The key was revoked after `at`. `at` comes from the signer, so a compromised key can
       * backdate; callers should treat this as a warning, not proof of an untampered timeline.
       */
      readonly revokedLater: boolean;
    }
  | { readonly usable: false; readonly reason: string };

/**
 * Whether `key` was allowed to sign at `at`: from its creation until it was retired or revoked
 * (end exclusive). Timestamps are fixed-width UTC strings, so string comparison is chronological.
 */
export function evaluateKeyAt(key: IdentityKey, at: string): KeyWindow {
  if (at < key.createdAt) {
    return { usable: false, reason: `key ${key.id} did not exist yet at ${at}` };
  }
  if (key.revokedAt !== undefined && at >= key.revokedAt) {
    return { usable: false, reason: `key ${key.id} was revoked at ${key.revokedAt}` };
  }
  if (key.retiredAt !== undefined && at >= key.retiredAt) {
    return { usable: false, reason: `key ${key.id} was retired at ${key.retiredAt}` };
  }
  return {
    usable: true,
    retiredLater: key.retiredAt !== undefined,
    revokedLater: key.revokedAt !== undefined,
  };
}
