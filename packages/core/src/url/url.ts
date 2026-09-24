import { err, ok, type Result } from "../errors/result.js";
import { LIMITS, WELL_KNOWN_PATH } from "../limits.js";

/** DNS suffixes that only make sense on private networks. Rejected everywhere in V1. */
const PRIVATE_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "lan",
  "home.arpa",
];

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Checks a hostname *as serialized by the WHATWG URL parser* (lower-case, IDNA-to-ASCII, IPv4
 * shorthand already expanded to dotted quads). Returns a problem description or `undefined`.
 *
 * This is a syntactic screen, not SSRF protection: a public-looking name can still resolve to
 * a private address. Remote resolution needs its own defenses (SPEC.md §14.3).
 */
function describeHostProblem(hostname: string): string | undefined {
  if (hostname.startsWith("[")) return "must be a DNS name, not an IP address";
  if (IPV4.test(hostname)) return "must be a DNS name, not an IP address";
  if (hostname.endsWith(".")) return "must not end with a dot";
  if (hostname.length > 253) return "host name is too long";
  const labels = hostname.split(".");
  if (labels.length < 2) return "must be a fully qualified public DNS name";
  if (!labels.every((label) => DNS_LABEL.test(label))) {
    return "host name contains characters that are not valid in a public DNS name";
  }
  if (PRIVATE_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) {
    return "must be a public DNS name, not a local or internal one";
  }
  return undefined;
}

type Analysis =
  | { readonly ok: true; readonly normalized: string }
  | { readonly ok: false; readonly problem: string };

function analyze(input: string): Analysis {
  if (input.length === 0) return { ok: false, problem: "must not be empty" };
  if (input.length > LIMITS.maxUrlLength) {
    return { ok: false, problem: `must be at most ${LIMITS.maxUrlLength} characters` };
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, problem: "must be an absolute URL" };
  }
  if (url.protocol !== "https:") return { ok: false, problem: "must use the https scheme" };
  if (url.username !== "" || url.password !== "") {
    return { ok: false, problem: "must not contain credentials" };
  }
  if (input.includes("?") || input.includes("#")) {
    return { ok: false, problem: "must not contain a query or fragment" };
  }
  if (url.port !== "") return { ok: false, problem: "must not specify a port" };
  const hostProblem = describeHostProblem(url.hostname);
  if (hostProblem !== undefined) return { ok: false, problem: hostProblem };
  return { ok: true, normalized: `https://${url.hostname}${url.pathname}` };
}

/**
 * Turns user-supplied text into the protocol's normalized URL form, or explains why it cannot be
 * used. Normalization is the WHATWG URL serialization of an `https` URL with no credentials,
 * port, query or fragment: lower-case host, IDNs in Punycode, dot-segments resolved, and `/` for
 * an empty path. Use this at the edges (CLI prompts, factories); validators require the result.
 */
export function normalizeUrl(input: string): Result<string> {
  const analysis = analyze(input.trim());
  return analysis.ok ? ok(analysis.normalized) : err("INVALID_SCHEMA", `URL ${analysis.problem}`);
}

/**
 * Returns a description of why `value` is not a valid normalized protocol URL, or `undefined`.
 * Validators do not repair input: a URL that differs from its normal form is rejected so that
 * one document has exactly one signed byte sequence.
 */
export function describeUrlProblem(
  value: string,
): { code: "invalid_url" | "not_normalized"; message: string } | undefined {
  const analysis = analyze(value);
  if (!analysis.ok) return { code: "invalid_url", message: `URL ${analysis.problem}` };
  if (analysis.normalized !== value) {
    return { code: "not_normalized", message: `URL is not normalized; use ${analysis.normalized}` };
  }
  return undefined;
}

/** True if `value` is the identity-document URL of some origin (SPEC.md §12). */
export function isIdentityDocumentUrl(value: string): boolean {
  return describeUrlProblem(value) === undefined && new URL(value).pathname === WELL_KNOWN_PATH;
}

/** The identity-document URL for an identity whose canonical website is `canonicalUrl`. */
export function wellKnownUrlFor(canonicalUrl: string): Result<string> {
  const problem = describeUrlProblem(canonicalUrl);
  if (problem !== undefined) return err("INVALID_SCHEMA", problem.message);
  return ok(`https://${new URL(canonicalUrl).host}${WELL_KNOWN_PATH}`);
}
