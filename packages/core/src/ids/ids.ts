const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID = "[0-9A-HJKMNP-TV-Z]{26}";

export type IdKind = "identity" | "project" | "footprint" | "key";

const PREFIX: Readonly<Record<IdKind, string>> = {
  identity: "df:identity:",
  project: "df:project:",
  footprint: "fp_",
  key: "key_",
};

const PATTERNS: Readonly<Record<IdKind, RegExp>> = {
  identity: new RegExp(`^df:identity:${ULID}$`),
  project: new RegExp(`^df:project:${ULID}$`),
  footprint: new RegExp(`^fp_${ULID}$`),
  key: new RegExp(`^key_${ULID}$`),
};

/** Ids are a fixed prefix plus a 26-character Crockford-base32 ULID, upper case. */
export function isId(kind: IdKind, value: string): boolean {
  return PATTERNS[kind].test(value);
}

export interface IdOptions {
  /** Time source for the ULID timestamp component. Defaults to the current time. */
  readonly now?: Date;
  /** Randomness source. Defaults to `crypto.getRandomValues`. Inject for deterministic tests. */
  readonly randomBytes?: (length: number) => Uint8Array;
}

function defaultRandomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/** Generates an id of the given kind. Ids are opaque: nothing may rely on their timestamp. */
export function generateId(kind: IdKind, options: IdOptions = {}): string {
  const millis = BigInt((options.now ?? new Date()).getTime());
  if (millis < 0n || millis >= 1n << 48n) throw new RangeError("time is outside the ULID range");
  const random = (options.randomBytes ?? defaultRandomBytes)(10);
  if (random.length !== 10) throw new RangeError("randomBytes must return exactly 10 bytes");

  let time = millis;
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[Number(time & 31n)]! + timePart;
    time >>= 5n;
  }

  let entropy = 0n;
  for (const byte of random) entropy = (entropy << 8n) | BigInt(byte);
  let randomPart = "";
  for (let i = 0; i < 16; i++) {
    randomPart = CROCKFORD[Number(entropy & 31n)]! + randomPart;
    entropy >>= 5n;
  }

  return `${PREFIX[kind]}${timePart}${randomPart}`;
}
