import { generateId, type IdKind } from "@developer-footprint/core";
import { parseCommandArgs } from "../args.js";
import { CliError, type Context } from "../context.js";

export const ID_HELP = `Usage: developer-footprint id [identity|project|footprint|key] [--count <n>]

Print fresh identifiers. Ids are random ULIDs generated on this machine: there is no
registration, no account and no network, so this works on any computer with Node.js.

Options:
  --count <n>   How many to print (1-100, default 1)
  -h, --help
`;

const KINDS: readonly IdKind[] = ["identity", "project", "footprint", "key"];

/** Nothing here waits on I/O, so it is synchronous; `runId` adapts it to the command signature. */
function generateIds(argv: readonly string[], ctx: Context): number {
  const { values, positionals } = parseCommandArgs(argv, {
    count: { type: "string" },
    help: { type: "boolean", short: "h" },
  });
  if (values.help === true) {
    ctx.stdout(ID_HELP);
    return 0;
  }
  const kind = (positionals[0] ?? "identity") as IdKind;
  if (!KINDS.includes(kind) || positionals.length > 1) {
    throw new CliError(
      `unknown id kind "${positionals.join(" ")}"`,
      2,
      `Choose one of: ${KINDS.join(", ")}`,
    );
  }
  const count = values.count === undefined ? 1 : Number(values.count);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new CliError("--count must be a whole number from 1 to 100", 2);
  }
  const random = ctx.randomBytes === undefined ? {} : { randomBytes: ctx.randomBytes };
  for (let i = 0; i < count; i++)
    ctx.stdout(`${generateId(kind, { now: ctx.now(), ...random })}\n`);
  return 0;
}

export function runId(argv: readonly string[], ctx: Context): Promise<number> {
  // Errors thrown while generating surface as rejections, like every other command's.
  return Promise.resolve().then(() => generateIds(argv, ctx));
}
