import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectWebRoot } from "../src/webroot.js";
import { harness, initFlags, tempDir } from "./harness.js";

let dir: { path: string; cleanup: () => Promise<void> };
let keys: string;

beforeEach(async () => {
  dir = await tempDir();
  keys = join(dir.path, "keys");
});
afterEach(async () => {
  await dir.cleanup();
});

async function signedProject(project = dir.path) {
  await mkdir(project, { recursive: true });
  const h = harness({ cwd: project });
  expect(await h.run(initFlags())).toBe(0);
  expect(await h.run(["keygen", "--key-dir", keys])).toBe(0);
  expect(await h.run(["sign", "--key-dir", keys])).toBe(0);
}

const json = async (...parts: string[]): Promise<unknown> =>
  JSON.parse(await readFile(join(...parts), "utf8"));

describe("export", () => {
  it("writes static files a plain HTML site can serve, and prints the snippet", async () => {
    await signedProject();
    const badge = join(dir.path, "fake-badge.js");
    await writeFile(badge, "// badge bundle");
    const h = harness({ cwd: dir.path });
    (h.context as { badgeBundlePath?: string }).badgeBundlePath = badge;
    expect(
      await h.run(["export", "--out", "site", "--badge", "--site", "https://mycoolapp.example"]),
    ).toBe(0);

    const base = join(dir.path, "site", ".well-known", "developer-footprint");
    expect(await json(base, "footprint.json")).toEqual(
      await json(dir.path, ".developer-footprint", "footprint.json"),
    );
    expect(await json(base, "footprint.sig")).toEqual(
      await json(dir.path, ".developer-footprint", "footprint.sig"),
    );
    expect(await readFile(join(dir.path, "site", "developer-footprint", "badge.js"), "utf8")).toBe(
      "// badge bundle",
    );
    // The identity belongs on the identity's own site, so it is not written unless asked for.
    expect(existsSync(join(dir.path, "site", ".well-known", "developer-footprint.json"))).toBe(
      false,
    );

    const text = h.stdout();
    expect(text).toContain(
      '<link rel="developer-footprint" href="https://mycoolapp.example/.well-known/developer-footprint/footprint.json">',
    );
    expect(text).toContain(
      '<developer-footprint-badge src="https://mycoolapp.example/.well-known/developer-footprint/">',
    );
    expect(text).toContain(
      '<script type="module" src="https://mycoolapp.example/developer-footprint/badge.js">',
    );
    expect(text).toContain("https://sarah.example/.well-known/developer-footprint.json");
    expect(text).toContain("nothing is uploaded");
  });

  it("writes the identity document only when asked, and only for its own site", async () => {
    await signedProject();
    const own = harness({ cwd: dir.path });
    expect(
      await own.run(["export", "--out", "site", "--identity", "--site", "https://sarah.example"]),
    ).toBe(0);
    expect(await json(dir.path, "site", ".well-known", "developer-footprint.json")).toEqual(
      await json(dir.path, ".developer-footprint", "identity.json"),
    );
    expect(own.stdout()).toContain("Access-Control-Allow-Origin");

    const wrongSite = harness({ cwd: dir.path });
    expect(
      await wrongSite.run([
        "export",
        "--out",
        "other",
        "--identity",
        "--site",
        "https://mycoolapp.example",
      ]),
    ).toBe(2);
    expect(wrongSite.stderr()).toContain("must live on https://sarah.example");
    expect(existsSync(join(dir.path, "other"))).toBe(false);
  });

  it("refuses to export a signature that does not verify", async () => {
    await signedProject();
    const path = join(dir.path, ".developer-footprint", "footprint.json");
    const footprint = JSON.parse(await readFile(path, "utf8")) as { project: { name: string } };
    footprint.project.name = "Changed after signing";
    await writeFile(path, JSON.stringify(footprint));
    const h = harness({ cwd: dir.path });
    expect(await h.run(["export", "--out", "site"])).toBe(1);
    expect(h.stderr()).toContain("the signature does not verify");
    expect(existsSync(join(dir.path, "site"))).toBe(false);
  });

  it("needs a signed project", async () => {
    const h = harness({ cwd: dir.path });
    await h.run(initFlags());
    expect(await h.run(["export", "--out", "site"])).toBe(2);
    expect(h.stderr()).toContain("Run `developer-footprint sign` first.");
  });

  it("detects the public folder of a Next.js project", async () => {
    await writeFile(
      join(dir.path, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }),
    );
    await signedProject();
    const h = harness({ cwd: dir.path });
    expect(await h.run(["export"])).toBe(0);
    expect(
      existsSync(join(dir.path, "public", ".well-known", "developer-footprint", "footprint.json")),
    ).toBe(true);
    expect(h.stdout()).toContain("for Next.js");
  });

  it("asks for --out when it cannot tell", async () => {
    await signedProject();
    const h = harness({ cwd: dir.path });
    expect(await h.run(["export"])).toBe(2);
    expect(h.stderr()).toContain("could not tell where your site's public folder is");
    expect(h.stderr()).toContain("--out");
  });

  it("re-exporting is safe and overwrites its own output", async () => {
    await signedProject();
    for (let i = 0; i < 2; i++) {
      const h = harness({ cwd: dir.path });
      expect(await h.run(["export", "--out", "site"])).toBe(0);
    }
    expect(
      existsSync(join(dir.path, "site", ".well-known", "developer-footprint", "footprint.json")),
    ).toBe(true);
  });

  it("explains a missing badge script instead of failing obscurely", async () => {
    await signedProject();
    const h = harness({ cwd: dir.path });
    expect(await h.run(["export", "--out", "site", "--badge"])).toBe(2);
    expect(h.stderr()).toContain("badge script is not available");
  });

  it("never writes outside the chosen folder", async () => {
    await signedProject();
    const h = harness({ cwd: dir.path });
    expect(await h.run(["export", "--out", "site"])).toBe(0);
    for (const line of h
      .stdout()
      .split("\n")
      .filter((l) => l.includes("wrote"))) {
      expect(line).toContain("site");
    }
  });
});

