/**
 * Tiny git utility helpers shared by `do-*` scripts that touch git.
 *
 * Intentionally narrow — anything resembling a "git client" lives elsewhere.
 * These helpers exist so that several scripts can perform the same upfront
 * sanity checks (is this a repo? is there work to commit?) without each
 * reinventing the shell-out.
 */

import { execa } from 'execa';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
/**
 * Asserts that `cwd` lives inside a git working tree.
 * Throws a friendly Error if it does not.
 */
export const assertGitRepo = async (cwd: string): Promise<void> => {
  try {
    const result = await execa('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      reject: false,
    });
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    if (result.exitCode === 0 && stdout === 'true') return;
    throw new Error(`Not a git repository: ${cwd}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Not a git repository')) throw err;
    throw new Error(`Not a git repository: ${cwd}`);
  }
};

/**
 * Returns true when there are staged or unstaged changes (including untracked
 * files) in the working tree at `cwd`. Uses `git status --porcelain`.
 */
export const hasChanges = async (cwd: string): Promise<boolean> => {
  const result = await execa('git', ['status', '--porcelain'], { cwd });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  return stdout.trim().length > 0;
};

/**
 * Returns the symbolic name of the currently checked-out branch at `cwd`
 * (e.g. `master`, `main`, `feat/foo`). Uses `git rev-parse --abbrev-ref HEAD`.
 * Throws if the command fails.
 */
export const getCurrentBranch = async (cwd: string): Promise<string> => {
  const result = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    reject: false,
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (result.exitCode !== 0 || stdout.length === 0) {
    throw new Error(`Could not determine current branch in ${cwd}`);
  }
  return stdout;
};

/**
 * Returns true when `branchName` is the repo's primary integration branch.
 * Treats both `master` and `main` as equivalent.
 */
export const isMasterBranch = (branchName: string): boolean =>
  branchName === 'master' || branchName === 'main';
