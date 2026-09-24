// Generates the README screenshots (docs/images/*.png) from the REAL tools:
//   - terminal images: the actual CLI (packages/cli/dist) is run in a scratch project, its real
//     output is captured with colour, laid out as a terminal window and photographed by headless Chrome
//   - web images: the actual example site (examples/plain-html) is served and photographed in Chrome
//
//   pnpm docs:screenshots            (builds first)
//
// Display-only substitutions (never the content itself): the private-key folder is shown as
// ~/.config/developer-footprint/keys so no machine-specific path or user name appears in an image.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run } from "../packages/cli/dist/cli.js";
import { startStaticServer } from "./serve.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const images = join(root, "docs", "images");
const ESC = String.fromCharCode(27);

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((path) => path !== undefined && existsSync(path));
}

const browser = findBrowser();
if (browser === undefined) {
  console.error("No Chrome/Edge found. Set CHROME_PATH to a Chromium-based browser.");
  process.exit(1);
}
if (!existsSync(join(root, "packages", "cli", "dist", "cli.js"))) {
  console.error("Build first: pnpm build");
  process.exit(1);
}

const chrome = (args, timeout = 90_000) =>
  new Promise((resolve, reject) => {
    execFile(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        ...args,
      ],
      { timeout },
      (error) => (error === null ? resolve() : reject(error)),
    );
  });

// ------------------------------------------------------------------------------------------------
// Terminal rendering
// ------------------------------------------------------------------------------------------------
const escapeHtml = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const CLASSES = { 1: "b", 2: "d", 31: "r", 32: "g", 33: "y", 36: "c" };

function ansiToHtml(text) {
  const token = new RegExp(`${ESC}\\[(\\d+)m`, "g");
  const active = new Set();
  let html = "";
  let last = 0;
  const emit = (chunk) => {
    if (chunk === "") return;
    const classes = [...active].map((code) => CLASSES[code]).filter(Boolean);
    html +=
      classes.length === 0
        ? escapeHtml(chunk)
        : `<span class="${classes.join(" ")}">${escapeHtml(chunk)}</span>`;
  };
  for (const match of text.matchAll(token)) {
    emit(text.slice(last, match.index));
    last = match.index + match[0].length;
    const code = Number(match[1]);
    if (code === 22) {
      active.delete(1);
      active.delete(2);
    } else if (code === 39) {
      for (const color of [31, 32, 33, 36]) active.delete(color);
    } else if (CLASSES[code]) {
      active.add(code);
    }
  }
  emit(text.slice(last));
  return html;
}

const visibleLength = (text) => text.replace(new RegExp(`${ESC}\\[\\d+m`, "g"), "").length;

