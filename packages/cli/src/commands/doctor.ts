import {
  getKeyStatus,
  isEd25519Supported,
  validateFootprint,
  validateIdentity,
  validateSignatureEnvelope,
  verifyFootprint,
} from "@developer-footprint/core";
import { PROJECT_OPTIONS, parseCommandArgs } from "../args.js";
import type { Context } from "../context.js";
import { SYMBOLS, createStyler } from "../output.js";
import {
  exists,
  keyDirectory,
  keyFileIsTooOpen,
  loadDocument,
  loadKey,
  projectPaths,
} from "../store.js";

export const DOCTOR_HELP = `Usage: developer-footprint doctor [options]

Diagnose this machine and project: runtime support, documents, key availability and file
permissions. Read-only, and makes no network requests.

Options:
  --key-dir <path>   Where your private keys live
  --dir <path>       Project directory (default: current directory)
  -h, --help

Exit codes: 0 no failures (warnings allowed), 1 at least one failure.
`;

const OPTIONS = { ...PROJECT_OPTIONS, "key-dir": { type: "string" } } as const;

type Level = "pass" | "warn" | "fail" | "info";

export async function runDoctor(argv: readonly string[], ctx: Context): Promise<number> {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (values.help === true) {
    ctx.stdout(DOCTOR_HELP);
    return 0;
  }
  const s = createStyler(ctx.color);
  const paths = projectPaths(ctx, values.dir);
  let failures = 0;
  const line = (level: Level, text: string, detail?: string): void => {
    if (level === "fail") failures++;
    const mark =
      level === "pass"
        ? s.green(SYMBOLS.pass)
        : level === "fail"
          ? s.red(SYMBOLS.fail)
          : level === "warn"
            ? s.yellow(SYMBOLS.warn)
            : s.dim(SYMBOLS.skip);
    ctx.stdout(`  ${mark} ${text}\n`);
    if (detail !== undefined) ctx.stdout(`      ${s.dim(detail)}\n`);
  };

  ctx.stdout(`${s.bold("Developer Footprint doctor")}\n\n`);

  const major = Number(ctx.nodeVersion.split(".")[0]);
  line(
    major >= 22 ? "pass" : "fail",
    `Node.js ${ctx.nodeVersion}`,
    major >= 22 ? undefined : "Node.js 22 or newer is required.",
  );
  const ed25519 = await isEd25519Supported();
  line(
    ed25519 ? "pass" : "fail",
    "Ed25519 signatures supported by this runtime",
    ed25519 ? undefined : "WebCrypto Ed25519 is unavailable; upgrade Node.js.",
  );

  const keyDir = keyDirectory(ctx, values["key-dir"]);
  ctx.stdout("\n");
  if (!(await exists(paths.dir))) {
    line(
      "warn",
      `No project found at ${paths.dir}`,
      "Run `developer-footprint init` to create one.",
    );
    ctx.stdout(`\n  ${s.dim("Key directory: " + keyDir)}\n`);
    ctx.stdout(`  ${s.dim("No network requests were made.")}\n`);
    return failures > 0 ? 1 : 0;
  }

  const loadedIdentity = await loadDocument(paths.identity);
  const identity =
    loadedIdentity.kind === "ok" ? validateIdentity(loadedIdentity.value) : undefined;
  if (identity?.ok !== true) {
    line(
      "fail",
      "identity.json is missing or invalid",
      "Run `developer-footprint validate` for details.",
    );
  } else {
    const active = identity.value.keys.filter((key) => getKeyStatus(key) === "active");
    line(
      "pass",
      `identity.json valid: ${identity.value.name} (${identity.value.type}), ${identity.value.keys.length} key(s), ${active.length} active`,
    );
    if (active.length === 0)
      line("warn", "The identity has no active key", "Run `developer-footprint keygen`.");
    for (const key of active) {
      const loaded = await loadKey(keyDir, key.id);
      if (loaded.kind === "ok") {
        const open = await keyFileIsTooOpen(loaded.path, ctx.platform);
        line(
          open ? "warn" : "pass",
          `Private key for ${key.id} found`,
          open ? `${loaded.path} is readable by other users; run chmod 600` : loaded.path,
        );
      } else if (loaded.kind === "missing") {
        line(
          "warn",
          `Private key for ${key.id} is not on this machine`,
          `Looked in ${keyDir}. That is fine if it lives on another device or a USB drive; pass --key-dir to sign here.`,
        );
      } else {
        line("fail", `Private key file for ${key.id} is unusable`, loaded.reason);
      }
    }
  }

  const loadedFootprint = await loadDocument(paths.footprint);
  const footprint =
    loadedFootprint.kind === "ok" ? validateFootprint(loadedFootprint.value) : undefined;
  if (footprint?.ok === true) {
    line(
      "pass",
      `footprint.json valid: ${footprint.value.project.name}, ${footprint.value.contributors.length} attribution(s)`,
    );
  } else {
    line(
      "fail",
      "footprint.json is missing or invalid",
      "Run `developer-footprint validate` for details.",
    );
  }

  const loadedSignature = await loadDocument(paths.signature);
  if (loadedSignature.kind === "missing") {
    line(
      "info",
      "footprint.sig not present yet",
      "Run `developer-footprint sign` once you have a key.",
    );
  } else if (
    loadedSignature.kind !== "ok" ||
    !validateSignatureEnvelope(loadedSignature.value).ok
  ) {
    line("fail", "footprint.sig is not a valid signature envelope");
  } else if (loadedIdentity.kind === "ok" && loadedFootprint.kind === "ok") {
    const result = await verifyFootprint({
      footprint: loadedFootprint.value,
      signature: loadedSignature.value,
      identity: loadedIdentity.value,
    });
    line(
      result.valid ? "pass" : "fail",
      result.valid
        ? "footprint.sig verifies against this identity"
        : `footprint.sig does not verify: ${result.errors[0]?.message ?? "unknown reason"}`,
    );
  }

  ctx.stdout(`\n  ${s.dim("Key directory: " + keyDir)}\n`);
  ctx.stdout(`  ${s.dim("No network requests were made.")}\n`);
  return failures > 0 ? 1 : 0;
}
