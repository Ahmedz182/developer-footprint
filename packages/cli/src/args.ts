import { parseArgs, type ParseArgsConfig } from "node:util";
import { CliError } from "./context.js";

type Options = NonNullable<ParseArgsConfig["options"]>;

export interface Parsed<T extends Options> {
  readonly values: ReturnType<
    typeof parseArgs<{ options: T; strict: true; allowPositionals: true }>
  >["values"];
  readonly positionals: string[];
}

/** Strict argument parsing: unknown flags are usage errors, never silently ignored. */
export function parseCommandArgs<T extends Options>(
  argv: readonly string[],
  options: T,
): Parsed<T> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options,
      strict: true,
      allowPositionals: true,
    });
    return { values, positionals };
  } catch (error) {
    throw new CliError(
      (error as Error).message,
      2,
      "Run with --help to see the available options.",
    );
  }
}

/** Options every command that touches a project accepts. */
export const PROJECT_OPTIONS = {
  dir: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const satisfies Options;