function terminalPage(title, body) {
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:#0d1016}
  body{padding:28px;font:14px/20px "Cascadia Mono","SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace}
  .win{width:1044px;background:#151922;border:1px solid #2b3242;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.5);overflow:hidden}
  .bar{display:flex;align-items:center;gap:8px;padding:11px 14px;background:#1c212c;border-bottom:1px solid #2b3242;color:#8993a8;font:13px system-ui,"Segoe UI",sans-serif}
  .bar i{width:12px;height:12px;border-radius:50%;background:#ff5f57}.bar i:nth-child(2){background:#febc2e}.bar i:nth-child(3){background:#28c840}
  .bar span{margin-left:10px}
  pre{margin:0;padding:18px 20px 22px;color:#d9deea;white-space:pre-wrap;overflow-wrap:anywhere}
  .b{font-weight:700}.d{opacity:.62}.g{color:#63d49a}.r{color:#ff7b82}.y{color:#f3c56a}.c{color:#6ccbff}
  .p{color:#63d49a}.a{color:#6ccbff;font-weight:700}
</style><div class="win"><div class="bar"><i></i><i></i><i></i><span>${escapeHtml(title)}</span></div><pre>${body}</pre></div>`;
}

let shot = 0;
async function screenshotTerminal(name, title, transcript) {
  const lines = transcript.split("\n");
  const rows = lines.reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(visibleLength(line) / 118)),
    0,
  );
  const height = rows * 20 + 150;
  const dir = await mkdtemp(join(tmpdir(), "df-shot-"));
  const page = join(dir, "terminal.html");
  await writeFile(page, terminalPage(title, ansiToHtml(transcript)), "utf8");
  await mkdir(images, { recursive: true });
  const out = join(images, name);
  await chrome([
    `--window-size=1100,${height}`,
    "--force-device-scale-factor=2",
    `--screenshot=${out}`,
    pathToFileURL(page).href,
  ]);
  await rm(dir, { recursive: true, force: true });
  console.log(`  ${++shot}. ${name}`);
}

// ------------------------------------------------------------------------------------------------
// A scratch project, driven through the real CLI
// ------------------------------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const work = await mkdtemp(join(tmpdir(), "df-screens-"));
const project = join(work, "mycoolapp");
const keyDir = join(work, "keys");
const usbDir = join(work, "usb", "keys");
await mkdir(project, { recursive: true });

const SHOWN_KEYS = "~/.config/developer-footprint/keys";
const SHOWN_USB = "/media/sarah/USB/keys";
const emptyKeys = join(work, "laptop-config", "keys");
const SUBSTITUTIONS = [
  [keyDir, SHOWN_KEYS],
  [emptyKeys, SHOWN_KEYS],
  [usbDir, SHOWN_USB],
];
const tidy = (text) => {
  let shown = text;
  for (const [real, display] of SUBSTITUTIONS) {
    shown = shown
      .replaceAll(`${real}\\`, `${display}/`)
      .replaceAll(`${real}/`, `${display}/`)
      .replaceAll(real, display);
  }
  // Display only: show POSIX separators on the "wrote <path>" lines (the CLI prints native ones).
  return shown
    .split("\n")
    .map((line) => (line.includes("wrote") ? line.replaceAll("\\", "/") : line))
    .join("\n");
};

/** One shell session: a fixed clock, seeded randomness, real files, colour on. */
function session({ cwd = project, answers, env = {}, badgeBundlePath } = {}) {
  const random = mulberry32(2026);
  const random10 = (length) => Uint8Array.from({ length }, () => Math.floor(random() * 256));
  let out = "";
  const write = (text) => void (out += text);
  const ctx = {
    version: "0.1.0",
    nodeVersion: process.versions.node,
    cwd,
    env,
    platform: process.platform,
    homedir: work,
    stdout: write,
    stderr: write,
    prompter:
      answers === undefined
        ? undefined
        : {
            ask: async (question) => {
              write(question);
              const answer = answers.shift();
              write(`${ESC}[36m${ESC}[1m${answer}${ESC}[22m${ESC}[39m\n`);
              return answer;
            },
          },
    color: true,
    now: () => new Date("2026-09-24T09:30:00Z"),
    randomBytes: random10,
    ...(badgeBundlePath === undefined ? {} : { badgeBundlePath }),
  };
  return {
    /** Runs `developer-footprint <args>`, appending a prompt line and the real output. */
    async exec(args, shown = args.join(" ")) {
      write(`${ESC}[32m$${ESC}[39m ${ESC}[1mdeveloper-footprint ${shown}${ESC}[22m\n`);
      const code = await run(args, ctx);
      return code;
    },
    text: () => out,
    reset: () => void (out = ""),
  };
}

console.log("Terminal screenshots (real CLI output):");

// 1. init, interactive
{
  const s = session({
    answers: [
      "person",
      "Sarah",
      "https://sarah.example",
      "https://github.com/sarah",
      "",
      "MyCoolApp",
      "https://mycoolapp.example",
      "https://github.com/sarah/mycoolapp",
      "creator",
    ],
  });
  await s.exec(["init"], "init");
  await screenshotTerminal("cli-init.png", "~/projects/mycoolapp", tidy(s.text()));
}

// 2. keygen
{
  const s = session();
  await s.exec(["keygen", "--key-dir", keyDir], "keygen");
  await screenshotTerminal("cli-keygen.png", "~/projects/mycoolapp", tidy(s.text()));
}

// 3. sign
{
  const s = session();
  await s.exec(["sign", "--key-dir", keyDir], "sign");
  await screenshotTerminal("cli-sign.png", "~/projects/mycoolapp", tidy(s.text()));
}

// 4. verify
{
  const s = session();
  await s.exec(["verify"]);
  await screenshotTerminal("cli-verify.png", "~/projects/mycoolapp", tidy(s.text()));
}

// 5. validate + doctor
{
  const s = session();
  await s.exec(["validate"]);
  await screenshotTerminal("cli-validate.png", "~/projects/mycoolapp", tidy(s.text()));
  const d = session({ env: { DEVELOPER_FOOTPRINT_KEY_DIR: keyDir } });
  await d.exec(["doctor"]);
  await screenshotTerminal("cli-doctor.png", "~/projects/mycoolapp", tidy(d.text()));
}

// 6. export static files for a website
{
  const s = session({
    badgeBundlePath: join(root, "packages", "web", "dist", "browser", "badge.js"),
  });
  await writeFile(join(project, "index.html"), "<!doctype html><title>MyCoolApp</title>\n", "utf8");
  await s.exec(["export", "--badge"]);
  await screenshotTerminal("cli-export.png", "~/projects/mycoolapp", tidy(s.text()));
}

// 7. tampering is caught
{
  const path = join(project, ".developer-footprint", "footprint.json");
  const { readFile } = await import("node:fs/promises");
  const original = await readFile(path, "utf8");
  const footprint = JSON.parse(original);
  footprint.contributors[0].role = "owner";
  await writeFile(path, JSON.stringify(footprint, null, 2));
  const s = session();
  s.reset();
  await s.exec(["verify"]);
  await screenshotTerminal(
    "cli-verify-tampered.png",
    "~/projects/mycoolapp  (creator quietly changed to owner)",
    tidy(s.text()),
  );
  await writeFile(path, original);
}

// 8. no PC of your own: the key lives on a USB stick, not on the laptop you are borrowing
{
  const borrowed = join(work, "borrowed-laptop", "mycoolapp");
  await mkdir(borrowed, { recursive: true });
  const env = { DEVELOPER_FOOTPRINT_KEY_DIR: emptyKeys };
  const a = session({
    cwd: borrowed,
    env,
    answers: [
      "person",
      "Sarah",
      "https://sarah.example",
      "",
      "",
      "MyCoolApp",
      "https://mycoolapp.example",
      "",
      "creator",
    ],
  });
  await a.exec(["init"], "init");
  a.reset();
  await a.exec(["keygen", "--key-dir", usbDir], "keygen --key-dir /media/sarah/USB/keys");
  await screenshotTerminal(
    "cli-portable-key.png",
    "borrowed laptop: the private key goes to the USB stick, not the laptop",
    tidy(a.text()),
  );

  // Later, on any other computer: the key is not there until the USB stick is plugged in.
  const b = session({ cwd: borrowed, env });
  await b.exec(["sign"], "sign");
  await b.exec(["sign", "--key-dir", usbDir], "sign --key-dir /media/sarah/USB/keys");
  await screenshotTerminal(
    "cli-portable-sign.png",
    "another computer: sign with the USB stick plugged in",
    tidy(b.text()),
  );

  // Just need an identifier right now? Works anywhere, offline.
  const c = session({ cwd: borrowed, env });
  await c.exec(["id", "identity"], "id identity");
  await c.exec(["id", "key", "--count", "2"], "id key --count 2");
  await screenshotTerminal(
    "cli-id.png",
    "any computer with Node.js: no account, no network",
    tidy(c.text()),
  );
}

// ------------------------------------------------------------------------------------------------
// Web screenshots: the real example site in real Chrome
// ------------------------------------------------------------------------------------------------
console.log("Browser screenshots (plain HTML example):");
const badge = join(root, "examples", "plain-html", "developer-footprint", "badge.js");
if (!existsSync(badge)) {
  console.error("  examples/plain-html is not synced. Run: node tooling/sync-example.mjs");
  process.exit(1);
}
const { server, port } = await startStaticServer(join(root, "examples", "plain-html"), 0);

/**
 * Drives Chrome over the DevTools protocol (Node's built-in WebSocket): emulate the visitor's
 * colour scheme, load the page, wait until the badge has finished, then capture. Far more
 * reliable than command-line flags, which headless Chrome may ignore.
 */
async function withPage(fn) {
  const profileDir = await mkdtemp(join(tmpdir(), "df-chrome-"));
  const child = spawn(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  try {
    let endpoint;
    for (let attempt = 0; attempt < 100 && endpoint === undefined; attempt++) {
      try {
        const [portLine, pathLine] = (
          await readFile(join(profileDir, "DevToolsActivePort"), "utf8")
        ).split("\n");
        endpoint = `ws://127.0.0.1:${portLine}${pathLine}`;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (endpoint === undefined) throw new Error("Chrome did not start its DevTools endpoint");

    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let nextId = 0;
    const pending = new Map();
    const listeners = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const handler = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) handler.reject(new Error(message.error.message));
        else handler.resolve(message.result);
      } else {
        for (const listener of listeners) listener(message);
      }
    });
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(
          JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }),
        );
      });

    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const page = {
      send: (method, params) => send(method, params, sessionId),
      once: (name) =>
        new Promise((resolve) => {
          const listener = (message) => {
            if (message.sessionId === sessionId && message.method === name) {
              listeners.splice(listeners.indexOf(listener), 1);
              resolve(message.params);
            }
          };
          listeners.push(listener);
        }),
    };
    try {
      return await fn(page);
    } finally {
      socket.close();
    }
  } finally {
    child.kill();
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function screenshotPage(name, path, scheme) {
  await withPage(async (page) => {
    await page.send("Page.enable");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1000,
      height: 700,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme }],
    });
    const loaded = page.once("Page.loadEventFired");
    await page.send("Page.navigate", { url: `http://127.0.0.1:${port}${path}` });
    await loaded;
    // Wait for the badge itself, not for a fixed delay.
    for (let attempt = 0; attempt < 100; attempt++) {
      const { result } = await page.send("Runtime.evaluate", {
        expression: 'document.querySelector("developer-footprint-badge")?.dataset.state ?? "none"',
        returnByValue: true,
      });
      if (result.value !== "loading" && result.value !== "none") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 250)); // let it paint
    const { data } = await page.send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(images, name), Buffer.from(data, "base64"));
  });
  console.log(`  ${++shot}. ${name}`);
}

await screenshotPage("web-badge-verified.png", "/index.html", "light");
await screenshotPage("web-badge-verified-dark.png", "/index.html", "dark");
await screenshotPage("web-badge-tampered.png", "/tampered.html", "light");
server.close();

await rm(work, { recursive: true, force: true });
console.log(`\nWrote ${shot} images to docs/images/`);
