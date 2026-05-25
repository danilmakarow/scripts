/**
 * Lightweight inline "code" formatting for log messages and step labels.
 *
 * Wrap dynamic values (branch names, paths, ids…) with {@link code} or the
 * {@link fmt} tagged template; they render in a distinct color both in the live
 * dashboard (via the `<Formatted>` component) and in the released report.
 * Marked spans use sentinel chars that never reach the terminal — every render
 * path strips or styles them first.
 */

import chalk from 'chalk';

// Sentinels (NUL / SOH) — these don't occur in normal CLI text.
const OPEN = String.fromCharCode(0);
const CLOSE = String.fromCharCode(1);

/** Marks a value as dynamic "code" so it renders highlighted. */
export const code = (value: unknown): string => `${OPEN}${String(value)}${CLOSE}`;

/** Tagged template: every interpolated value is highlighted as code. */
export const fmt = (
  strings: TemplateStringsArray,
  ...values: unknown[]
): string =>
  strings.reduce(
    (acc, part, index) =>
      acc + part + (index < values.length ? code(values[index]) : ''),
    '',
  );

export interface FormatSegment {
  readonly text: string;
  readonly code: boolean;
}

/** Strips all formatting sentinels, returning the plain text. */
export const stripFormatting = (input: string): string =>
  input.split(OPEN).join('').split(CLOSE).join('');

/**
 * Splits a (possibly marked) string into plain/code segments for rendering.
 * Residual sentinels inside a segment (e.g. from nesting `code()` in `fmt`) are
 * stripped so they never reach the terminal.
 */
export const splitFormatted = (input: string): FormatSegment[] => {
  if (!input.includes(OPEN)) return [{ text: input, code: false }];

  const segments: FormatSegment[] = [];
  let rest = input;
  while (rest.length > 0) {
    const open = rest.indexOf(OPEN);
    if (open === -1) {
      segments.push({ text: stripFormatting(rest), code: false });
      break;
    }
    if (open > 0) segments.push({ text: stripFormatting(rest.slice(0, open)), code: false });
    const close = rest.indexOf(CLOSE, open + 1);
    if (close === -1) {
      // Unbalanced — treat the remainder as plain (sentinels stripped).
      segments.push({ text: stripFormatting(rest.slice(open + 1)), code: false });
      break;
    }
    segments.push({ text: stripFormatting(rest.slice(open + 1, close)), code: true });
    rest = rest.slice(close + 1);
  }
  return segments;
};

/** Renders a (possibly marked) string for plain console output, with code
 * spans highlighted via chalk. Used by the report and non-TTY fallbacks. */
export const formatForConsole = (input: string): string =>
  splitFormatted(input)
    .map((segment) => (segment.code ? chalk.cyan(segment.text) : segment.text))
    .join('');
