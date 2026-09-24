// Refreshes examples/plain-html from the current build and the shared test vectors:
//   - the browser badge bundle  (build output, not committed)
//   - a signed demo footprint + identity, signed with the PUBLICLY KNOWN RFC 8032 test key
//
//   pnpm build && node tooling/sync-example.mjs
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const example = join(root, "examples", "plain-html");
const bundle = join(root, "packages", "web", "dist", "browser", "badge.js");
if (!existsSync(bundle)) {
  console.error("packages/web/dist/browser/badge.js is missing. Run `pnpm build` first.");
  process.exit(1);
}

const vectors = JSON.parse(
  readFileSync(join(root, "spec", "test-vectors", "signing.json"), "utf8"),
);
const tampered = vectors.cases.find((c) => c.name === "role-escalated");
const write = (relative, value) => {
  const path = join(example, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

mkdirSync(join(example, "developer-footprint"), { recursive: true });
copyFileSync(bundle, join(example, "developer-footprint", "badge.js"));
write(".well-known/developer-footprint.json", vectors.identity);
write(".well-known/developer-footprint/footprint.json", vectors.footprint);
write(".well-known/developer-footprint/footprint.sig", vectors.signature);
write("tampered/footprint.json", tampered.footprint);
write("tampered/footprint.sig", tampered.signature);
console.log("examples/plain-html is up to date.");
