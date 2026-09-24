import type { Result } from "../errors/result.js";
import { LIMITS } from "../limits.js";
import type { Project } from "../types/index.js";
import { readId, readRecord, readString, readText, readUrl } from "../validation/fields.js";
import { runValidation, type Validation } from "../validation/validation.js";

/** Version labels: semver-shaped but deliberately not semver-only (calendar versions etc.). */
const VERSION = new RegExp(`^[0-9A-Za-z][0-9A-Za-z.+_-]{0,${LIMITS.maxVersionLength - 1}}$`);

/** Validates a project object at `path`; shared by the standalone and embedded forms. */
export function validateProjectAt(
  v: Validation,
  value: unknown,
  path: string,
): Project | undefined {
  const record = readRecord(v, value, path, {
    required: ["id", "name"],
    optional: ["description", "url", "repository", "version"],
  });
  if (record === undefined) return undefined;

  const id = readId(v, record, "id", path, "project");
  const name = readText(v, record, "name", path, LIMITS.maxNameCodePoints);
  const description = readText(v, record, "description", path, LIMITS.maxDescriptionCodePoints);
  const url = readUrl(v, record, "url", path);
  const repository = readUrl(v, record, "repository", path);
  const version = readString(v, record, "version", path, (candidate) =>
    VERSION.test(candidate)
      ? undefined
      : { code: "invalid_value", message: "must be a short version label such as 1.4.2" },
  );

  if (id === undefined || name === undefined) return undefined;
  return {
    id,
    name,
    ...(description === undefined ? {} : { description }),
    ...(url === undefined ? {} : { url }),
    ...(repository === undefined ? {} : { repository }),
    ...(version === undefined ? {} : { version }),
  };
}

/** Validates a project object (SPEC.md §5). Returns a fresh copy of the known fields. */
export function validateProject(input: unknown): Result<Project> {
  return runValidation((v) => validateProjectAt(v, input, ""));
}
