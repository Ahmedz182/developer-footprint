import { copyFile, mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  normalizeUrl,
  validateFootprint,
  validateIdentity,
  verifyFootprint,
  wellKnownUrlFor,
} from "@developer-footprint/core";
import { PROJECT_OPTIONS, parseCommandArgs } from "../args.js";
import { CliError, type Context } from "../context.js";
import { createStyler } from "../output.js";
import { projectPaths, requireDocument, writeDocument } from "../store.js";
import { detectWebRoot } from "../webroot.js";

export const EXPORT_HELP = `Usage: developer-footprint export [options]

Copy your signed footprint into a website's folder as plain static files, for a plain HTML site or
any framework (Next.js, Astro, Vite, Nuxt, SvelteKit, Hugo, Jekyll…). It writes:

  <out>/.well-known/developer-footprint/footprint.json   your footprint
  <out>/.well-known/developer-footprint/footprint.sig    its signature
  <out>/.well-known/developer-footprint.json             your identity   (only with --identity)
  <out>/developer-footprint/badge.js                     the badge script (only with --badge)

then prints the HTML to paste into your page. Nothing is uploaded: you deploy the files yourself.
It refuses to export a footprint whose signature does not verify.

Options:
  --out <dir>    The folder served from the site root (default: detected from your project,
                 e.g. public/ for Next.js, static/ for Hugo)
  --site <url>   The URL the site will be deployed at, for exact links in the output
  --identity     Also write the identity document. Only deploy it to YOUR identity's own site,
                 at https://<your-site>/.well-known/developer-footprint.json
  --badge        Also copy the self-contained <developer-footprint-badge> script (no CDN needed)
  --dir <path>   Project directory (default: current directory)
  -h, --help
`;

const OPTIONS = {
  ...PROJECT_OPTIONS,
  out: { type: "string" },
  site: { type: "string" },
  identity: { type: "boolean" },
  badge: { type: "boolean" },
} as const;

const RUN_INIT = "Run `developer-footprint init`, `keygen` and `sign` first.";

