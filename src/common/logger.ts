/**
 * Shared chalk-based theme, symbols, and the simple `log` object used by every
 * `do-*` script for one-shot status messages (info/success/error/warning/step/blank).
 *
 * Streaming subprocess output uses {@link OutputWindow} from `./output-window.ts`.
 */

import chalk from 'chalk';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
export type LogFn = (message: string) => void;

export interface Logger {
  readonly info: LogFn;
  readonly success: LogFn;
  readonly error: LogFn;
  readonly warning: LogFn;
  readonly step: LogFn;
  readonly blank: () => void;
}

export interface Theme {
  readonly success: typeof chalk.green;
  readonly error: typeof chalk.red;
  readonly warning: typeof chalk.yellow;
  readonly info: typeof chalk.blue;
  readonly dim: typeof chalk.dim;
  readonly bold: typeof chalk.bold;
  readonly highlight: typeof chalk.cyan;
}

export interface Symbols {
  readonly success: string;
  readonly error: string;
  readonly warning: string;
  readonly info: string;
  readonly arrow: string;
  readonly bullet: string;
}

// ─────────────────────────────────────────────────────────────
// Theme & Symbols
// ─────────────────────────────────────────────────────────────
/** Chalk color helpers grouped by semantic role. */
export const theme: Theme = {
  success: chalk.green,
  error: chalk.red,
  warning: chalk.yellow,
  info: chalk.blue,
  dim: chalk.dim,
  bold: chalk.bold,
  highlight: chalk.cyan,
};

/** Pre-colored single-character glyphs used as line prefixes by the logger. */
export const symbols: Symbols = {
  success: chalk.green('✔'),
  error: chalk.red('✖'),
  warning: chalk.yellow('⚠'),
  info: chalk.blue('ℹ'),
  arrow: chalk.dim('→'),
  bullet: chalk.dim('│'),
};

// ─────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────
/** One-shot console logger with consistent prefixes/colors across all scripts. */
export const log: Logger = {
  info: (message) => console.log(`${symbols.info} ${message}`),
  success: (message) => console.log(`${symbols.success} ${theme.success(message)}`),
  error: (message) => console.error(`${symbols.error} ${theme.error(message)}`),
  warning: (message) => console.log(`${symbols.warning} ${theme.warning(message)}`),
  step: (message) => console.log(`${symbols.arrow} ${message}`),
  blank: () => console.log(),
};
