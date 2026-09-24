/**
 * Characters that never belong in display text: controls (terminal-escape and log injection),
 * line/paragraph separators, zero-width and bidirectional formatting characters (spoofing,
 * "Trojan Source"), invisible tag characters, and the byte-order mark.
 */
const FORBIDDEN_TEXT =
  /[\p{Cc}\p{Zl}\p{Zp}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{206f}\u{feff}\u{E0000}-\u{E007F}]/u;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function hasLoneSurrogate(value: string): boolean {
  return LONE_SURROGATE.test(value);
}

export function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count++;
  return count;
}

/** Canonical display-text form used by the factories: NFC, no leading/trailing whitespace. */
export function normalizeText(value: string): string {
  return value.normalize("NFC").trim();
}

/**
 * Returns a description of the first problem with `value` as protocol display text, or
 * `undefined` if it is acceptable. Display text is plain text: it is never HTML or Markdown and
 * consumers must escape it for whatever context they render it in.
 */
export function describeTextProblem(value: string, maxCodePoints: number): string | undefined {
  if (value.length === 0) return "must not be empty";
  if (value.length > maxCodePoints * 2) return `must be at most ${maxCodePoints} characters`;
  if (hasLoneSurrogate(value)) return "must be well-formed Unicode";
  if (codePointLength(value) > maxCodePoints) return `must be at most ${maxCodePoints} characters`;
  if (value !== value.normalize("NFC")) return "must be in Unicode Normalization Form C";
  if (value !== value.trim()) return "must not start or end with whitespace";
  if (FORBIDDEN_TEXT.test(value)) {
    return "must not contain control, invisible or bidirectional formatting characters";
  }
  return undefined;
}
