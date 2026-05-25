/**
 * Public entry point for the full-screen run UI.
 *
 * `runScript` wraps a script body: in a TTY it takes over the alternate screen
 * with a live dashboard (header + elapsed timer, step checklist, streaming
 * process windows), then on completion releases the terminal and prints a
 * persistent report. Outside a TTY it falls back to the plain console behavior
 * of {@link ../logger} / {@link ../command-runner}.
 *
 * `log` and `runCommand` route to the active run automatically, so call sites
 * stay unchanged.
 */

import React from 'react';
import chalk from 'chalk';

import { Dashboard } from './components.js';
import { render, type RenderInstance } from './render.js';
import { RunStore, type RunSnapshot, type LogLevel } from './run-store.js';
import { formatForConsole } from './format.js';
import { SuggestionError } from '../errors';
import { consumeDebugFlag } from '../cli-flags';

// Glyph + chalk color per log level, for the released report.
const REPORT_LOG: Record<LogLevel, { glyph: string; color: (text: string) => string }> = {
  info: { glyph: 'ℹ', color: chalk.cyan },
  success: { glyph: '✓', color: chalk.green },
  warning: { glyph: '▲', color: chalk.yellow },
  error: { glyph: '✗', color: chalk.red },
  step: { glyph: '→', color: chalk.dim },
};

// ─────────────────────────────────────────────────────────────
// Active-run registry (read by logger.ts and command-runner.ts)
// ─────────────────────────────────────────────────────────────
interface ActiveRun {
  readonly store: RunStore;
}

let activeRun: ActiveRun | null = null;

/** The currently mounted run, or null when no dashboard is active. */
export const getActiveRun = (): ActiveRun | null => activeRun;

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
export interface RunMeta {
  /** Script name shown in the header and report (e.g. "dopull"). */
  readonly name: string;
  /** Optional one-line context (e.g. cwd / branch) under the header. */
  readonly subtitle?: string;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
/** Formats a millisecond duration as `m:ss` or `s.s`. */
const formatElapsed = (ms: number): string => {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

// ─────────────────────────────────────────────────────────────
// Report (printed to the normal buffer after the UI is released)
// ─────────────────────────────────────────────────────────────
/**
 * Prints the persistent end-of-run report below the restored prompt. The
 * finalizing `log.*` lines are only included when `showLogs` is set (the `-d`
 * flag); by default the report is the step checklist alone.
 */
const printReport = (snapshot: RunSnapshot, showLogs: boolean, error?: unknown): void => {
  const totalMs = Date.now() - snapshot.startedAt;
  const ok = snapshot.status !== 'failure' && error === undefined;
  const badge = ok ? chalk.green('✓') : chalk.red('✗');
  const headline = ok ? chalk.green('done') : chalk.red('failed');

  console.log();
  console.log(`  ${chalk.bold(snapshot.name)} ${badge} ${headline} ${chalk.dim(`in ${formatElapsed(totalMs)}`)}`);

  for (const step of snapshot.steps) {
    const duration =
      step.startedAt !== undefined ? formatElapsed((step.endedAt ?? Date.now()) - step.startedAt) : '';
    const glyph =
      step.status === 'done'
        ? chalk.green('✓')
        : step.status === 'failed'
          ? chalk.red('✗')
          : step.status === 'skipped'
            ? chalk.dim('–')
            : chalk.dim('○');
    const label = step.status === 'done' && step.doneLabel ? step.doneLabel : step.label;
    console.log(`    ${glyph} ${formatForConsole(label)}${duration ? chalk.dim(`  ${duration}`) : ''}`);
  }

  // Finalizing log lines (e.g. the closing success message) — only with -d.
  if (showLogs && snapshot.logs.length > 0) {
    console.log();
    for (const entry of snapshot.logs) {
      const { glyph, color } = REPORT_LOG[entry.level];
      console.log(`  ${color(glyph)} ${formatForConsole(entry.message)}`);
    }
  }

  // On failure, surface the failing process's tail and the error message.
  if (!ok) {
    const failed = snapshot.processes.find((proc) => proc.status === 'failed');
    if (failed && failed.lines.length > 0) {
      console.log();
      console.log(chalk.dim('  output:'));
      for (const line of failed.lines.slice(-5)) console.log(chalk.dim(`    ${line}`));
    }
    const message = error instanceof Error ? error.message : error !== undefined ? String(error) : '';
    if (message) {
      console.log();
      console.log(`  ${chalk.red(message)}`);
    }
    // Friendly hints (e.g. "did you mean…") carried by SuggestionError.
    if (SuggestionError.is(error)) {
      console.log();
      console.log(`  ${chalk.dim(error.suggestionLabel)}`);
      for (const suggestion of error.suggestions) {
        console.log(`    ${chalk.dim('•')} ${suggestion}`);
      }
    }
  }
  console.log();
};

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────
/**
 * Runs a script body under the full-screen dashboard (in a TTY) and prints a
 * report on completion. Re-throws on failure so the caller can set the exit
 * code; the report is printed first.
 */
export const runScript = async (meta: RunMeta, body: () => Promise<void>): Promise<void> => {
  const showLogs = consumeDebugFlag();

  if (!process.stdout.isTTY) {
    // Non-interactive: keep the plain console behavior (logger/command-runner
    // fall back automatically because activeRun stays null).
    try {
      await body();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    }
    return;
  }

  const store = new RunStore(meta.name, meta.subtitle);
  let instance: RenderInstance | null = render(
    React.createElement(Dashboard, { store }),
    { altScreen: true },
  );
  activeRun = { store };

  const teardown = (): void => {
    instance?.unmount();
    instance = null;
    activeRun = null;
  };

  try {
    await body();
    store.setStatus('success');
    teardown();
    printReport(store.getSnapshot(), showLogs);
  } catch (error) {
    store.setStatus('failure');
    teardown();
    printReport(store.getSnapshot(), showLogs, error);
    // Own the exit code rather than process.exit() so the buffered report
    // above flushes before the process exits.
    process.exitCode = 1;
  }
};

/**
 * Wraps a non-command unit of work (e.g. an API call) as a live step so it
 * shows a spinner + elapsed time in the dashboard. Returns the body's result.
 */
export const runStep = async <T>(
  label: string | { active: string; done: string },
  body: () => Promise<T>,
): Promise<T> => {
  const run = activeRun;
  if (!run) return body();

  const spec =
    typeof label === 'string' ? { label } : { label: label.active, doneLabel: label.done };
  const [id] = run.store.addSteps([spec]);
  run.store.startStep(id);
  try {
    const result = await body();
    run.store.finishStep(id, 'done');
    return result;
  } catch (error) {
    run.store.finishStep(id, 'failed');
    throw error;
  }
};

/**
 * Reports a pre-flight error (thrown before the dashboard mounts — e.g. bad
 * args or a non-git directory) to the plain console and sets exit code 1.
 * In-run failures are handled by {@link runScript}'s report instead.
 */
export const reportError = (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  console.error();
  console.error(`  ${chalk.red('✗')} ${chalk.red(message)}`);
  if (SuggestionError.is(error)) {
    console.error();
    console.error(`  ${chalk.dim(error.suggestionLabel)}`);
    for (const suggestion of error.suggestions) {
      console.error(`    ${chalk.dim('•')} ${suggestion}`);
    }
  }
  console.error();
  process.exitCode = 1;
};

export { render } from './render.js';
export { code, fmt } from './format.js';
export type { RunStore } from './run-store.js';
