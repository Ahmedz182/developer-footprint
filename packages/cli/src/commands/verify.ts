import { resolve } from "node:path";
import {
  OFFLINE_CHECKS,
  validateFootprint,
  validateIdentity,
  verifyFootprint,
  wellKnownUrlFor,
  type CheckName,
  type CheckStatus,
  type Footprint,
  type Identity,
  type VerificationResult,
} from "@developer-footprint/core";
import { PROJECT_OPTIONS, parseCommandArgs } from "../args.js";
import type { Context } from "../context.js";
import { SYMBOLS, createStyler, type Styler } from "../output.js";
import { projectPaths, requireDocument } from "../store.js";

export const VERIFY_HELP = `Usage: developer-footprint verify [options]

Verify a signed footprint using only local files. No network requests are made.

By default it reads .developer-footprint/{footprint.json,footprint.sig,identity.json}. The bundled
identity.json only proves that *that* key signed the footprint. To confirm the key really belongs to
the signer's domain, download https://<their-site>/.well-known/developer-footprint.json yourself
and pass it with --identity.

Options:
  --footprint <path>   Footprint document
  --signature <path>   Signature envelope
  --identity <path>    Identity document of the signer (e.g. one you downloaded from their site)
  --json               Print the full result as JSON
  --dir <path>         Project directory (default: current directory)
  -h, --help

Exit codes: 0 verified, 1 not verified, 2 could not run (bad arguments or unreadable files).
`;

const OPTIONS = {
  ...PROJECT_OPTIONS,
  footprint: { type: "string" },
  signature: { type: "string" },
  identity: { type: "string" },
  json: { type: "boolean" },
} as const;

const TITLES: Readonly<Record<CheckName, string>> = {
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

const NOT_CHECKED_OFFLINE: readonly CheckName[] = [
  "identityDocumentResolved",
  "domainRelationship",
  "claimCurrent",
];

function symbol(status: CheckStatus, s: Styler): string {
  if (status === "pass") return s.green(SYMBOLS.pass);
  if (status === "fail") return s.red(SYMBOLS.fail);
  return s.dim(SYMBOLS.skip);
}

function render(result: VerificationResult, context: RenderContext, ctx: Context): void {
  const s = createStyler(ctx.color);
  const out = ctx.stdout;
  const { footprint, identity } = context;

  out(`${s.bold("Developer Footprint verify")}\n\n`);
  if (footprint !== undefined)
    out(`  Project   ${s.bold(footprint.project.name)}  ${s.dim(footprint.id)}\n`);
  if (result.signer !== undefined) {
    const who = identity === undefined ? "" : `${identity.name} (${identity.type})  `;
    out(`  Signer    ${who}${s.dim(result.signer.url)}\n`);
    out(`  Key       ${result.signer.keyId}   signed ${result.signedAt ?? ""}\n`);
  }
  out("\n");

  for (const name of OFFLINE_CHECKS) {
    const check = result.checks[name];
    out(
      `  ${symbol(check.status, s)} ${TITLES[name].padEnd(24)} ${check.status === "pass" ? s.dim(check.message) : check.message}\n`,
    );
  }

  for (const warning of result.warnings)
    out(`  ${s.yellow(SYMBOLS.warn)} ${s.yellow("Warning".padEnd(24))} ${warning.message}\n`);

  out(`\n  ${s.dim("Not checked (needs the network, which this command never uses)")}\n`);
  for (const name of NOT_CHECKED_OFFLINE) out(`  ${s.dim(`${SYMBOLS.skip} ${TITLES[name]}`)}\n`);

  if (footprint !== undefined && result.signer !== undefined) {
    out(`\n  ${s.bold("Attribution claimed in this footprint")}\n`);
    for (const contributor of footprint.contributors) {
      const isSigner = contributor.identity === result.signer.url;
      out(
        `  ${contributor.role.padEnd(13)} ${contributor.identity}${isSigner ? s.dim("  (signer)") : ""}\n`,
      );
    }
    if (footprint.contributors.some((c) => c.identity !== result.signer?.url)) {
      out(
        `  ${s.dim("Roles for other identities are asserted by the signer; those identities have not confirmed them.")}\n`,
      );
    }
  }

  out("\n");
  if (result.valid) {
    out(`${s.green(s.bold("Signature valid"))} for the supplied documents.\n`);
    const url = result.signer?.url ?? "the signer's domain";
    out(
      s.dim(
        context.identitySource === "supplied"
          ? "The identity document was supplied with --identity.\n"
          : `The identity document is the bundled copy. It has not been compared with ${url}\n`,
      ),
    );
  } else {
    out(
      `${s.red(s.bold("Not verified."))} ${result.errors[0]?.message ?? "Verification failed."}\n`,
    );
    out(
      s.dim(
        "This does not prove malicious behavior. It means these documents cannot currently be cryptographically verified.\n",
      ),
    );
  }
}

interface RenderContext {
  /** Present only if the document was valid enough to read. */
  readonly footprint: Footprint | undefined;
  readonly identity: Identity | undefined;
  readonly identitySource: "bundled" | "supplied";
}

export async function runVerify(argv: readonly string[], ctx: Context): Promise<number> {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (values.help === true) {
    ctx.stdout(VERIFY_HELP);
    return 0;
  }
  const paths = projectPaths(ctx, values.dir);
  const pick = (explicit: string | undefined, fallback: string): string =>
    explicit === undefined ? fallback : resolve(ctx.cwd, explicit);
  const init = "Run `developer-footprint init`, `keygen` and `sign` first.";

  const footprintPath = pick(values.footprint, paths.footprint);
  const signaturePath = pick(values.signature, paths.signature);
  const identityPath = pick(values.identity, paths.identity);
  const footprint = await requireDocument(footprintPath, "footprint", init);
  const signature = await requireDocument(
    signaturePath,
    "signature",
    "Run `developer-footprint sign` first.",
  );
  const identity = await requireDocument(identityPath, "identity document", init);
  const identitySource = values.identity === undefined ? "bundled" : "supplied";

  const result = await verifyFootprint({ footprint, signature, identity });

  if (values.json === true) {
    ctx.stdout(`${JSON.stringify({ ...result, identitySource }, null, 2)}\n`);
    return result.valid ? 0 : 1;
  }

  const parsedFootprint = validateFootprint(footprint);
  const parsedIdentity = validateIdentity(identity);
  render(
    result,
    {
      footprint: parsedFootprint.ok ? parsedFootprint.value : undefined,
      identity: parsedIdentity.ok ? parsedIdentity.value : undefined,
      identitySource,
    },
    ctx,
  );
  // Show where the signer's own document should be fetched from, without fetching it.
  if (identitySource === "bundled" && parsedIdentity.ok) {
    const url = wellKnownUrlFor(parsedIdentity.value.canonicalUrl);
    if (url.ok) {
      ctx.stdout(
        createStyler(ctx.color).dim(
          `To check it yourself: download ${url.value} and re-run with --identity <file>.\n`,
        ),
      );
    }
  }
  return result.valid ? 0 : 1;
}
