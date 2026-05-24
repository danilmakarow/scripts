#!/usr/bin/env node
/**
 * doterminal — opens N new Terminal.app windows, each in the current cwd.
 *
 * Usage:
 *   doterminal <count>
 *
 * The count must be a positive integer between 1 and {@link MAX_COUNT}.
 * Windows are spawned via `osascript` against macOS Terminal.app; each runs
 * a `cd "<cwd>"; clear` so the new shell starts in the same directory.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

import { log, theme } from './common/logger';
import { loadEnv } from './common/env';
import { printUsage } from './common/usage';

// ─────────────────────────────────────────────────────────────
// Bootstrap — load .env (kept for parity with other scripts even though
// doterminal does not currently read any env vars)
// ─────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ envPath: path.join(__dirname, '.env') });

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const MIN_COUNT = 1;
const MAX_COUNT = 10;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
/** Parses the count argument; throws with a friendly message on bad input. */
const parseCount = (raw: string | undefined): number => {
  if (raw === undefined) {
    throw new Error('doterminal requires a count argument (e.g. `doterminal 3`)');
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`Invalid count "${raw}" — must be a positive integer`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < MIN_COUNT || value > MAX_COUNT) {
    throw new Error(`Count out of range: ${value} (allowed: ${MIN_COUNT}–${MAX_COUNT})`);
  }
  return value;
};

/** Wraps `str` in single quotes for safe interpolation into a shell command. */
const shellSingleQuote = (str: string): string =>
  `'${str.replace(/'/g, "'\\''")}'`;

/** Escapes a string for embedding inside an AppleScript double-quoted string. */
const escapeAppleScriptString = (str: string): string =>
  str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Opens a single new Terminal.app window running `cd <cwd>; clear`. Uses
 * `osascript` with arg-array invocation (no shell), so the only escaping
 * needed is AppleScript-level for the script body itself.
 */
const openTerminalWindow = async (cwd: string): Promise<void> => {
  const shellCommand = `cd ${shellSingleQuote(cwd)}; clear`;
  const escaped = escapeAppleScriptString(shellCommand);
  await execa('osascript', [
    '-e', 'tell application "Terminal"',
    '-e', `do script "${escaped}"`,
    '-e', 'activate',
    '-e', 'end tell',
  ]);
};

// ─────────────────────────────────────────────────────────────
// Usage banner
// ─────────────────────────────────────────────────────────────
/** Prints the doterminal usage banner. */
const showUsage = (): void => {
  printUsage({
    title: 'doterminal',
    description: `Open N new Terminal.app windows in the current cwd (1–${MAX_COUNT}).`,
    usage: 'doterminal <count>',
    examples: [
      { command: 'doterminal 1', comment: '# one new window' },
      { command: 'doterminal 4', comment: '# four new windows' },
    ],
    steps: [
      'Validate the count argument',
      'Spawn that many Terminal.app windows, each starting in the current cwd',
    ],
  });
};

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
/** Entry point: validates the count and opens that many Terminal windows. */
const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    showUsage();
    process.exit(0);
  }
  if (args.length !== 1) {
    showUsage();
    process.exit(1);
  }

  const count = parseCount(args[0]);
  const cwd = process.cwd();

  log.blank();
  console.log(theme.bold('  doterminal'));
  console.log(`  ${theme.dim('count:')} ${theme.highlight(String(count))}`);
  console.log(`  ${theme.dim('cwd:')}   ${theme.highlight(cwd)}`);
  log.blank();

  for (let windowIndex = 0; windowIndex < count; windowIndex += 1) {
    await openTerminalWindow(cwd);
    log.success(`Opened window ${windowIndex + 1} of ${count}`);
  }

  log.blank();
};

// ─────────────────────────────────────────────────────────────
// Error reporter
// ─────────────────────────────────────────────────────────────
main().catch((err: unknown) => {
  log.blank();
  const message = err instanceof Error ? err.message : String(err);
  log.error(message);

  if (err instanceof Error && 'stderr' in err && typeof (err as { stderr?: unknown }).stderr === 'string') {
    const stderr = (err as { stderr: string }).stderr;
    if (stderr.trim().length > 0) {
      console.log();
      console.log(theme.dim('  Error details:'));
      stderr
        .split('\n')
        .slice(0, 5)
        .forEach((line) => {
          if (line.trim()) console.log(`    ${theme.dim(line)}`);
        });
    }
  }

  log.blank();
  process.exit(1);
});
