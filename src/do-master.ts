#!/usr/bin/env node
/**
 * domaster — switches a project to master/main with the latest changes pulled.
 *
 * If a project name is given it is resolved (fuzzy) against `PROJECTS_DIR`;
 * otherwise the current working directory is used.
 *
 * Behavior:
 *   1. Stash uncommitted changes if any (label: "domaster autostash").
 *      The stash is left in `git stash list` so the user can `git stash pop`
 *      later — feature-branch WIP rarely belongs on master.
 *   2. Checkout master/main.
 *   3. `git pull`.
 *
 * Usage:
 *   domaster              # operate on cwd
 *   domaster <project>    # operate on <PROJECTS_DIR>/<project> (fuzzy match)
 *
 * Env:
 *   PROJECTS_DIR — only required when a project name is supplied.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { log, theme } from './common/logger';
import { runCommand } from './common/command-runner';
import { loadEnv } from './common/env';
import { SuggestionError } from './common/errors';
import { getDirectories, matchDirectory } from './common/fs-helpers';
import { printUsage } from './common/usage';
import {
  assertGitRepo,
  findMasterBranch,
  getCurrentBranch,
  hasChanges,
} from './common/git-utils';

// ─────────────────────────────────────────────────────────────
// Bootstrap — load .env that sits next to the bundled script
// ─────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ envPath: path.join(__dirname, '.env') });

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const STASH_LABEL = 'domaster autostash';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
/** Resolves a project arg to an absolute cwd; uses process.cwd() when absent. */
const resolveProjectCwd = (projectArg: string | undefined): string => {
  if (!projectArg) return process.cwd();

  const projectsDir = process.env.PROJECTS_DIR?.trim();
  if (!projectsDir) {
    throw new Error(
      'PROJECTS_DIR is not set. Define it in .env to resolve project names, or run domaster without arguments.',
    );
  }

  const directories = getDirectories(projectsDir);
  const resolved = matchDirectory(projectArg, directories);
  return path.join(projectsDir, resolved);
};

// ─────────────────────────────────────────────────────────────
// Usage banner
// ─────────────────────────────────────────────────────────────
/** Prints the domaster usage banner. */
const showUsage = (): void => {
  printUsage({
    title: 'domaster',
    description: 'Stash any local changes, checkout master/main, and pull the latest.',
    usage: 'domaster [project]',
    examples: [
      { command: 'domaster', comment: '# operate on cwd' },
      { command: 'domaster core', comment: '# resolves to $PROJECTS_DIR/core (fuzzy match)' },
    ],
    steps: [
      'Stash uncommitted changes if any (kept in stash list)',
      'Checkout master/main',
      'git pull',
    ],
  });
};

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
/** Entry point: stashes if needed, switches to master/main, pulls. */
const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    showUsage();
    process.exit(0);
  }
  if (args.length > 1) {
    showUsage();
    process.exit(1);
  }

  const cwd = resolveProjectCwd(args[0]);

  // ── Phase 1: Sanity ──
  await assertGitRepo(cwd);
  const currentBranch = await getCurrentBranch(cwd);
  const masterBranch = await findMasterBranch(cwd);
  const needsStash = await hasChanges(cwd);

  log.blank();
  console.log(theme.bold('  domaster'));
  console.log(`  ${theme.dim('cwd:')}    ${theme.highlight(cwd)}`);
  console.log(`  ${theme.dim('branch:')} ${theme.highlight(currentBranch)}`);
  console.log(`  ${theme.dim('master:')} ${theme.highlight(masterBranch)}`);
  if (needsStash) {
    console.log(`  ${theme.dim('local:')}  ${theme.warning('uncommitted changes — will stash & keep')}`);
  }
  log.blank();

  // ── Phase 2: Stash local work (kept, not popped) ──
  let stashed = false;
  if (needsStash) {
    await runCommand(`git stash push -u -m ${JSON.stringify(STASH_LABEL)}`, {
      cwd,
      description: 'Stashing local changes',
    });
    stashed = true;
  }

  // ── Phase 3: Checkout master/main if not already there ──
  if (currentBranch !== masterBranch) {
    await runCommand(`git checkout ${masterBranch}`, {
      cwd,
      description: `Checking out ${masterBranch}`,
    });
  }

  // ── Phase 4: Pull ──
  await runCommand('git pull', {
    cwd,
    description: `Pulling ${masterBranch}`,
  });

  log.blank();
  log.success(`domaster complete — on ${theme.highlight(masterBranch)}`);
  if (stashed) {
    console.log(
      `  ${theme.dim('stash:')}  ${theme.warning(`"${STASH_LABEL}" left in git stash list — run`)} ${theme.highlight('git stash pop')} ${theme.warning('to restore')}`,
    );
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

  if (SuggestionError.is(err)) {
    log.blank();
    console.log(theme.dim(`  ${err.suggestionLabel}`));
    for (const suggestion of err.suggestions) {
      console.log(`    ${theme.dim('•')} ${suggestion}`);
    }
  } else if (err instanceof Error && 'stderr' in err && typeof (err as { stderr?: unknown }).stderr === 'string') {
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
