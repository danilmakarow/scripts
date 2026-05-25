#!/usr/bin/env node
/**
 * dotmux — a registry of saved tmux layouts, driven by a simple verb.
 *
 * Rather than scattering one-off bash scripts around, each saved layout
 * ("dotscript") is declared in the {@link DOTSCRIPTS} table below as a tmux
 * session name plus the windows/panes it should open, one long-running command
 * per pane. The CLI then exposes start/stop/restart over those layouts.
 *
 * Usage:
 *   dotmux <name> <operation>
 *
 * `<name>` is a registered dotscript and is matched with a VSCode-style fuzzy
 * search (subsequence + word-boundary bonuses), so `ndev` resolves to
 * `nexus-dev` and `nngrok` to `nexus-ngrok`. `<operation>` is one of
 * `up` / `down` / `restart` and is matched as a substring, so the shortest
 * unambiguous fragment works (`u` → up, `do` → down, `re` → restart).
 *
 * Operations:
 *   up       Start the session detached, building each window's panes.
 *   down     Kill the session.
 *   restart  Stop (if running) then start.
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

import { log } from './common/logger';
import { loadEnv } from './common/env';
import { runCommand } from './common/command-runner';
import { runScript, reportError, fmt } from './common/tui/index';
import { consumeDebugFlag } from './common/cli-flags';
import { SuggestionError } from './common/errors';
import { printUsage } from './common/usage';

// ─────────────────────────────────────────────────────────────
// Bootstrap — load .env (kept for parity with other scripts even though
// dotmux does not currently read any env vars)
// ─────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ envPath: path.join(__dirname, '.env') });

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
/** Where a split pane is placed relative to the previous (active) pane. */
type SplitDirection = 'right' | 'down';

interface TmuxPane {
  /** Human label shown in dashboard steps (e.g. "core"). */
  readonly label: string;
  /** Long-running command the pane runs on creation. */
  readonly command: string;
  /** Start directory for the pane; a leading `~` is expanded. Defaults to cwd. */
  readonly cwd?: string;
  /**
   * How this pane is opened relative to the previous one. The first pane in a
   * window opens the window (omit `split`); later panes split the previous
   * (active) pane to the `right` (tmux `-h`) or `down` (tmux `-v`).
   */
  readonly split?: SplitDirection;
}

interface TmuxWindow {
  /** Window name shown in the tmux status bar. */
  readonly name: string;
  /** Panes opened in order; the first opens the window, the rest split it. */
  readonly panes: readonly TmuxPane[];
}

interface DotScript {
  /** The CLI `<name>` and the tmux session name. */
  readonly name: string;
  /** Windows opened in order; the first becomes window 0. */
  readonly windows: readonly TmuxWindow[];
}

// ─────────────────────────────────────────────────────────────
// Saved dotscripts
// ─────────────────────────────────────────────────────────────
const DOTSCRIPTS: readonly DotScript[] = [
  {
    name: 'nexus-ngrok',
    windows: [
      {
        name: 'webhook',
        panes: [
          {
            label: 'webhook',
            command: 'ngrok http --domain nexus-webhook.ngrok.app http://127.0.0.1:3333',
          },
        ],
      },
      {
        name: 'redirect',
        panes: [
          {
            label: 'redirect',
            command: 'ngrok http --domain nexus-redirect.ngrok.app http://127.0.0.1:3333',
          },
        ],
      },
    ],
  },
  {
    // One window, three panes: core fills the left half; client-ui (top) and
    // management-ui (bottom) stack on the right.
    name: 'nexus-dev',
    windows: [
      {
        name: 'dev',
        panes: [
          { label: 'core', cwd: '~/projects/core', command: 'pnpm dev' },
          { label: 'client-ui', cwd: '~/projects/client-ui', command: 'pnpm dev', split: 'right' },
          {
            label: 'management-ui',
            cwd: '~/projects/management-ui',
            command: 'pnpm build && pnpm preview',
            split: 'down',
          },
        ],
      },
    ],
  },
];

const OPERATIONS = ['up', 'down', 'restart'] as const;
type Operation = (typeof OPERATIONS)[number];

// ─────────────────────────────────────────────────────────────
// Fuzzy name matching (VSCode-style subsequence + word-boundary bonuses)
// ─────────────────────────────────────────────────────────────
const WORD_SEPARATORS = new Set(['-', '_', '/', '.', ' ', ':']);

interface ScoredScript {
  readonly script: DotScript;
  readonly score: number;
}

