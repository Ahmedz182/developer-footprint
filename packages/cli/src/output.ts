const ESC = String.fromCharCode(27);

export interface Styler {
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
}

function wrap(open: number, close: number, enabled: boolean): (text: string) => string {
  return enabled ? (text) => `${ESC}[${open}m${text}${ESC}[${close}m` : (text) => text;
}

/** ANSI styling that degrades to plain text (files, pipes, NO_COLOR, CI logs). */
export function createStyler(enabled: boolean): Styler {
  return {
    bold: wrap(1, 22, enabled),
    dim: wrap(2, 22, enabled),
    green: wrap(32, 39, enabled),
    red: wrap(31, 39, enabled),
    yellow: wrap(33, 39, enabled),
    cyan: wrap(36, 39, enabled),
  };
}

export const SYMBOLS = {
  pass: "✓",
  fail: "✗",
  skip: "–",
  warn: "!",
} as const;

/** Shortens a long identifier for display while keeping both ends recognizable. */
export function abbreviate(value: string, keep = 14): string {
  return value.length <= keep * 2 + 1 ? value : `${value.slice(0, keep)}…${value.slice(-6)}`;
}
