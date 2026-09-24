import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface WebRoot {
  /** Human-readable name of what was detected. */
  readonly framework: string;
  /** Folder (relative to the project) whose contents are served from the site root. */
  readonly dir: string;
  /** Things the person must still do for the files to actually be served. */
  readonly notes: readonly string[];
}

interface Rule {
  readonly dependency: string;
  readonly framework: string;
  readonly dir: string;
  readonly notes?: readonly string[];
}

// Order matters: meta-frameworks come before the bundlers they are built on.
const PACKAGE_RULES: readonly Rule[] = [
  { dependency: "next", framework: "Next.js", dir: "public" },
  { dependency: "astro", framework: "Astro", dir: "public" },
  { dependency: "nuxt", framework: "Nuxt", dir: "public" },
  { dependency: "@sveltejs/kit", framework: "SvelteKit", dir: "static" },
  { dependency: "gatsby", framework: "Gatsby", dir: "static" },
  { dependency: "@docusaurus/core", framework: "Docusaurus", dir: "static" },
  { dependency: "@remix-run/react", framework: "Remix", dir: "public" },
  {
    dependency: "@angular/core",
    framework: "Angular",
    dir: "public",
    notes: [
      "After `ng build`, check that dist/ contains .well-known/: some asset globs skip folders that start with a dot.",
    ],
  },
  { dependency: "react-scripts", framework: "Create React App", dir: "public" },
  { dependency: "@vue/cli-service", framework: "Vue CLI", dir: "public" },
  { dependency: "vite", framework: "Vite (React, Vue, Svelte, Solid, plain JS…)", dir: "public" },
  {
    dependency: "@11ty/eleventy",
    framework: "Eleventy",
    dir: ".",
    notes: [
      'Add `eleventyConfig.addPassthroughCopy(".well-known")` (and "developer-footprint") to your Eleventy config.',
    ],
  },
];

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readDependencies(cwd: string): Promise<ReadonlySet<string>> {
  try {
    const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const names = new Set<string>();
    for (const field of ["dependencies", "devDependencies"]) {
      const section = manifest[field];
      if (typeof section === "object" && section !== null)
        for (const name of Object.keys(section)) names.add(name);
    }
    return names;
  } catch {
    return new Set();
  }
}

/**
 * Finds the folder whose files are served from the root of the site, so `.well-known/` ends up
 * where browsers will ask for it. Detection is a convenience: `--out` always overrides it.
 */
export async function detectWebRoot(cwd: string): Promise<WebRoot | undefined> {
  const dependencies = await readDependencies(cwd);
  for (const rule of PACKAGE_RULES) {
    if (dependencies.has(rule.dependency)) {
      return { framework: rule.framework, dir: rule.dir, notes: rule.notes ?? [] };
    }
  }

  for (const config of ["hugo.toml", "hugo.yaml", "hugo.json", "config.toml"]) {
    if (await isFile(join(cwd, config))) return { framework: "Hugo", dir: "static", notes: [] };
  }
  if (await isFile(join(cwd, "_config.yml"))) {
    return {
      framework: "Jekyll / GitHub Pages",
      dir: ".",
      notes: [
        'Jekyll skips folders that start with a dot. Add to _config.yml:  include: [".well-known"]',
        "GitHub Pages: this also works with a .nojekyll file at the site root (which turns Jekyll off).",
      ],
    };
  }
  if (await isFile(join(cwd, "public", "index.html")))
    return { framework: "static site (public/)", dir: "public", notes: [] };
  if (await isFile(join(cwd, "index.html")))
    return { framework: "plain HTML", dir: ".", notes: [] };
  return undefined;
}
