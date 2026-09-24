import { CliError, type Context } from "./context.js";
import { runDoctor } from "./commands/doctor.js";
import { runExport } from "./commands/export.js";
import { runId } from "./commands/id.js";
import { runInit } from "./commands/init.js";
import { runKeygen } from "./commands/keygen.js";
import { runSign } from "./commands/sign.js";
import { runValidate } from "./commands/validate.js";
import { runVerify } from "./commands/verify.js";
import { createStyler } from "./output.js";

type Command = (argv: readonly string[], ctx: Context) => Promise<number>;

const COMMANDS: Readonly<Record<string, { run: Command; summary: string }>> = {
  init: { run: runInit, summary: "Create an identity and project footprint" },
  keygen: {
    run: runKeygen,
    summary: "Generate a signing key; add its public half to your identity",
  },
  sign: { run: runSign, summary: "Sign the footprint with your key" },
  verify: { run: runVerify, summary: "Verify a signed footprint, offline" },
  validate: { run: runValidate, summary: "Check the documents against the protocol" },
  export: {
    run: runExport,
    summary: "Write static files for a website (plain HTML or any framework)",
  },
  doctor: { run: runDoctor, summary: "Diagnose this machine and project" },
  id: { run: runId, summary: "Print a fresh identifier (works on any machine, offline)" },
};

export function helpText(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const rows = Object.entries(COMMANDS).map(
    ([name, { summary }]) => `  ${name.padEnd(width + 2)}${summary}`,
  );
  return `Developer Footprint: verifiable authorship for software projects

Usage: developer-footprint <command> [options]

Commands:
${rows.join("\n")}

Developer Footprint has no telemetry, and none of these commands touch the network.
Run \`developer-footprint <command> --help\` for details.
`;
}

/** Runs the CLI and returns the process exit code. Never throws for expected failures. */
export async function run(argv: readonly string[], ctx: Context): Promise<number> {
  const [name, ...rest] = argv;
  const s = createStyler(ctx.color);
  try {
    if (name === undefined || name === "help" || name === "--help" || name === "-h") {
      ctx.stdout(helpText());
      return name === undefined ? 2 : 0;
    }
    if (name === "--version" || name === "-v" || name === "version") {
      ctx.stdout(`${ctx.version}\n`);
      return 0;
    }
    const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
    if (command === undefined) {
      throw new CliError(
        `unknown command "${name}"`,
        2,
        "Run `developer-footprint --help` to see the commands.",
      );
    }
    return await command.run(rest, ctx);
  } catch (error) {
    if (error instanceof CliError) {
      ctx.stderr(`${s.red("error:")} ${error.message}\n`);
      if (error.hint !== undefined) ctx.stderr(`${s.dim(error.hint)}\n`);
      return error.exitCode;
    }
    // A bug, not a user error. Report the message only: stack traces and error objects can
    // carry paths and, in the worst case, secrets.
    ctx.stderr(`${s.red("unexpected error:")} ${(error as Error).message}\n`);
    return 70;
  }
}