export async function runExport(argv: readonly string[], ctx: Context): Promise<number> {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (values.help === true) {
    ctx.stdout(EXPORT_HELP);
    return 0;
  }
  const paths = projectPaths(ctx, values.dir);
  const s = createStyler(ctx.color);

  const footprintDocument = await requireDocument(paths.footprint, "footprint", RUN_INIT);
  const signatureDocument = await requireDocument(
    paths.signature,
    "signature",
    "Run `developer-footprint sign` first.",
  );
  const identityDocument = await requireDocument(paths.identity, "identity document", RUN_INIT);
  const identity = validateIdentity(identityDocument);
  const footprint = validateFootprint(footprintDocument);
  if (!identity.ok || !footprint.ok) {
    throw new CliError(
      "the documents are not valid",
      1,
      "Run `developer-footprint validate` for details.",
    );
  }

  // Never publish something that would show as broken to every visitor.
  const verification = await verifyFootprint({
    footprint: footprintDocument,
    signature: signatureDocument,
    identity: identityDocument,
  });
  if (!verification.valid) {
    throw new CliError(
      `the signature does not verify: ${verification.errors[0]?.message ?? "unknown reason"}`,
      1,
      "Run `developer-footprint sign` again after changing the footprint, then `verify`.",
    );
  }

  const identityUrl = wellKnownUrlFor(identity.value.canonicalUrl);
  if (!identityUrl.ok) throw new CliError(identityUrl.error.message, 1);

  let site: URL | undefined;
  if (values.site !== undefined) {
    const normalized = normalizeUrl(values.site);
    if (!normalized.ok) throw new CliError(`--site: ${normalized.error.message}`, 2);
    site = new URL(normalized.value);
  }
  if (
    values.identity === true &&
    site !== undefined &&
    site.origin !== new URL(identityUrl.value).origin
  ) {
    throw new CliError(
      `--identity would publish the identity document on ${site.origin}, but it must live on ${new URL(identityUrl.value).origin}`,
      2,
      "An identity document is only valid on the site it names. Deploy it there, or drop --identity for this site.",
    );
  }

  // Where to write.
  let out: string;
  let detected: Awaited<ReturnType<typeof detectWebRoot>>;
  if (values.out !== undefined) {
    out = resolve(ctx.cwd, values.out);
  } else {
    detected = await detectWebRoot(resolve(ctx.cwd, values.dir ?? "."));
    if (detected === undefined) {
      throw new CliError(
        "could not tell where your site's public folder is",
        2,
        "Pass it explicitly, e.g. --out public  (or --out . for a plain HTML site).",
      );
    }
    out = resolve(ctx.cwd, values.dir ?? ".", detected.dir);
  }

  const wellKnown = join(out, ".well-known");
  const footprintDir = join(wellKnown, "developer-footprint");
  await mkdir(footprintDir, { recursive: true });
  const written: string[] = [];
  const record = (path: string): void => void written.push(relative(ctx.cwd, path) || path);

  await writeDocument(join(footprintDir, "footprint.json"), footprint.value).then(() =>
    record(join(footprintDir, "footprint.json")),
  );
  await writeDocument(join(footprintDir, "footprint.sig"), signatureDocument).then(() =>
    record(join(footprintDir, "footprint.sig")),
  );
  if (values.identity === true) {
    await writeDocument(join(wellKnown, "developer-footprint.json"), identity.value);
    record(join(wellKnown, "developer-footprint.json"));
  }

  let badgeCopied = false;
  if (values.badge === true) {
    const source = ctx.badgeBundlePath;
    if (source === undefined)
      throw new CliError(
        "the badge script is not available in this installation",
        2,
        "Reinstall the CLI, or use the npm package @developer-footprint/web.",
      );
    const badgeDir = join(out, "developer-footprint");
    await mkdir(badgeDir, { recursive: true });
    await copyFile(source, join(badgeDir, "badge.js"));
    record(join(badgeDir, "badge.js"));
    badgeCopied = true;
  }

  const base = site === undefined ? "" : site.origin;
  ctx.stdout(
    `${s.green("✓")} Exported ${s.bold(footprint.value.project.name)}${detected === undefined ? "" : ` for ${s.bold(detected.framework)}`}\n`,
  );
  for (const path of written) ctx.stdout(`  ${s.dim("wrote")} ${path}\n`);

  ctx.stdout(`\n${s.bold("Paste this into your page")} ${s.dim("(inside <head> or <body>)")}\n\n`);
  const lines = [
    `<link rel="developer-footprint" href="${base}/.well-known/developer-footprint/footprint.json">`,
    ...(badgeCopied
      ? [
          `<developer-footprint-badge src="${base}/.well-known/developer-footprint/"></developer-footprint-badge>`,
          `<script type="module" src="${base}/developer-footprint/badge.js"></script>`,
        ]
      : []),
  ];
  for (const line of lines) ctx.stdout(`  ${s.cyan(line)}\n`);
  if (!badgeCopied) {
    ctx.stdout(
      `\n  ${s.dim("Want the visible badge? Re-run with --badge, or in a framework project:  npm install @developer-footprint/web")}\n`,
    );
  }

  ctx.stdout(`\n${s.bold("Then")}\n`);
  ctx.stdout(
    "  • Deploy your site as usual. These are ordinary static files; nothing is uploaded by this command.\n",
  );
  ctx.stdout(`  • Your identity document must be reachable at ${s.bold(identityUrl.value)}\n`);
  if (values.identity === true) {
    ctx.stdout(
      "    (you exported it here; serve it with the header  Access-Control-Allow-Origin: *  so other sites' badges can read it)\n",
    );
  } else {
    ctx.stdout(
      "    (deploy it to that site with `developer-footprint export --identity`, or copy .developer-footprint/identity.json there)\n",
    );
  }
  for (const note of detected?.notes ?? []) ctx.stdout(`  ${s.yellow("!")} ${note}\n`);
  return 0;
}
