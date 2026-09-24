// Assembles the ONE package that is published to npm: `developer-footprint`.
//
// The repository keeps core, web and the CLI as separate workspace packages (so core's
// "no network, no Node-only APIs" rules stay enforced by its own compiler and lint config). Only
// `developer-footprint` is published, and it must be self-contained, so after the CLI is compiled
// this script copies the already-built core and web output INTO it and points their imports at the
// copies:
//
//   dist/                      the CLI (bin) and its modules         (compiled by tsc)
//   dist/core/                 @developer-footprint/core, built      -> import "developer-footprint"
//   dist/web/                  @developer-footprint/web, built       -> import "developer-footprint/web"
//   dist/browser/badge.js      the self-contained <script type="module"> bundle
//                                                                    -> "developer-footprint/browser"
//   dist/index.js|.d.ts        re-exports dist/core (the SDK is the package's main entry)
//
// It runs as the last step of the CLI's build: build core and web first (pnpm -r build does).
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const root = join(import.meta.dirname, "..");
const cliDist = join(root, "packages", "cli", "dist");
const coreDist = join(root, "packages", "core", "dist");
const webDist = join(root, "packages", "web", "dist");

for (const [label, path] of [
  ["CLI", join(cliDist, "bin.js")],
  ["core", join(coreDist, "index.js")],
  ["web", join(webDist, "index.js")],
  ["badge bundle", join(webDist, "browser", "badge.js")],
]) {
  if (!existsSync(path)) {
    console.error(
      `missing ${label} build output (${path}). Run \`pnpm build\` from the repository root.`,
    );
    process.exit(1);
  }
}

// 1. Copy the built packages in. Source maps are not shipped (they point at sources that are not
//    in the tarball).
const copy = (from, to, exclude = () => false) => {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, {
    recursive: true,
    filter: (source) => !source.endsWith(".map") && !exclude(source),
  });
};
copy(coreDist, join(cliDist, "core"));
copy(webDist, join(cliDist, "web"), (source) => source === join(webDist, "browser"));
mkdirSync(join(cliDist, "browser"), { recursive: true });
cpSync(join(webDist, "browser", "badge.js"), join(cliDist, "browser", "badge.js"));

// 2. Point the package's own imports at the copies. Only exact, quoted bare specifiers are
//    rewritten, so nothing else in a file can be touched by accident.
const SPECIFIER = '"@developer-footprint/core"';
const coreEntry = join(cliDist, "core", "index.js");
const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)],
  );

let rewritten = 0;
for (const file of walk(cliDist)) {
  if (!file.endsWith(".js") && !file.endsWith(".d.ts")) continue;
  if (file.startsWith(join(cliDist, "browser") + sep)) continue; // a bundle: no bare imports
  const source = readFileSync(file, "utf8");
  if (!source.includes(SPECIFIER)) continue;
  let target = relative(dirname(file), coreEntry).split(sep).join("/");
  if (!target.startsWith(".")) target = `./${target}`;
  writeFileSync(file, source.replaceAll(SPECIFIER, JSON.stringify(target)));
  rewritten++;
}

// 3. The SDK is the package's main entry.
writeFileSync(join(cliDist, "index.js"), 'export * from "./core/index.js";\n');
writeFileSync(join(cliDist, "index.d.ts"), 'export * from "./core/index.js";\n');

// 4. Nothing must still reach for a workspace package: it would not exist for an installer.
const leftovers = walk(cliDist).filter(
  (file) =>
    (file.endsWith(".js") || file.endsWith(".d.ts")) &&
    !file.startsWith(join(cliDist, "browser") + sep) &&
    /from ["']@developer-footprint\/|import\(["']@developer-footprint\//.test(
      readFileSync(file, "utf8"),
    ),
);
if (leftovers.length > 0) {
  console.error(`unresolved workspace imports remain in:\n  ${leftovers.join("\n  ")}`);
  process.exit(1);
}
console.log(`assembled developer-footprint: rewrote imports in ${rewritten} files`);
