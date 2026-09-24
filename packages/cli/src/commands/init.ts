import { mkdir } from "node:fs/promises";
import {
  IDENTITY_TYPES,
  ROLES,
  createFootprint,
  createIdentity,
  normalizeUrl,
  validateIdentity,
  wellKnownUrlFor,
  type FootprintError,
  type Identity,
  type IdentityType,
  type Result,
  type Role,
} from "@developer-footprint/core";
import { PROJECT_OPTIONS, parseCommandArgs } from "../args.js";
import { CliError, type Context } from "../context.js";
import { createStyler } from "../output.js";
import { exists, projectPaths, requireDocument, writeDocument } from "../store.js";

export const INIT_HELP = `Usage: developer-footprint init [options]

Create a new identity and project footprint in ./.developer-footprint/. Nothing is signed,
uploaded or published. Run it interactively, or pass every value as a flag (for scripts and CI).

Identity (skip with --identity-file to reuse one you already have):
  --type <person|organization>
  --name <text>              Display name
  --url <url>                Canonical website (public https URL)
  --github <url>             Optional profile link
  --linkedin <url>           Optional profile link
  --identity-file <path>     Reuse an existing identity document instead

Project:
  --project-name <text>
  --project-url <url>        Optional
  --repository <url>         Optional
  --project-description <text>
  --project-version <label>

Attribution (there is deliberately no default role):
  --role <${ROLES.join("|")}>
                             Your role in this project
  --contributor <url>=<role> Credit someone else (repeatable). <url> is the URL of their
                             identity document, e.g. https://john.example/.well-known/developer-footprint.json

Other:
  --dir <path>               Project directory (default: current directory)
  --force                    Overwrite existing files
  -h, --help
`;

const OPTIONS = {
  ...PROJECT_OPTIONS,
  type: { type: "string" },
  name: { type: "string" },
  url: { type: "string" },
  github: { type: "string" },
  linkedin: { type: "string" },
  "identity-file": { type: "string" },
  "project-name": { type: "string" },
  "project-url": { type: "string" },
  "project-description": { type: "string" },
  "project-version": { type: "string" },
  repository: { type: "string" },
  role: { type: "string" },
  contributor: { type: "string", multiple: true },
  force: { type: "boolean" },
} as const;

const optionalSpec = { optional: true } as const;

/** Turns a core failure into a one-line, human-readable CLI error. */
function explain(error: FootprintError): string {
  const detail = (error.issues ?? []).map(
    (issue) => `${issue.path || "(document)"}: ${issue.message}`,
  );
  return detail.length > 0 ? detail.join("; ") : error.message;
}

interface FieldSpec {
  readonly flag: string | undefined;
  readonly flagName: string;
  readonly question: string;
  readonly optional?: boolean;
  /** Returns nothing if the trimmed input is fine as-is, a replacement value, or a problem. */
  readonly check: (raw: string) => Result<string> | string | undefined;
}

/**
 * Resolves one input: a flag if given (invalid flags fail immediately), otherwise a prompt that
 * re-asks until valid, otherwise (no terminal) a request to pass the flag.
 */
async function resolve(ctx: Context, spec: FieldSpec): Promise<string | undefined> {
  const validate = (raw: string): { value: string | undefined } | { problem: string } => {
    const trimmed = raw.trim();
    if (trimmed === "")
      return spec.optional === true ? { value: undefined } : { problem: "a value is required" };
    const outcome = spec.check(trimmed);
    if (outcome === undefined) return { value: trimmed };
    if (typeof outcome === "string") return { problem: outcome };
    return outcome.ok ? { value: outcome.value } : { problem: explain(outcome.error) };
  };

  if (spec.flag !== undefined) {
    const result = validate(spec.flag);
    if ("problem" in result) throw new CliError(`${spec.flagName}: ${result.problem}`, 2);
    return result.value;
  }
  if (ctx.prompter === undefined) {
    if (spec.optional === true) return undefined;
    throw new CliError(
      `missing ${spec.flagName}`,
      2,
      "Run in a terminal for prompts, or pass every value as a flag (see --help).",
    );
  }
  for (;;) {
    const answer = await ctx.prompter.ask(
      `${spec.question}${spec.optional === true ? " (optional)" : ""}: `,
    );
    const result = validate(answer);
    if (!("problem" in result)) return result.value;
    ctx.stderr(`  ${result.problem}\n`);
  }
}

const urlCheck = (raw: string): Result<string> => normalizeUrl(raw);

function parseContributor(spec: string): { identity: string; role: Role } {
  const at = spec.lastIndexOf("=");
  if (at < 1) throw new CliError(`--contributor "${spec}" must look like <identity-url>=<role>`, 2);
  const role = spec.slice(at + 1).trim();
  if (!(ROLES as readonly string[]).includes(role)) {
    throw new CliError(`--contributor role "${role}" must be one of: ${ROLES.join(", ")}`, 2);
  }
  return { identity: spec.slice(0, at).trim(), role: role as Role };
}

