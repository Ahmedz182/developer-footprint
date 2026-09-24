// End-to-end: a plain HTML page (no framework, no build step, no CDN) loads the self-contained
// bundle and verifies a footprint in a real browser. Skipped, loudly, when no Chrome/Edge exists.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vectorCase, vectors } from "./support.js";

function findBrowser(): string | undefined {
  const candidates = [
    process.env["CHROME_PATH"],
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((path) => path !== undefined && existsSync(path));
}

const browser = findBrowser();
if (browser === undefined)
  console.warn("[web e2e] no Chrome/Edge found (set CHROME_PATH): skipping browser tests");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".sig": "application/json",
};

const REPORT_JS = `
const badge = document.querySelector("developer-footprint-badge");
const report = () => {
  const root = badge.shadowRoot;
  document.body.dataset.state = badge.dataset.state ?? "none";
  document.body.dataset.text = root ? root.textContent : "";
  document.body.dataset.sinks = String(root ? root.querySelectorAll("img,script,iframe,a[href],object,embed").length : -1);
  document.body.dataset.reported = "1";
};
for (const name of ["footprint-verified", "footprint-invalid", "footprint-error"]) {
  badge.addEventListener(name, () => { document.body.dataset.event = name; report(); });
}
setTimeout(report, 3000);
`;

const page = (attributes: string, extra = "") => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>MyCoolApp</title>
    <link rel="developer-footprint" href="/.well-known/developer-footprint/footprint.json" />
  </head>
  <body>
    <h1>MyCoolApp</h1>
    <developer-footprint-badge ${attributes}></developer-footprint-badge>
    <script type="module" src="/developer-footprint/badge.js"></script>
    <script type="module" src="/report.js"></script>${extra}
  </body>
</html>
`;

let server: Server | undefined;
let root = "";
let port = 0;

beforeAll(async () => {
  if (browser === undefined) return;
  root = await mkdtemp(join(tmpdir(), "df-web-e2e-"));
  const site = join(root, "site");
  await mkdir(join(site, ".well-known", "developer-footprint"), { recursive: true });
  await mkdir(join(site, "tampered"), { recursive: true });
  await mkdir(join(site, "hostile"), { recursive: true });
  await mkdir(join(site, "developer-footprint"), { recursive: true });

  // The real bundle, built exactly as `pnpm build` builds it.
  await build({
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    logLevel: "silent",
    build: { outDir: join(site, "developer-footprint") },
  });

  const write = (path: string, body: unknown) =>
    writeFile(join(site, path), typeof body === "string" ? body : JSON.stringify(body, null, 2));
  const identityPath = "/.well-known/developer-footprint.json";
  await write(".well-known/developer-footprint.json", vectors.identity);
  await write(".well-known/developer-footprint/footprint.json", vectors.footprint);
  await write(".well-known/developer-footprint/footprint.sig", vectors.signature);
  const tampered = vectorCase("role-escalated");
  await write("tampered/footprint.json", tampered.footprint);
  await write("tampered/footprint.sig", tampered.signature);
  const hostile = structuredClone(vectors.footprint) as { project: { name: string } };
  hostile.project.name = "<img src=x onerror=alert(1)><script>alert(2)</script>";
  await write("hostile/footprint.json", hostile);
  await write("hostile/footprint.sig", vectors.signature);
  await write("report.js", REPORT_JS);

  const good = `src="/.well-known/developer-footprint/" identity="${identityPath}"`;
  await write("index.html", page(good));
  await write("tampered.html", page(`src="/tampered/" identity="${identityPath}"`));
  await write("hostile.html", page(`src="/hostile/" identity="${identityPath}"`));
  await write("missing.html", page(`src="/nowhere/" identity="${identityPath}"`));
  await write("unconfigured.html", page(""));
  await write("csp.html", page(good));

  server = createServer((request, response) => {
    void (async () => {
      const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      const file = normalize(join(site, path === "/" ? "index.html" : path));
      if (!file.startsWith(site) || !existsSync(file)) {
        response.writeHead(404).end("not found");
        return;
      }
      const headers: Record<string, string> = {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
      };
      if (path === "/csp.html") {
        // A strict policy: no inline anything, and Trusted Types make every HTML-injection sink throw.
        headers["content-security-policy"] =
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; require-trusted-types-for 'script'";
      }
      response.writeHead(200, headers).end(await readFile(file));
    })();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) =>
    server === undefined ? resolve() : server.close(() => resolve()),
  );
  if (root !== "") await rm(root, { recursive: true, force: true });
});

interface Rendered {
  state: string;
  text: string;
  event: string;
  sinks: string;
  reported: string;
}

function attribute(dom: string, name: string): string {
  const match = new RegExp(`data-${name}="([^"]*)"`).exec(dom);
  return (match?.[1] ?? "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function open(pathname: string): Promise<Rendered> {
  const profile = join(root, `profile-${Math.random().toString(36).slice(2)}`);
  return new Promise((resolve, reject) => {
    execFile(
      browser!,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profile}`,
        "--virtual-time-budget=10000",
        "--dump-dom",
        `http://127.0.0.1:${port}${pathname}`,
      ],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null && stdout === "") return reject(new Error(error.message));
        resolve({
          state: attribute(stdout, "state"),
          text: attribute(stdout, "text"),
          event: attribute(stdout, "event"),
          sinks: attribute(stdout, "sinks"),
          reported: attribute(stdout, "reported"),
        });
      },
    );
  });
}

describe.skipIf(browser === undefined)("plain HTML page in a real browser", () => {
  it("verifies a genuine footprint with nothing but a script tag", async () => {
    const view = await open("/index.html");
    expect(view.reported).toBe("1");
    expect(view.state).toBe("verified");
    expect(view.event).toBe("footprint-verified");
    expect(view.text).toContain("Signature verified");
    expect(view.text).toContain("MyCoolApp: signed by Sarah (sarah.example) on 2026-09-24");
    expect(view.text).toContain("creator");
    expect(view.text).toContain("Claim is current: not checked");
  });

  it("shows a tampered footprint as not verified, without accusing anyone", async () => {
    const view = await open("/tampered.html");
    expect(view.state).toBe("invalid");
    expect(view.event).toBe("footprint-invalid");
    expect(view.text).toContain("Could not verify this claim");
    expect(view.text).toContain("does not prove malicious behavior");
  });

  it("renders hostile document text as plain text: no element is injected", async () => {
    const view = await open("/hostile.html");
    expect(view.state).toBe("invalid");
    expect(view.sinks).toBe("0");
  });

  it("reports missing files as a problem with the check, not with the claim", async () => {
    const view = await open("/missing.html");
    expect(view.state).toBe("error");
    expect(view.event).toBe("footprint-error");
    expect(view.text).toContain("Nothing is wrong with the claim itself");
  });

  it("explains itself when no src is given", async () => {
    const view = await open("/unconfigured.html");
    expect(view.state).toBe("unconfigured");
    expect(view.text).toContain('Set the "src" attribute');
  });

  it("works under a strict CSP with Trusted Types, so it uses no HTML-injection sink", async () => {
    const view = await open("/csp.html");
    expect(view.state).toBe("verified");
    expect(view.text).toContain("Signature verified");
  });
});
