import type { Result } from "../errors/result.js";
import { LIMITS } from "../limits.js";
import { validateProjectAt } from "../project/validate.js";
import { ROLES, SPEC_VERSION, type Contributor, type Footprint } from "../types/index.js";
import {
  readArray,
  readEnum,
  readId,
  readIdentityDocumentUrl,
  readRecord,
  readSpecVersion,
  readTimestamp,
  type Snapshot,
} from "../validation/fields.js";
import { pointer, runValidation, type Validation } from "../validation/validation.js";

function readContributors(v: Validation, snapshot: Snapshot): readonly Contributor[] | undefined {
  const items = readArray(v, snapshot, "contributors", "", { min: 1, max: LIMITS.maxContributors });
  if (items === undefined) return undefined;
  const contributors: Contributor[] = [];
  const seen = new Map<string, number>();
  items.forEach((item, index) => {
    const path = pointer("/contributors", index);
    const record = readRecord(v, item, path, { required: ["identity", "role"] });
    if (record === undefined) return;
    const identity = readIdentityDocumentUrl(v, record, "identity", path);
    const role = readEnum(v, record, "role", path, ROLES);
    if (identity === undefined || role === undefined) return;
    // The same person may hold several roles, but restating one role adds nothing and hides mistakes.
    const claim = `${identity}\n${role}`;
    if (seen.has(claim)) {
      v.add(path, "duplicate", `repeats the claim at /contributors/${seen.get(claim)}`);
      return;
    }
    seen.set(claim, index);
    contributors.push({ identity, role });
  });
  return contributors;
}

/**
 * Validates a footprint document (SPEC.md §6). Returns a fresh, normalized copy containing only
 * known fields; callers should canonicalize and sign that copy, never the raw input.
 */
export function validateFootprint(input: unknown): Result<Footprint> {
  return runValidation((v) => {
    const record = readRecord(v, input, "", {
      required: ["specVersion", "id", "project", "contributors", "createdAt"],
      optional: ["supersedes"],
    });
    if (record === undefined || !readSpecVersion(v, record, "")) return undefined;

    const id = readId(v, record, "id", "", "footprint");
    const project =
      record["project"] === undefined
        ? undefined
        : validateProjectAt(v, record["project"], "/project");
    const contributors = readContributors(v, record);
    const createdAt = readTimestamp(v, record, "createdAt", "");
    const supersedes = readId(v, record, "supersedes", "", "footprint");

    if (supersedes !== undefined && supersedes === id) {
      v.add("/supersedes", "inconsistent", "a footprint cannot supersede itself");
    }

    if (
      id === undefined ||
      project === undefined ||
      contributors === undefined ||
      createdAt === undefined
    ) {
      return undefined;
    }
    return {
      specVersion: SPEC_VERSION,
      id,
      project,
      contributors,
      createdAt,
      ...(supersedes === undefined ? {} : { supersedes }),
    };
  });
}
