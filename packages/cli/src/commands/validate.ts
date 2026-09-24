import {
  canonicalize,
  digestDocument,
  parseJson,
  validateFootprint,
  validateIdentity,
  validateSignatureEnvelope,
  wellKnownUrlFor,
  type FootprintError,
  type Result,
} from "@developer-footprint/core";
import { PROJECT_OPTIONS, parseCommandArgs } from "../args.js";
import { CliError, type Context } from "../context.js";
import { SYMBOLS, createStyler } from "../output.js";
import { loadDocument, projectPaths } from "../store.js";

export const VALIDATE_HELP = `Usage: developer-footprint validate [options]

Check .developer-footprint/{identity.json,footprint.json,footprint.sig} against the protocol:
schema, supported version, URL safety, roles, duplicates and canonical form. It does not check
signatures (use \`verify\`) and makes no network requests.

Options:
  --json       Print the result as JSON
  --dir <path> Project directory (default: current directory)
  -h, --help

Exit codes: 0 valid, 1 invalid, 2 could not run.
`;

const OPTIONS = { ...PROJECT_OPTIONS, json: { type: "boolean" } } as const;

interface Finding {
  readonly file: string;
  readonly status: "pass" | "fail" | "skip" | "warn";
  readonly message: string;
  readonly issues?: readonly { path: string; message: string }[];
}

function problems(error: FootprintError): readonly { path: string; message: string }[] {
  return (error.issues ?? []).map((issue) => ({
    path: issue.path === "" ? "(document)" : issue.path,
    message: issue.message,
  }));
}

/** A document must canonicalize, and re-reading its canonical form must not change it. */
function checkCanonical(value: unknown): Result<string> {
  const first = canonicalize(value);
  if (!first.ok) return first;
  const reread = parseJson(first.value);
  if (!reread.ok) return reread;
  const second = canonicalize(reread.value);
  if (!second.ok) return second;
  return second.value === first.value
    ? first
    : { ok: false, error: { code: "UNCANONICALIZABLE", message: "canonical form is not stable" } };
}

export async function runValidate(argv: readonly string[], ctx: Context): Promise<number> {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (values.help === true) {
    ctx.stdout(VALIDATE_HELP);
    return 0;
  }
  const paths = projectPaths(ctx, values.dir);
  const s = createStyler(ctx.color);
  const findings: Finding[] = [];
  const extra: string[] = [];

  const check = async <T>(
    file: string,
    path: string,
    label: string,
    validate: (input: unknown) => Result<T>,
    { required }: { required: boolean },
    after?: (value: T) => Promise<void>,
  ): Promise<T | undefined> => {
    const loaded = await loadDocument(path);
    if (loaded.kind === "unreadable") throw new CliError(loaded.message, 2);
    if (loaded.kind === "missing") {
      findings.push(
        required
          ? {
              file,
              status: "fail",
              message: `${label} not found`,
              issues: [{ path: "", message: "Run `developer-footprint init` first." }],
            }
          : { file, status: "skip", message: `${label} not present (not signed yet)` },
      );
      return undefined;
    }
    if (loaded.kind === "invalid") {
      findings.push({ file, status: "fail", message: loaded.error.message });
      return undefined;
    }
    const result = validate(loaded.value);
    if (!result.ok) {
      findings.push({
        file,
        status: "fail",
        message: result.error.message,
        issues: problems(result.error),
      });
      return undefined;
    }
    const canonical = checkCanonical(result.value);
    if (!canonical.ok) {
      findings.push({ file, status: "fail", message: canonical.error.message });
      return undefined;
    }
    findings.push({ file, status: "pass", message: `${label} follows Developer Footprint 1.0` });
    await after?.(result.value);
    return result.value;
  };

  const identity = await check(
    "identity.json",
    paths.identity,
    "identity document",
    validateIdentity,
    { required: true },
  );
  const footprint = await check(
    "footprint.json",
    paths.footprint,
    "footprint",
    validateFootprint,
    { required: true },
    async (value) => {
      const digest = await digestDocument(value);
      if (digest.ok) extra.push(`canonical digest  ${digest.value}`);
    },
  );
  await check("footprint.sig", paths.signature, "signature envelope", validateSignatureEnvelope, {
    required: false,
  });

  if (identity !== undefined && footprint !== undefined) {
    const url = wellKnownUrlFor(identity.canonicalUrl);
    if (url.ok && !footprint.contributors.some((c) => c.identity === url.value)) {
      findings.push({
        file: "footprint.json",
        status: "warn",
        message: `${identity.name} is not credited in this footprint, so this identity cannot sign it`,
      });
    }
  }

  const failed = findings.some((finding) => finding.status === "fail");
  if (values.json === true) {
    ctx.stdout(`${JSON.stringify({ valid: !failed, findings }, null, 2)}\n`);
    return failed ? 1 : 0;
  }

  ctx.stdout(`${s.bold("Developer Footprint validate")}\n\n`);
  for (const finding of findings) {
    const mark =
      finding.status === "pass"
        ? s.green(SYMBOLS.pass)
        : finding.status === "fail"
          ? s.red(SYMBOLS.fail)
          : finding.status === "warn"
            ? s.yellow(SYMBOLS.warn)
            : s.dim(SYMBOLS.skip);
    ctx.stdout(`  ${mark} ${finding.file.padEnd(15)} ${finding.message}\n`);
    for (const issue of finding.issues ?? []) {
      ctx.stdout(`      ${s.red(issue.path)}  ${issue.message}\n`);
    }
  }
  for (const line of extra) ctx.stdout(`\n  ${s.dim(line)}\n`);
  ctx.stdout(
    failed
      ? `\n${s.red("Not valid.")} Fix the problems above and run again.\n`
      : `\n${s.green("Valid.")} Next: ${s.cyan("developer-footprint sign")}\n`,
  );
  return failed ? 1 : 0;
}
