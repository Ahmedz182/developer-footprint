import { err, ok, type Issue, type IssueCode, type Result } from "../errors/result.js";

/** Collects every problem in a document rather than stopping at the first. */
export class Validation {
  readonly issues: Issue[] = [];
  /** Set when a document declares a well-formed `specVersion` this implementation lacks. */
  unsupportedVersion: string | undefined;

  add(path: string, code: IssueCode, message: string): void {
    this.issues.push({ path, code, message });
  }
}

/** RFC 6901 JSON Pointer child of `parent`. */
export function pointer(parent: string, segment: string | number): string {
  return `${parent}/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function summarize(issues: readonly Issue[]): string {
  const shown = issues
    .slice(0, 3)
    .map((issue) => `${issue.path === "" ? "(document)" : issue.path}: ${issue.message}`);
  const more = issues.length > shown.length ? ` (+${issues.length - shown.length} more)` : "";
  return `${issues.length} problem${issues.length === 1 ? "" : "s"}: ${shown.join("; ")}${more}`;
}

/**
 * Runs `build` and converts its outcome to a {@link Result}. Untrusted input can carry hostile
 * getters or proxies that throw; that must surface as a validation failure, never as an
 * exception escaping into the caller's request handler.
 */
export function runValidation<T>(build: (validation: Validation) => T | undefined): Result<T> {
  const validation = new Validation();
  let value: T | undefined;
  try {
    value = build(validation);
  } catch {
    return err("INVALID_SCHEMA", "the document could not be read as plain data");
  }
  if (validation.unsupportedVersion !== undefined) {
    return err(
      "UNSUPPORTED_VERSION",
      `specVersion "${validation.unsupportedVersion}" is not supported (supported: "1.0")`,
    );
  }
  if (validation.issues.length > 0 || value === undefined) {
    const issues = validation.issues;
    return err("INVALID_SCHEMA", summarize(issues), issues);
  }
  return ok(value);
}