/** True when `index` begins a new word in `text` (start, post-separator, camelCase hump). */
const isWordStart = (text: string, index: number): boolean => {
  if (index === 0) return true;
  const previous = text[index - 1];
  if (WORD_SEPARATORS.has(previous)) return true;
  const current = text[index];
  const isCamelHump =
    previous === previous.toLowerCase() &&
    current === current.toUpperCase() &&
    current !== current.toLowerCase();
  return isCamelHump;
};

/**
 * Scores `query` against `candidate` as a case-insensitive subsequence, with
 * bonuses for consecutive matches and word-boundary hits (the heuristic VSCode
 * uses for file/symbol search). Returns null when `query` is not a subsequence.
 */
const fuzzyScore = (query: string, candidate: string): number | null => {
  if (query.length === 0) return null;

  const loweredQuery = query.toLowerCase();
  const loweredCandidate = candidate.toLowerCase();

  let score = 0;
  let searchFrom = 0;
  let previousMatch = -1;

  for (let queryIndex = 0; queryIndex < loweredQuery.length; queryIndex += 1) {
    const matchIndex = loweredCandidate.indexOf(loweredQuery[queryIndex], searchFrom);
    if (matchIndex === -1) return null;

    score += 1;
    if (queryIndex > 0 && matchIndex === previousMatch + 1) score += 5;
    if (isWordStart(candidate, matchIndex)) score += 10;
    const gap = matchIndex - (previousMatch + 1);
    if (gap > 0) score -= Math.min(gap, 3);

    previousMatch = matchIndex;
    searchFrom = matchIndex + 1;
  }

  return score;
};

// ─────────────────────────────────────────────────────────────
// Argument resolution
// ─────────────────────────────────────────────────────────────
/** Resolves the `<name>` argument to a dotscript via exact, then fuzzy, match. */
const matchDotScript = (query: string): DotScript => {
  const exact = DOTSCRIPTS.find((script) => script.name === query);
  if (exact) return exact;

  const scored: ScoredScript[] = [];
  for (const script of DOTSCRIPTS) {
    const score = fuzzyScore(query, script.name);
    if (score !== null) scored.push({ script, score });
  }
  scored.sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    throw new SuggestionError(`No dotmux script matches "${query}"`, {
      suggestionLabel: 'Available scripts:',
      suggestions: DOTSCRIPTS.map((script) => script.name),
    });
  }
  if (scored.length === 1 || scored[0].score > scored[1].score) {
    return scored[0].script;
  }

  throw new SuggestionError(`"${query}" is ambiguous`, {
    suggestionLabel: 'Matching scripts:',
    suggestions: scored.map((entry) => entry.script.name),
  });
};

/** Resolves the `<operation>` argument as a substring of a known operation. */
const matchOperation = (partial: string): Operation => {
  if ((OPERATIONS as readonly string[]).includes(partial)) return partial as Operation;

  const matches = OPERATIONS.filter((operation) => operation.includes(partial));
  if (matches.length === 0) {
    throw new SuggestionError(`No operation matches "${partial}"`, {
      suggestionLabel: 'Available operations:',
      suggestions: [...OPERATIONS],
    });
  }
  if (matches.length > 1) {
    throw new SuggestionError(`Multiple operations match "${partial}"`, {
      suggestionLabel: 'Matching operations:',
      suggestions: matches,
    });
  }

  return matches[0];
};

// ─────────────────────────────────────────────────────────────
// Shell quoting / path helpers
// ─────────────────────────────────────────────────────────────
/** Wraps `value` in single quotes for safe interpolation into a shell command. */
const shellSingleQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/** Expands a leading `~` to the user's home directory. */
const expandHome = (target: string): string =>
  target.startsWith('~') ? path.join(os.homedir(), target.slice(1)) : target;

/** Builds the optional `-c <start-directory>` flag for a pane. */
const startDirFlag = (cwd: string | undefined): string =>
  cwd ? ` -c ${shellSingleQuote(expandHome(cwd))}` : '';

// ─────────────────────────────────────────────────────────────
// tmux operations
// ─────────────────────────────────────────────────────────────
/**
 * Reports whether a tmux session with this exact name exists. Runs
 * `has-session` directly (not via {@link runCommand}) because a missing
 * session is an expected non-zero exit, not a failure to surface.
 */
const sessionExists = async (session: string): Promise<boolean> => {
  const result = await execa('tmux', ['has-session', '-t', `=${session}`], { reject: false });
  return result.exitCode === 0;
};

