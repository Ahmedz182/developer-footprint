// Release sanity check, run by .github/workflows/release.yml (and runnable locally):
//
//   node tooling/check-release.mjs            # check that the three packages agree
//   GITHUB_REF_TYPE=tag GITHUB_REF_NAME=v0.1.0 node tooling/check-release.mjs
//
// Fails (exit 1) unless
//   - core, web and the CLI have exactly the same version (they are released in lockstep), and
//   - when run for a tag `vX.Y.Z`, that tag equals the version in the packages.
// In GitHub Actions it also exports `version` and `npm_tag` for later steps: stable versions are
// published to `latest`, prerelease versions (1.0.0-beta.1) to `next`, so a prerelease can never
// become what a plain `npm install` gets.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const packages = ["core", "web", "cli"].map((name) => {
  const manifest = JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8"));
  return { name: manifest.name, version: manifest.version };
});

const problems = [];
const versions = new Set(packages.map((pkg) => pkg.version));
if (versions.size !== 1) {
  problems.push(
    `packages must share one version, found: ${packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ")}`,
  );
}

const version = packages[0].version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  problems.push(`"${version}" is not a valid semantic version`);
}

if (process.env.GITHUB_REF_TYPE === "tag") {
  const tag = process.env.GITHUB_REF_NAME ?? "";
  if (tag !== `v${version}`) {
    problems.push(`tag "${tag}" does not match the package version (expected "v${version}")`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`release check failed: ${problem}`);
  process.exit(1);
}

const npmTag = version.includes("-") ? "next" : "latest";
console.log(`OK: ${packages.map((pkg) => pkg.name).join(", ")} @ ${version} (npm tag: ${npmTag})`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nnpm_tag=${npmTag}\n`);
}
