/**
 * Renders styled usage banners with consistent formatting across `do-*` scripts.
 */

import { log, theme } from './logger';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
export interface UsageExample {
  readonly command: string;
  /** Optional dim trailing comment (e.g. "# chain: a→b, then b→c"). */
  readonly comment?: string;
}

export interface UsageSpec {
  /** Bold heading shown at the top of the banner. */
  readonly title: string;
  /** Short description rendered in dim text under the title. */
  readonly description: string;
  /** Single-line usage signature (e.g. "doconnect <a> <b> [c...]"). */
  readonly usage: string;
  /** Optional list of example invocations. */
  readonly examples?: readonly UsageExample[];
  /** Optional numbered list of "this will:" steps. */
  readonly steps?: readonly string[];
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────
/** Prints a styled usage banner described by `spec` to stdout. */
export const printUsage = (spec: UsageSpec): void => {
  log.blank();
  console.log(theme.bold(`  ${spec.title}`));
  console.log(theme.dim(`  ${spec.description}\n`));

  console.log(theme.dim('  Usage:'));
  console.log(`    ${theme.highlight(spec.usage)}\n`);

  if (spec.examples && spec.examples.length > 0) {
    console.log(theme.dim('  Examples:'));
    for (const example of spec.examples) {
      const comment = example.comment ? `  ${theme.dim(example.comment)}` : '';
      console.log(`    ${theme.highlight(example.command)}${comment}`);
    }
    console.log();
  }

  if (spec.steps && spec.steps.length > 0) {
    console.log(theme.dim('  This will:'));
    spec.steps.forEach((step, index) => {
      console.log(`    ${theme.dim(`${index + 1}.`)} ${step}`);
    });
  }

  log.blank();
};