/**
 * Builds the tmux command for a single pane: `new-session` for the very first
 * pane, `new-window` for a window's first pane, or `split-window` (splitting
 * the previous/active pane) for the rest.
 */
const paneCommand = (
  session: string,
  windowName: string,
  pane: TmuxPane,
  isFirstWindow: boolean,
  isFirstPane: boolean,
): string => {
  const cwdFlag = startDirFlag(pane.cwd);
  const paneCmd = shellSingleQuote(pane.command);

  if (isFirstPane) {
    const action = isFirstWindow
      ? `new-session -d -s ${session}`
      : `new-window -t ${session}`;
    return `tmux ${action} -n ${shellSingleQuote(windowName)}${cwdFlag} ${paneCmd}`;
  }

  const directionFlag = pane.split === 'down' ? '-v' : '-h';
  return `tmux split-window ${directionFlag} -t ${session}${cwdFlag} ${paneCmd}`;
};

/**
 * Starts the session detached, building each window's panes in order. No-op
 * (with a warning) when the session is already up, so the operation is
 * idempotent.
 */
const startSession = async (script: DotScript): Promise<void> => {
  if (await sessionExists(script.name)) {
    log.warning(fmt`Session ${script.name} is already running — leaving it as is`);
    return;
  }

  const session = shellSingleQuote(script.name);
  let isFirstWindow = true;
  for (const window of script.windows) {
    let isFirstPane = true;
    for (const pane of window.panes) {
      const command = paneCommand(session, window.name, pane, isFirstWindow, isFirstPane);
      await runCommand(command, {
        cwd: process.cwd(),
        description: fmt`Starting ${pane.label}`,
        doneDescription: fmt`Started ${pane.label}`,
      });
      isFirstPane = false;
    }
    isFirstWindow = false;
  }

  log.success(fmt`Session ${script.name} is up — attach with: tmux attach -t ${script.name}`);
};

/** Kills the session. No-op (with an info line) when it isn't running. */
const stopSession = async (script: DotScript): Promise<void> => {
  if (!(await sessionExists(script.name))) {
    log.info(fmt`Session ${script.name} is not running — nothing to stop`);
    return;
  }

  await runCommand(`tmux kill-session -t ${shellSingleQuote(`=${script.name}`)}`, {
    cwd: process.cwd(),
    description: fmt`Stopping session ${script.name}`,
    doneDescription: fmt`Stopped session ${script.name}`,
  });
};

/** Stops the session (if running) then starts it again. */
const restartSession = async (script: DotScript): Promise<void> => {
  await stopSession(script);
  await startSession(script);
};

/** Dispatches the resolved operation to its handler. */
const runOperation = async (script: DotScript, operation: Operation): Promise<void> => {
  if (operation === 'up') return startSession(script);
  if (operation === 'down') return stopSession(script);
  return restartSession(script);
};

// ─────────────────────────────────────────────────────────────
// Usage banner
// ─────────────────────────────────────────────────────────────
/** Prints the dotmux usage banner. */
const showUsage = (): void => {
  printUsage({
    title: 'dotmux',
    description: 'Start, stop, and restart saved tmux layouts.',
    usage: 'dotmux <name> <operation>',
    examples: [
      { command: 'dotmux nexus-ngrok up', comment: '# start the session detached' },
      { command: 'dotmux ndev up', comment: '# name fuzzy-matched → nexus-dev' },
      { command: 'dotmux nexus-dev do', comment: '# operation matched as substring → down' },
      { command: 'dotmux nexus-ngrok re', comment: '# → restart' },
    ],
    steps: [
      'Fuzzy-resolve the <name> to a saved dotscript',
      'Resolve the <operation> (up / down / restart) as a substring',
      'Run the operation against the tmux session',
    ],
  });
};

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
/** Entry point: resolves the dotscript + operation, then runs it. */
const main = async (): Promise<void> => {
  // Consume the global -d/--debug flag before parsing this script's own args.
  consumeDebugFlag();
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    showUsage();
    process.exit(0);
  }
  if (args.length !== 2) {
    showUsage();
    process.exit(1);
  }

  const script = matchDotScript(args[0]);
  const operation = matchOperation(args[1]);
  const subtitle = fmt`${script.name}` + ` · ${operation}`;

  await runScript({ name: 'dotmux', subtitle }, async () => {
    await runOperation(script, operation);
  });
};

// ─────────────────────────────────────────────────────────────
// Error reporter (pre-flight only; in-run failures are reported by runScript)
// ─────────────────────────────────────────────────────────────
main().catch(reportError);
