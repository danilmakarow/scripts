/**
 * Generic subprocess runner: spawns a shell command, streams stdout/stderr
 * into an {@link OutputWindow} beneath an animated spinner, and resolves
 * with the execa result on success. Throws on non-zero exit code.
 */

import { execa, type ExecaError, type Result } from 'execa';
import ora from 'ora';
import logUpdate from 'log-update';
import chalk from 'chalk';
import { theme } from './logger';
import { OutputWindow } from './output-window';
import { getActiveRun } from './tui/index';
import { stripFormatting } from './tui/format';
import type { RunStore } from './tui/run-store';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const SPINNER_INTERVAL_MS = 80;

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
export interface RunCommandOptions {
  /** Working directory the command runs in. */
  readonly cwd: string;
  /** Label shown while running (next to the spinner). Defaults to the command. */
  readonly description?: string;
  /** Optional label shown once the step completes (e.g. "Pulled main"). */
  readonly doneDescription?: string;
}

export type CommandResult = Result;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
/** Splits a chunk of subprocess output into non-empty lines. */
const chunkToLines = (chunk: unknown): string[] => {
  const text = typeof chunk === 'string' ? chunk : String(chunk);
  return text.split('\n').filter((line) => line.length > 0);
};

/** Builds the spinner header text shown above the streamed output. */
const buildSpinnerHeader = (frame: string, label: string): string =>
  `${chalk.cyan(frame)} ${theme.highlight(label)}`;

/** Builds the failure Error (with `stderr`) from a non-zero execa result. */
const toFailure = (result: Result): Error & { stderr?: string } => {
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const detail = stderr || stdout || `Command failed with exit code ${result.exitCode}`;
  const failure = new Error(detail) as Error & { stderr?: string };
  failure.stderr = stderr;
  return failure;
};

/**
 * Runs a command as a live step + streaming process window in the active
 * dashboard. Throws (with stderr attached) on non-zero exit.
 */
const runInDashboard = async (
  command: string,
  label: string,
  doneLabel: string | undefined,
  cwd: string,
  store: RunStore,
): Promise<CommandResult> => {
  const [stepId] = store.addSteps([{ label, doneLabel }]);
  store.startStep(stepId);
  const processId = store.startProcess(command, label);

  const subprocess = execa(command, { cwd, shell: true, reject: false });
  subprocess.stdout?.on('data', (chunk: unknown) => {
    for (const line of chunkToLines(chunk)) store.appendProcessLine(processId, line);
  });
  subprocess.stderr?.on('data', (chunk: unknown) => {
    for (const line of chunkToLines(chunk)) store.appendProcessLine(processId, line);
  });

  const result = await subprocess;
  const exitCode = result.exitCode ?? 0;
  store.finishProcess(processId, exitCode);
  store.finishStep(stepId, exitCode === 0 ? 'done' : 'failed');

  if (exitCode !== 0) throw toFailure(result);
  return result;
};

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────
/**
 * Runs a shell command with a live spinner + 3-line tail of streamed output.
 *
 * - Resolves with the underlying `execa` result on success.
 * - Throws if the process exits with a non-zero code (or fails to spawn).
 * - The caller chooses the cwd and an optional human-readable description.
 */
export const runCommand = async (
  command: string,
  options: RunCommandOptions,
): Promise<CommandResult> => {
  const { cwd, description } = options;
  const label = description ?? command;

  const run = getActiveRun();
  if (run) return runInDashboard(command, label, options.doneDescription, cwd, run.store);

  // Non-interactive fallback: strip code-format markers for plain output.
  const displayLabel = stripFormatting(label);
  const outputWindow = new OutputWindow();
  const spinner = ora({ text: theme.highlight(displayLabel), color: 'cyan' });

  outputWindow.updateSpinnerText(buildSpinnerHeader(SPINNER_FRAMES[0], displayLabel));

  let frameIndex = 0;
  const animationInterval = setInterval(() => {
    frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
    outputWindow.updateSpinnerText(buildSpinnerHeader(SPINNER_FRAMES[frameIndex], displayLabel));
  }, SPINNER_INTERVAL_MS);

  try {
    const subprocess = execa(command, {
      cwd,
      shell: true,
      reject: false,
    });

    subprocess.stdout?.on('data', (chunk: unknown) => {
      for (const line of chunkToLines(chunk)) outputWindow.addLine(line);
    });
    subprocess.stderr?.on('data', (chunk: unknown) => {
      for (const line of chunkToLines(chunk)) outputWindow.addLine(line);
    });

    const result = await subprocess;
    clearInterval(animationInterval);
    logUpdate.clear();

    if (result.exitCode !== 0) {
      spinner.fail(theme.error(displayLabel));
      const stderr = typeof result.stderr === 'string' ? result.stderr : '';
      const stdout = typeof result.stdout === 'string' ? result.stdout : '';
      const detail = stderr || stdout || `Command failed with exit code ${result.exitCode}`;
      const failure = new Error(detail) as Error & { stderr?: string };
      failure.stderr = stderr;
      throw failure;
    }

    spinner.succeed(theme.success(displayLabel));
    return result;
  } catch (err) {
    clearInterval(animationInterval);
    logUpdate.clear();
    spinner.fail(theme.error(displayLabel));

    // Surface execa's stderr through the thrown error if present.
    if (err instanceof Error) throw err;
    const wrapped = new Error(String(err)) as Error & { cause?: unknown };
    wrapped.cause = err;
    throw wrapped;
  }
};

/** Type guard for execa's failure shape, useful when callers want to inspect stderr. */
export const isExecaError = (err: unknown): err is ExecaError =>
  err instanceof Error && 'stderr' in err;
