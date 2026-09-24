import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";
import type { Context } from "../src/context.js";

export interface HarnessOptions {
  readonly cwd: string;
  /** Scripted answers to interactive prompts. Omit for a non-interactive session. */
  readonly answers?: string[];
  readonly env?: Record<string, string>;
  readonly now?: string;
  readonly home?: string;
  /** Different seeds give different (still deterministic) ids and keys. */
  readonly randomSeed?: number;
}

/** Deterministic, non-repeating byte source: every call yields different bytes. */
function counterRandom(seed: number): (length: number) => Uint8Array {
  let counter = seed * 1000;
  return (length) => {
    counter++;
    return Uint8Array.from({ length }, (_, i) => (counter * 37 + i * 11 + 5) & 0xff);
  };
}

export function harness(options: HarnessOptions) {
  const out: string[] = [];
  const err: string[] = [];
  const answers = options.answers;
  const context: Context = {
    version: "0.0.0-test",
    nodeVersion: process.versions.node,
    cwd: options.cwd,
    env: options.env ?? {},
    platform: process.platform,
    homedir: options.home ?? join(options.cwd, "home"),
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    prompter:
      answers === undefined
        ? undefined
        : {
            ask: (question) => {
              out.push(question);
              const answer = answers.shift();
              if (answer === undefined) throw new Error(`no scripted answer for: ${question}`);
              out.push(`${answer}\n`);
              return Promise.resolve(answer);
            },
          },
    color: false,
    now: () => new Date(options.now ?? "2026-09-24T12:00:00Z"),
    randomBytes: counterRandom(options.randomSeed ?? 0),
  };
  return {
    context,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    run: (argv: string[]) => run(argv, context),
  };
}

export async function tempDir(
  prefix = "df-cli-",
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

/** Flags for a complete non-interactive `init`. */
export function initFlags(overrides: Record<string, string> = {}): string[] {
  const flags: Record<string, string> = {
    type: "person",
    name: "Sarah",
    url: "https://sarah.example",
    github: "https://github.com/sarah",
    "project-name": "MyCoolApp",
    "project-url": "https://mycoolapp.example",
    repository: "https://github.com/sarah/mycoolapp",
    role: "creator",
    ...overrides,
  };
  return ["init", ...Object.entries(flags).flatMap(([key, value]) => [`--${key}`, value])];
}
