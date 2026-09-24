import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  LIMITS,
  PrivateKey,
  isId,
  parseJson,
  type FootprintError,
  type JsonValue,
  type Result,
} from "@developer-footprint/core";
import { CliError, type Context } from "./context.js";

export const PROJECT_DIR = ".developer-footprint";

export interface ProjectPaths {
  readonly dir: string;
  readonly identity: string;
  readonly footprint: string;
  readonly signature: string;
}

export function projectPaths(ctx: Context, dirFlag?: string): ProjectPaths {
  const base = resolve(ctx.cwd, dirFlag ?? ".");
  const dir = join(base, PROJECT_DIR);
  return {
    dir,
    identity: join(dir, "identity.json"),
    footprint: join(dir, "footprint.json"),
    signature: join(dir, "footprint.sig"),
  };
}

export type LoadResult =
  | { readonly kind: "ok"; readonly value: JsonValue }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly message: string }
  | { readonly kind: "invalid"; readonly error: FootprintError };

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/**
 * Reads a protocol document from disk without trusting it: regular files only, size-checked
 * before reading, then parsed with the strict parser. A leading byte-order mark is stripped
 * because common Windows tools add one; the parser itself rejects it (RFC 8259 §8.1).
 */
export async function loadDocument(path: string): Promise<LoadResult> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return { kind: "unreadable", message: `${path} is not a regular file` };
    size = info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", message: `cannot read ${path}: ${(error as Error).message}` };
  }
  if (size > LIMITS.maxDocumentBytes) {
    return {
      kind: "invalid",
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: `${path} is larger than ${LIMITS.maxDocumentBytes} bytes`,
      },
    };
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return { kind: "unreadable", message: `cannot read ${path}: ${(error as Error).message}` };
  }
  if (text.startsWith(BYTE_ORDER_MARK)) text = text.slice(1);
  const parsed = parseJson(text);
  return parsed.ok ? { kind: "ok", value: parsed.value } : { kind: "invalid", error: parsed.error };
}

/** Loads a document that must exist and be readable, or throws a usage-level CliError. */
export async function requireDocument(
  path: string,
  what: string,
  hint?: string,
): Promise<JsonValue> {
  const loaded = await loadDocument(path);
  switch (loaded.kind) {
    case "ok":
      return loaded.value;
    case "missing":
      throw new CliError(`${what} not found at ${path}`, 2, hint);
    case "unreadable":
      throw new CliError(loaded.message, 2);
    case "invalid":
      throw new CliError(`${what} at ${path} is not valid: ${loaded.error.message}`, 1);
  }
}

/** Human-and-diff-friendly JSON. This is presentation only; signing uses canonical JSON. */
export function formatDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Writes via a temporary file and rename, so an interrupted write never leaves half a document. */
export async function writeDocument(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, formatDocument(value), { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------
// Private key storage. Keys live outside the project so they cannot be committed by accident.
// ------------------------------------------------------------------------------------------

/**
 * Where private keys are stored. `--key-dir` wins, then DEVELOPER_FOOTPRINT_KEY_DIR, then the
 * per-user config directory. Pointing it at removable or encrypted storage is how a key is
 * carried between machines without ever living on a shared or employer-owned disk.
 */
export function keyDirectory(ctx: Context, flag?: string): string {
  const explicit = flag ?? ctx.env["DEVELOPER_FOOTPRINT_KEY_DIR"];
  if (explicit !== undefined && explicit !== "") return resolve(ctx.cwd, explicit);
  if (ctx.platform === "win32") {
    return join(
      ctx.env["APPDATA"] ?? join(ctx.homedir, "AppData", "Roaming"),
      "developer-footprint",
      "keys",
    );
  }
  return join(
    ctx.env["XDG_CONFIG_HOME"] ?? join(ctx.homedir, ".config"),
    "developer-footprint",
    "keys",
  );
}

const KEY_FILE_TYPE = "developer-footprint.private-key";

export function keyFilePath(keyDir: string, keyId: string): string {
  // keyId is checked against the id grammar, so it can never contain path separators or "..".
  if (!isId("key", keyId)) throw new CliError(`"${keyId}" is not a valid key id`, 2);
  return join(keyDir, `${keyId}.key.json`);
}

/** Saves a private key with owner-only permissions. Never overwrites an existing key. */
export async function saveKey(keyDir: string, keyId: string, key: PrivateKey): Promise<string> {
  const path = keyFilePath(keyDir, keyId);
  await mkdir(keyDir, { recursive: true, mode: 0o700 });
  const contents = formatDocument({
    type: KEY_FILE_TYPE,
    specVersion: "1.0",
    algorithm: "Ed25519",
    keyId,
    privateKey: key.exportSeed(),
  });
  try {
    await writeFile(path, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CliError(`a key file already exists at ${path}; refusing to overwrite it`, 2);
    }
    throw error;
  }
  // mode in writeFile is subject to the umask; make the intent explicit where chmod is meaningful.
  await chmod(path, 0o600).catch(() => undefined);
  return path;
}

export type KeyLoad =
  | { readonly kind: "ok"; readonly key: PrivateKey; readonly path: string }
  | { readonly kind: "missing"; readonly path: string }
  | { readonly kind: "invalid"; readonly path: string; readonly reason: string };

export async function loadKey(keyDir: string, keyId: string): Promise<KeyLoad> {
  const path = keyFilePath(keyDir, keyId);
  const loaded = await loadDocument(path);
  if (loaded.kind === "missing") return { kind: "missing", path };
  if (loaded.kind !== "ok") {
    return {
      kind: "invalid",
      path,
      reason: loaded.kind === "invalid" ? loaded.error.message : loaded.message,
    };
  }
  const record = loaded.value;
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return { kind: "invalid", path, reason: "not a key file" };
  }
  // Array.isArray does not narrow `readonly` arrays away, so state the shape explicitly.
  const fields = record as { readonly [key: string]: JsonValue };
  if (
    fields["type"] !== KEY_FILE_TYPE ||
    fields["algorithm"] !== "Ed25519" ||
    fields["keyId"] !== keyId
  ) {
    return { kind: "invalid", path, reason: "not an Ed25519 key file for this key id" };
  }
  const seed = typeof fields["privateKey"] === "string" ? fields["privateKey"] : "";
  const key: Result<PrivateKey> = PrivateKey.fromExportedSeed(seed);
  return key.ok
    ? { kind: "ok", key: key.value, path }
    : { kind: "invalid", path, reason: key.error.message };
}

/** POSIX only: true if group or others can read the key file. Windows ACLs are not inspected. */
export async function keyFileIsTooOpen(path: string, platform: NodeJS.Platform): Promise<boolean> {
  if (platform === "win32") return false;
  try {
    const info = await stat(path);
    return (info.mode & 0o077) !== 0;
  } catch {
    return false;
  }
}