export async function runInit(argv: readonly string[], ctx: Context): Promise<number> {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (values.help === true) {
    ctx.stdout(INIT_HELP);
    return 0;
  }
  const paths = projectPaths(ctx, values.dir);
  const s = createStyler(ctx.color);
  const idOptions = {
    now: ctx.now(),
    ...(ctx.randomBytes === undefined ? {} : { randomBytes: ctx.randomBytes }),
  };

  if (values.force !== true) {
    for (const file of [paths.identity, paths.footprint]) {
      if (await exists(file)) {
        throw new CliError(
          `${file} already exists`,
          2,
          "Use --force to overwrite, or run in a different --dir.",
        );
      }
    }
  }

  if (ctx.prompter !== undefined) ctx.stdout(`${s.bold("Developer Footprint")}\n\n`);

  // 1. Identity: reuse one, or build a new one.
  let identity: Identity;
  if (values["identity-file"] !== undefined) {
    const existing = validateIdentity(
      await requireDocument(values["identity-file"], "identity file"),
    );
    if (!existing.ok)
      throw new CliError(`${values["identity-file"]}: ${explain(existing.error)}`, 1);
    identity = existing.value;
  } else {
    const rawType = await resolve(ctx, {
      flag: values.type,
      flagName: "--type",
      question: `Identity type (${IDENTITY_TYPES.map((t) => t.toLowerCase()).join("/")})`,
      check: (raw) =>
        IDENTITY_TYPES.some((t) => t.toLowerCase() === raw.toLowerCase())
          ? undefined
          : "choose person or organization",
    });
    const type = IDENTITY_TYPES.find(
      (t) => t.toLowerCase() === String(rawType).toLowerCase(),
    ) as IdentityType;
    const name = await resolve(ctx, {
      flag: values.name,
      flagName: "--name",
      question: type === "Person" ? "Developer name" : "Organization name",
      check: () => undefined,
    });
    const url = await resolve(ctx, {
      flag: values.url,
      flagName: "--url",
      question: "Canonical website (https://…)",
      check: urlCheck,
    });
    const github = await resolve(ctx, {
      flag: values.github,
      flagName: "--github",
      question: "GitHub profile URL",
      check: urlCheck,
      ...optionalSpec,
    });
    const linkedin = await resolve(ctx, {
      flag: values.linkedin,
      flagName: "--linkedin",
      question: "LinkedIn profile URL",
      check: urlCheck,
      ...optionalSpec,
    });
    const profiles: Record<string, string> = {};
    if (github !== undefined) profiles["github"] = github;
    if (linkedin !== undefined) profiles["linkedin"] = linkedin;

    const created = createIdentity(
      {
        type,
        name: name as string,
        canonicalUrl: url as string,
        ...(Object.keys(profiles).length > 0 ? { profiles } : {}),
      },
      idOptions,
    );
    if (!created.ok) throw new CliError(explain(created.error), 2);
    identity = created.value;
  }

  // 2. Project.
  const projectName = await resolve(ctx, {
    flag: values["project-name"],
    flagName: "--project-name",
    question: "Project name",
    check: () => undefined,
  });
  const projectUrl = await resolve(ctx, {
    flag: values["project-url"],
    flagName: "--project-url",
    question: "Project URL",
    check: urlCheck,
    ...optionalSpec,
  });
  const repository = await resolve(ctx, {
    flag: values.repository,
    flagName: "--repository",
    question: "Repository URL",
    check: urlCheck,
    ...optionalSpec,
  });
  const description = values["project-description"];
  const version = values["project-version"];

  // 3. Attribution. The role is always chosen by a person, never assumed.
  const role = await resolve(ctx, {
    flag: values.role,
    flagName: "--role",
    question: `Your role in this project (${ROLES.join("/")})`,
    check: (raw) =>
      (ROLES as readonly string[]).includes(raw) ? undefined : `choose one of: ${ROLES.join(", ")}`,
  });
  const contributors = [
    { identity, role: role as Role },
    ...(values.contributor ?? []).map(parseContributor),
  ];

  const footprint = createFootprint(
    {
      project: {
        name: projectName as string,
        ...(projectUrl === undefined ? {} : { url: projectUrl }),
        ...(repository === undefined ? {} : { repository }),
        ...(description === undefined ? {} : { description }),
        ...(version === undefined ? {} : { version }),
      },
      contributors,
    },
    idOptions,
  );
  if (!footprint.ok) throw new CliError(explain(footprint.error), 2);

  // 4. Write. Only local files; nothing leaves this machine.
  await mkdir(paths.dir, { recursive: true });
  await writeDocument(paths.identity, identity);
  await writeDocument(paths.footprint, footprint.value);

  const documentUrl = wellKnownUrlFor(identity.canonicalUrl);
  ctx.stdout(
    `\n${s.green("✓")} Created ${s.bold(".developer-footprint/identity.json")}   ${s.dim(identity.id)}\n`,
  );
  ctx.stdout(
    `${s.green("✓")} Created ${s.bold(".developer-footprint/footprint.json")}  ${s.dim(footprint.value.id)}\n\n`,
  );
  ctx.stdout(`${s.dim("Nothing was signed, uploaded or published.")}\n\nNext:\n`);
  ctx.stdout(
    `  1. ${s.cyan("developer-footprint keygen")}   create your signing key (stays on this machine)\n`,
  );
  ctx.stdout(`  2. ${s.cyan("developer-footprint sign")}     sign the footprint\n`);
  ctx.stdout(`  3. ${s.cyan("developer-footprint verify")}   check it, offline\n`);
  if (documentUrl.ok) {
    ctx.stdout(
      `\nTo let others confirm your identity, host ${s.bold("identity.json")} at:\n  ${documentUrl.value}\n`,
    );
  }
  return 0;
}
