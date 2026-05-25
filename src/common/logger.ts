/**
 * Shared chalk-based theme, symbols, and the simple `log` object used by every
 * `do-*` script for one-shot status messages (info/success/error/warning/step/blank).
 *
 * Streaming subprocess output uses {@link OutputWindow} from `./output-window.ts`.
 */

import chalk from 'chalk';
import { getActiveRun } from './tui/index';
import { formatForConsole } from './tui/format';

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
  success: chalk.green('✓'),
  error: chalk.red('✗'),
  warning: chalk.yellow('▲'),
  info: chalk.blue('ℹ'),
  arrow: chalk.dim('→'),
  bullet: chalk.dim('│'),
};

// ─────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────
/**
 * One-shot logger. When a full-screen run is active it records lines into the
 * dashboard; otherwise it falls back to consistent console output. `blank` is
 * a no-op under the dashboard (which manages its own layout).
 */
export const log: Logger = {
  info: (message) => {
    const run = getActiveRun();
    if (run) run.store.log('info', message);
    else console.log(`${symbols.info} ${formatForConsole(message)}`);
  },
  success: (message) => {
    const run = getActiveRun();
    if (run) run.store.log('success', message);
    else console.log(`${symbols.success} ${theme.success(formatForConsole(message))}`);
  },
  error: (message) => {
    const run = getActiveRun();
    if (run) run.store.log('error', message);
    else console.error(`${symbols.error} ${theme.error(formatForConsole(message))}`);
  },
  warning: (message) => {
    const run = getActiveRun();
    if (run) run.store.log('warning', message);
    else console.log(`${symbols.warning} ${theme.warning(formatForConsole(message))}`);
  },
  step: (message) => {
    const run = getActiveRun();
    if (run) run.store.log('step', message);
    else console.log(`${symbols.arrow} ${formatForConsole(message)}`);
  },
  blank: () => {
    if (!getActiveRun()) console.log();
  },
};
