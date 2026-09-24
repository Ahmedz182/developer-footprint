import {
  addIdentityKey,
  generateId,
  generateKeyPair,
  validateIdentity,
} from "@developer-footprint/core";
import { PROJECT_OPTIONS, parseCommandArgs } from "../args.js";
import { CliError, type Context } from "../context.js";
import { abbreviate, createStyler } from "../output.js";
import { keyDirectory, projectPaths, requireDocument, saveKey, writeDocument } from "../store.js";

export const KEYGEN_HELP = `Usage: developer-footprint keygen [options]

Generate an Ed25519 signing key. The PRIVATE key is saved on this machine and never uploaded;
the PUBLIC key is added to .developer-footprint/identity.json.

Options:
  --key-dir <path>   Where to store the private key. Point this at a USB drive or an encrypted
                     volume to keep the key off a shared or employer-owned computer.
                     (default: DEVELOPER_FOOTPRINT_KEY_DIR, else your user config directory)
  --dir <path>       Project directory (default: current directory)
  -h, --help
`;

const OPTIONS = { ...PROJECT_OPTIONS, "key-dir": { type: "string" } } as const;

export async function runKeygen(argv: readonly string[], ctx: Context): Promise<number> {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (values.help === true) {
    ctx.stdout(KEYGEN_HELP);
    return 0;
  }
  const paths = projectPaths(ctx, values.dir);
  const s = createStyler(ctx.color);

  const identity = validateIdentity(
    await requireDocument(
      paths.identity,
      "identity document",
      "Run `developer-footprint init` first.",
    ),
  );
  if (!identity.ok)
    throw new CliError(`${paths.identity} is not valid: ${identity.error.message}`, 1);

  const random = ctx.randomBytes === undefined ? {} : { randomBytes: ctx.randomBytes };
  const pair = await generateKeyPair(random);
  if (!pair.ok) throw new CliError(pair.error.message, 2);
  const keyId = generateId("key", { now: ctx.now(), ...random });

  const keyDir = keyDirectory(ctx, values["key-dir"]);
  const keyPath = await saveKey(keyDir, keyId, pair.value.privateKey);

  const updated = addIdentityKey(
    identity.value,
    { id: keyId, publicKey: pair.value.publicKey },
    { now: ctx.now() },
  );
  if (!updated.ok) throw new CliError(updated.error.message, 2);
  await writeDocument(paths.identity, updated.value);

  ctx.stdout(`${s.green("✓")} Generated Ed25519 key ${s.bold(keyId)}\n`);
  ctx.stdout(`${s.green("✓")} Private key saved to ${keyPath}\n`);
  ctx.stdout(
    `${s.green("✓")} Public key added to ${s.bold(".developer-footprint/identity.json")} ${s.dim(`(${abbreviate(pair.value.publicKey, 10)})`)}\n\n`,
  );
  ctx.stdout(`${s.yellow("Keep the private key safe")}\n`);
  ctx.stdout("  • Anyone who has it can sign as you. It is never uploaded anywhere.\n");
  ctx.stdout("  • Back it up. Without it you cannot sign new claims with this identity.\n");
  ctx.stdout("  • It is stored outside your project, so it cannot be committed by accident.\n");
  if (ctx.platform === "win32") {
    ctx.stdout(
      "  • Windows does not enforce Unix file modes; access follows your user profile's permissions.\n",
    );
  }
  ctx.stdout(`\nNext: ${s.cyan("developer-footprint sign")}\n`);
  return 0;
}
