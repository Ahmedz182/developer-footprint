import {
  getKeyStatus,
  signFootprint,
  validateFootprint,
  validateIdentity,
  type FootprintError,
} from "@developer-footprint/core";
import { PROJECT_OPTIONS, parseCommandArgs } from "../args.js";
import { CliError, type Context } from "../context.js";
import { abbreviate, createStyler } from "../output.js";
import {
  keyDirectory,
  keyFileIsTooOpen,
  loadKey,
  projectPaths,
  requireDocument,
  writeDocument,
} from "../store.js";

export const SIGN_HELP = `Usage: developer-footprint sign [options]

Sign .developer-footprint/footprint.json with your private key and write footprint.sig.
Nothing is uploaded. Only the signing key is needed, so this can be run on any machine that
has your key directory available (for example a USB drive: --key-dir E:\\keys).

Options:
  --key <key-id>     Key to sign with (default: the identity's only active key)
  --key-dir <path>   Where the private key lives (default: DEVELOPER_FOOTPRINT_KEY_DIR,
                     else your user config directory)
  --dir <path>       Project directory (default: current directory)
  -h, --help
`;

const OPTIONS = {
  ...PROJECT_OPTIONS,
  key: { type: "string" },
  "key-dir": { type: "string" },
} as const;

function describe(error: FootprintError): string {
  switch (error.code) {
    case "SIGNER_MISMATCH":
      return `${error.message}. Add your identity to the footprint's contributors with an explicit role.`;
    case "KEY_NOT_USABLE":
      return `${error.message}. Generate a new key with \`developer-footprint keygen\`.`;
    default:
      return error.message;
  }
}

export async function runSign(argv: readonly string[], ctx: Context): Promise<number> {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (values.help === true) {
    ctx.stdout(SIGN_HELP);
    return 0;
  }
  const paths = projectPaths(ctx, values.dir);
  const s = createStyler(ctx.color);
  const init = "Run `developer-footprint init` first.";

  const identityDocument = await requireDocument(paths.identity, "identity document", init);
  const footprintDocument = await requireDocument(paths.footprint, "footprint", init);
  const identity = validateIdentity(identityDocument);
  if (!identity.ok)
    throw new CliError(`${paths.identity} is not valid: ${identity.error.message}`, 1);
  const footprint = validateFootprint(footprintDocument);
  if (!footprint.ok)
    throw new CliError(`${paths.footprint} is not valid: ${footprint.error.message}`, 1);

  // Choose the key: explicit, or the only active one. Never guess between several.
  let keyId = values.key;
  if (keyId === undefined) {
    const active = identity.value.keys.filter((key) => getKeyStatus(key) === "active");
    if (active.length === 0)
      throw new CliError(
        "the identity has no active key",
        2,
        "Run `developer-footprint keygen` first.",
      );
    if (active.length > 1) {
      throw new CliError(
        `the identity has ${active.length} active keys`,
        2,
        `Choose one with --key: ${active.map((k) => k.id).join(", ")}`,
      );
    }
    keyId = active[0]!.id;
  }

  const keyDir = keyDirectory(ctx, values["key-dir"]);
  const loaded = await loadKey(keyDir, keyId);
  if (loaded.kind === "missing") {
    throw new CliError(
      `the private key for ${keyId} is not on this machine (looked in ${keyDir})`,
      2,
      "Private keys are stored only where they were generated. If yours is on a USB drive or another\ncomputer, point --key-dir at it. If it is lost, run `developer-footprint keygen` for a new key.",
    );
  }
  if (loaded.kind === "invalid")
    throw new CliError(`${loaded.path} is not a usable key file: ${loaded.reason}`, 2);
  if (await keyFileIsTooOpen(loaded.path, ctx.platform)) {
    ctx.stderr(
      `${s.yellow("warning:")} ${loaded.path} is readable by other users. Run: chmod 600 ${loaded.path}\n`,
    );
  }

  const signed = await signFootprint({
    footprint: footprintDocument,
    identity: identityDocument,
    keyId,
    privateKey: loaded.key,
    signedAt: ctx.now(),
  });
  if (!signed.ok) throw new CliError(describe(signed.error), 2);

  await writeDocument(paths.signature, signed.value);
  ctx.stdout(
    `${s.green("✓")} Signed ${s.bold(footprint.value.project.name)} ${s.dim(`(${footprint.value.id})`)}\n`,
  );
  ctx.stdout(`  key      ${keyId}\n`);
  ctx.stdout(`  digest   ${abbreviate(signed.value.subject.digest, 16)}\n`);
  ctx.stdout(`  signed   ${signed.value.signedAt}\n`);
  ctx.stdout(`${s.green("✓")} Wrote ${s.bold(".developer-footprint/footprint.sig")}\n\n`);
  ctx.stdout(`Next: ${s.cyan("developer-footprint verify")}\n`);
  return 0;
}
