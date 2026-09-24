import type { Result } from "../errors/result.js";
import { normalizeUrlField } from "../identity/create.js";
import { generateId, type IdOptions } from "../ids/ids.js";
import { normalizeText } from "../internal/text.js";
import { formatTimestamp } from "../internal/timestamp.js";
import { SPEC_VERSION, type Footprint, type Identity, type Role } from "../types/index.js";
import { wellKnownUrlFor } from "../url/url.js";
import { validateFootprint } from "./validate.js";

export interface CreateFootprintInput {
  readonly project: {
    readonly name: string;
    readonly description?: string;
    readonly url?: string;
    readonly repository?: string;
    readonly version?: string;
    /** Supply to keep a project's id stable across footprints; otherwise one is generated. */
    readonly id?: string;
  };
  /**
   * Every attribution is explicit: there is deliberately no default role, so creating a
   * footprint can never silently assert that someone created or owns a project.
   */
  readonly contributors: readonly {
    /** An identity document, or the URL of one (`https://…/.well-known/developer-footprint.json`). */
    readonly identity: Identity | string;
    readonly role: Role;
  }[];
  readonly id?: string;
  readonly supersedes?: string;
}

/**
 * Builds a valid, unsigned footprint from user-supplied values, applying the protocol's
 * normalization. Nothing is signed or published.
 */
export function createFootprint(
  input: CreateFootprintInput,
  options: IdOptions = {},
): Result<Footprint> {
  const project: Record<string, string> = {
    id: input.project.id ?? generateId("project", options),
    name: normalizeText(input.project.name),
  };
  if (input.project.description !== undefined) {
    project["description"] = normalizeText(input.project.description);
  }
  if (input.project.version !== undefined) project["version"] = input.project.version.trim();
  for (const field of ["url", "repository"] as const) {
    const value = input.project[field];
    if (value === undefined) continue;
    const normalized = normalizeUrlField(`project/${field}`, value);
    if (!normalized.ok) return normalized;
    project[field] = normalized.value;
  }

  const contributors: { identity: string; role: Role }[] = [];
  for (const [index, contributor] of input.contributors.entries()) {
    const location =
      typeof contributor.identity === "string"
        ? normalizeUrlField(`contributors/${index}/identity`, contributor.identity)
        : wellKnownUrlFor(contributor.identity.canonicalUrl);
    if (!location.ok) return location;
    contributors.push({ identity: location.value, role: contributor.role });
  }

  return validateFootprint({
    specVersion: SPEC_VERSION,
    id: input.id ?? generateId("footprint", options),
    project,
    contributors,
    createdAt: formatTimestamp(options.now ?? new Date()),
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
  });
}