describe("detectWebRoot", () => {
  const detect = async (files: Record<string, string>) => {
    const root = join(dir.path, `probe-${Math.random().toString(36).slice(2)}`);
    await mkdir(root, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await mkdir(join(root, name, ".."), { recursive: true });
      await writeFile(join(root, name), content);
    }
    return detectWebRoot(root);
  };
  const pkg = (dependencies: Record<string, string>, dev: Record<string, string> = {}) => ({
    "package.json": JSON.stringify({ dependencies, devDependencies: dev }),
  });

  it.each([
    ["Next.js", { next: "15" }, "public"],
    ["Astro", { astro: "5" }, "public"],
    ["Nuxt", { nuxt: "3" }, "public"],
    ["SvelteKit", { "@sveltejs/kit": "2" }, "static"],
    ["Gatsby", { gatsby: "5" }, "static"],
    ["Docusaurus", { "@docusaurus/core": "3" }, "static"],
    ["Remix", { "@remix-run/react": "2" }, "public"],
    ["Angular", { "@angular/core": "19" }, "public"],
    ["Create React App", { "react-scripts": "5" }, "public"],
    ["Vue CLI", { "@vue/cli-service": "5" }, "public"],
    ["Vite", { vite: "7" }, "public"],
    ["Eleventy", { "@11ty/eleventy": "3" }, "."],
  ])("recognizes %s", async (name, dependencies, folder) => {
    const found = await detect(pkg({}, dependencies));
    expect(found?.framework).toContain(name);
    expect(found?.dir).toBe(folder);
  });

  it("prefers the meta-framework over the bundler underneath it", async () => {
    expect((await detect(pkg({ astro: "5", vite: "7" })))?.framework).toBe("Astro");
    expect((await detect(pkg({ next: "15", react: "19" })))?.framework).toBe("Next.js");
  });

  it("recognizes Hugo, Jekyll and plain HTML", async () => {
    expect(await detect({ "hugo.toml": "title = 'x'" })).toMatchObject({
      framework: "Hugo",
      dir: "static",
    });
    const jekyll = await detect({ "_config.yml": "title: x" });
    expect(jekyll).toMatchObject({ framework: "Jekyll / GitHub Pages", dir: "." });
    expect(jekyll?.notes.join(" ")).toContain('include: [".well-known"]');
    expect(await detect({ "index.html": "<html></html>" })).toMatchObject({
      framework: "plain HTML",
      dir: ".",
    });
    expect(await detect({ "public/index.html": "<html></html>" })).toMatchObject({ dir: "public" });
  });

  it("returns nothing for an unrecognized project, and tolerates a broken package.json", async () => {
    expect(await detect({ "README.md": "hi" })).toBeUndefined();
    expect(await detect({ "package.json": "{ not json" })).toBeUndefined();
    expect(
      await detect({ "package.json": JSON.stringify({ dependencies: "nope" }) }),
    ).toBeUndefined();
  });
});
