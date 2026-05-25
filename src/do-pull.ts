#!/usr/bin/env node
/**
 * dopull — fetches the latest changes for a project's current branch and for
 * its master/main branch, preserving any local work via `git stash`.
 *
 * If a project name is given it is resolved (fuzzy) against `PROJECTS_DIR`;
 * otherwise the current working directory is used.
 *
 * Behavior:
 *   1. Stash uncommitted changes if any (label: "dopull autostash").
 *   2. When the current branch is not master/main, detour through master:
 *      `git checkout <master> && git pull && git checkout <original>`.
 *   3. `git pull` the current branch (covers the master case too — only one
 *      pull runs when the user is already on master).
 *   4. Pop the autostash if step 1 stashed anything.
 *
 * Usage:
 *   dopull              # operate on cwd
 *   dopull <project>    # operate on <PROJECTS_DIR>/<project> (fuzzy match)
 *
 * Env:
 *   PROJECTS_DIR — only required when a project name is supplied.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { log } from './common/logger';
import { runCommand } from './common/command-runner';
import { runScript, reportError, fmt } from './common/tui/index';
import { consumeDebugFlag } from './common/cli-flags';
import { loadEnv } from './common/env';
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
const STASH_LABEL = 'dopull autostash';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
/** Resolves a project arg to an absolute cwd; uses process.cwd() when absent. */
const resolveProjectCwd = (projectArg: string | undefined): string => {
  if (!projectArg) return process.cwd();

  const projectsDir = process.env.PROJECTS_DIR?.trim();
  if (!projectsDir) {
    throw new Error(
      'PROJECTS_DIR is not set. Define it in .env to resolve project names, or run dopull without arguments.',
    );
  }

  const directories = getDirectories(projectsDir);
  const resolved = matchDirectory(projectArg, directories);
  return path.join(projectsDir, resolved);
};

// ─────────────────────────────────────────────────────────────
// Usage banner
// ─────────────────────────────────────────────────────────────
/** Prints the dopull usage banner. */
const showUsage = (): void => {
  printUsage({
    title: 'dopull',
    description: 'Pull latest changes for the current branch and master/main, stashing local work if needed.',
    usage: 'dopull [project]',
    examples: [
      { command: 'dopull', comment: '# operate on cwd' },
      { command: 'dopull core', comment: '# resolves to $PROJECTS_DIR/core (fuzzy match)' },
    ],
    steps: [
      'Stash uncommitted changes if any',
      'If not on master/main: checkout master, git pull, checkout back',
      'git pull on the current branch',
      'Pop the autostash if one was created',
    ],
  });
};

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
/** Entry point: pulls the project's current branch and master/main. */
const main = async (): Promise<void> => {
  // Consume the global -d/--debug flag before parsing this script's own args.
  consumeDebugFlag();
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

  // ── Sanity (pre-flight, before the dashboard mounts) ──
  await assertGitRepo(cwd);
  const currentBranch = await getCurrentBranch(cwd);
  const masterBranch = await findMasterBranch(cwd);
  const needsStash = await hasChanges(cwd);
  const subtitle =
    fmt`${cwd} · ${currentBranch} → ${masterBranch}` + (needsStash ? ' · will stash' : '');

  await runScript({ name: 'dopull', subtitle }, async () => {
    // ── Stash local work ──
    let stashed = false;
    if (needsStash) {
      await runCommand(`git stash push -u -m ${JSON.stringify(STASH_LABEL)}`, {
        cwd,
        description: 'Stashing local changes',
        doneDescription: 'Stashed local changes',
      });
      stashed = true;
    }

    // ── Detour through master when on a feature branch ──
    if (currentBranch !== masterBranch) {
      await runCommand(`git checkout ${masterBranch}`, {
        cwd,
        description: fmt`Checking out ${masterBranch}`,
        doneDescription: fmt`Checked out ${masterBranch}`,
      });
      await runCommand('git pull', {
        cwd,
        description: fmt`Pulling ${masterBranch}`,
        doneDescription: fmt`Pulled ${masterBranch}`,
      });
      await runCommand(`git checkout ${currentBranch}`, {
        cwd,
        description: fmt`Returning to ${currentBranch}`,
        doneDescription: fmt`Returned to ${currentBranch}`,
      });
    }

    // ── Pull the current branch ──
    await runCommand('git pull', {
      cwd,
      description: fmt`Pulling ${currentBranch}`,
      doneDescription: fmt`Pulled ${currentBranch}`,
    });

    // ── Restore stash ──
    if (stashed) {
      await runCommand('git stash pop', {
        cwd,
        description: 'Restoring stashed changes',
        doneDescription: 'Restored stashed changes',
      });
    }

    log.success(fmt`${currentBranch} up to date`);
  });
};

// ─────────────────────────────────────────────────────────────
// Error reporter (pre-flight only; in-run failures are reported by runScript)
// ─────────────────────────────────────────────────────────────
main().catch(reportError);
