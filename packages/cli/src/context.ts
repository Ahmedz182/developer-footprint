/** Asks the person at the terminal a question. Absent when input is not interactive. */
export interface Prompter {
  ask(question: string): Promise<string>;
}

/**
 * Everything the CLI needs from its environment, injected so commands are plain functions of
 * (arguments, context) and can be tested in-process without touching the real terminal.
 */
export interface Context {
  readonly version: string;
  readonly nodeVersion: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly prompter: Prompter | undefined;
  readonly color: boolean;
  readonly now: () => Date;
  /** Path of the self-contained browser badge script, copied by `export --badge`. */
  readonly badgeBundlePath?: string;
  /** Randomness override for deterministic tests; production uses the platform CSPRNG. */
  readonly randomBytes?: (length: number) => Uint8Array;
}

/**
 * An expected failure with an exit code:
 *   1 = the documents were checked and are not valid
 *   2 = the command could not run (bad arguments, missing or unreadable files)
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 = 2,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}
