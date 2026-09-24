#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { run } from "./cli.js";
import { CliError, type Context, type Prompter } from "./context.js";

function readVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return manifest.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** The badge script ships in @developer-footprint/web; absent only in unusual installs. */
function findBadgeBundle(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve("@developer-footprint/web/browser");
  } catch {
    return undefined;
  }
}

const interactive = process.stdin.isTTY && process.stdout.isTTY;
const forceColor = process.env["FORCE_COLOR"] !== undefined && process.env["FORCE_COLOR"] !== "0";
const color =
  forceColor ||
  (process.stdout.isTTY && process.env["NO_COLOR"] === undefined && process.env["TERM"] !== "dumb");

let prompter: Prompter | undefined;
const readline = interactive
  ? createInterface({ input: process.stdin, output: process.stdout })
  : undefined;
if (readline !== undefined) {
  const closed = new Promise<never>((_, reject) => {
    readline.once("close", () =>
      reject(new CliError("input ended before all questions were answered", 2)),
    );
  });
  closed.catch(() => undefined); // surfaced through the race below
  prompter = { ask: (question) => Promise.race([readline.question(question), closed]) };
}

const context: Context = {
  version: readVersion(),
  nodeVersion: process.versions.node,
  cwd: process.cwd(),
  env: process.env,
  platform: process.platform,
  homedir: homedir(),
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  prompter,
  ...(findBadgeBundle() === undefined ? {} : { badgeBundlePath: findBadgeBundle() as string }),
  color: Boolean(color),
  now: () => new Date(),
};

const code = await run(process.argv.slice(2), context);
readline?.close();
process.exitCode = code;
