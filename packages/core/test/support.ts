import {
  PrivateKey,
  addIdentityKey,
  createFootprint,
  createIdentity,
  signFootprint,
  unwrap,
  type Footprint,
  type Identity,
  type SignatureEnvelope,
} from "../src/index.js";

export function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
}

/** RFC 8032 §7.1 test vector 1. A publicly known key: for tests and examples only. */
export const RFC8032_SEED = hexToBytes(
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
);
export const RFC8032_PUBLIC_HEX =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

/** RFC 8032 §7.1 test vector 2. */
export const RFC8032_SEED_2 = hexToBytes(
  "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
);

export const IDENTITY_ID = "df:identity:01J8Y5N3ZQ4VTK6M2P9R7XBWCD";
export const PROJECT_ID = "df:project:01J8Y5N3ZR5WVM7N3Q0S8YCXDE";
export const FOOTPRINT_ID = "fp_01J8Y5N3ZS6XWN8P4R1T9ZDYEF";
export const KEY_ID = "key_01J8Y5N3ZT7YXP9Q5S2V0AEZFG";
export const KEY_ID_2 = "key_01J8Y5N3ZV8ZYQ0R6T3W1BFAGH";
export const JOHN_IDENTITY_URL = "https://john.example/.well-known/developer-footprint.json";
export const SARAH_IDENTITY_URL = "https://sarah.example/.well-known/developer-footprint.json";

export const CREATED = new Date("2026-09-24T00:00:00Z");
export const SIGNED = new Date("2026-09-24T12:00:00Z");

/** Deterministic byte source so generated ids are stable in tests. */
export function fixedRandom(fill: number): (length: number) => Uint8Array {
  return (length) => new Uint8Array(length).fill(fill);
}

export function privateKey(seed: Uint8Array = RFC8032_SEED): PrivateKey {
  return unwrap(PrivateKey.fromSeed(seed));
}

export async function publicKeyOf(key: PrivateKey): Promise<string> {
  return unwrap(await key.publicKey());
}

export interface Fixture {
  readonly identity: Identity;
  readonly footprint: Footprint;
  readonly key: PrivateKey;
  readonly envelope: SignatureEnvelope;
}

/** A complete, valid, signed example: Sarah signs a footprint that also credits John. */
export async function buildFixture(): Promise<Fixture> {
  const key = privateKey();
  const base = unwrap(
    createIdentity(
      {
        id: IDENTITY_ID,
        type: "Person",
        name: "Sarah",
        canonicalUrl: "https://sarah.example",
        profiles: { github: "https://github.com/sarah" },
      },
      { now: CREATED },
    ),
  );
  const identity = unwrap(
    addIdentityKey(base, { id: KEY_ID, publicKey: await publicKeyOf(key) }, { now: CREATED }),
  );
  const footprint = unwrap(
    createFootprint(
      {
        id: FOOTPRINT_ID,
        project: {
          id: PROJECT_ID,
          name: "MyCoolApp",
          description: "Example application",
          url: "https://mycoolapp.example",
          repository: "https://github.com/sarah/mycoolapp",
          version: "1.0.0",
        },
        contributors: [
          { identity, role: "creator" },
          { identity: JOHN_IDENTITY_URL, role: "contributor" },
        ],
      },
      { now: CREATED },
    ),
  );
  const envelope = unwrap(
    await signFootprint({ footprint, identity, keyId: KEY_ID, privateKey: key, signedAt: SIGNED }),
  );
  return { identity, footprint, key, envelope };
}

export type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;

/** Deep-clones plain JSON so a test can mutate a copy of a fixture. */
export function clone<T>(value: T): DeepMutable<T> {
  return JSON.parse(JSON.stringify(value)) as DeepMutable<T>;
}
