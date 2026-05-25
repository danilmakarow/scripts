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
    fmt`${cwd} · ${currentBranch} → ${masterBranch}` + (needsStash ? ' · will stash & keep' : '');

  await runScript({ name: 'domaster', subtitle }, async () => {
    // ── Phase 2: Stash local work (kept, not popped) ──
    let stashed = false;
    if (needsStash) {
      await runCommand(`git stash push -u -m ${JSON.stringify(STASH_LABEL)}`, {
        cwd,
        description: 'Stashing local changes',
        doneDescription: 'Stashed local changes',
      });
      stashed = true;
    }

    // ── Phase 3: Checkout master/main if not already there ──
    if (currentBranch !== masterBranch) {
      await runCommand(`git checkout ${masterBranch}`, {
        cwd,
        description: fmt`Checking out ${masterBranch}`,
        doneDescription: fmt`Checked out ${masterBranch}`,
      });
    }

    // ── Phase 4: Pull ──
    await runCommand('git pull', {
      cwd,
      description: fmt`Pulling ${masterBranch}`,
      doneDescription: fmt`Pulled ${masterBranch}`,
    });

    log.success(fmt`domaster complete — on ${masterBranch}`);
    if (stashed) {
      log.info(`"${STASH_LABEL}" left in git stash list — run git stash pop to restore`);
    }
  });
};

// ─────────────────────────────────────────────────────────────
// Error reporter (pre-flight only; in-run failures are reported by runScript)
// ─────────────────────────────────────────────────────────────
main().catch(reportError);
