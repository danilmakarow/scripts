# dopull (pull current branch + master/main, stash-safe)

The `dopull` script brings a project up to date by pulling the latest changes
on the current branch and on the repo's master/main branch, preserving any
uncommitted local work via `git stash` and restoring it at the end.

## Usage

```bash
dopull              # operate on cwd
dopull <project>    # resolve <project> against $PROJECTS_DIR (fuzzy match)
```

The argument is optional:

- **No argument** — operates on `process.cwd()`. The cwd must be a git repo.
- **One argument** — resolved as a fuzzy substring match against the immediate
  subdirectories of `$PROJECTS_DIR` (same matching used by `doconnect`). Exact
  matches win; otherwise the unique containing match is used. Zero matches or
  multiple matches → friendly error listing the candidates.

`$PROJECTS_DIR` is only required when an argument is supplied.

### Examples

```bash
# Pull current dir
dopull

# Pull $PROJECTS_DIR/core (full name)
dopull core

# Pull $PROJECTS_DIR/lucid-resourceful (fuzzy: any substring that uniquely matches)
dopull lucid
```

## What it does (step by step)

1. **Resolve cwd** — argument-aware (see above).
2. **Assert git repo** — `assertGitRepo(cwd)`.
3. **Read branch state** — `getCurrentBranch(cwd)`, `findMasterBranch(cwd)`
   (probes `master` then `main` via `git rev-parse --verify`), `hasChanges(cwd)`.
4. **Print a header** — cwd, current branch, master branch, and whether a
   stash will be created.
5. **Stash if dirty** — `git stash push -u -m "dopull autostash"` (includes
   untracked files via `-u`). Skipped if the working tree is clean.
6. **Master detour** — when the current branch is not master/main:
   `git checkout <master>` → `git pull` → `git checkout <originalBranch>`.
   Skipped when the user is already on master/main.
7. **Pull current branch** — `git pull` on the original branch.
8. **Restore stash** — `git stash pop` only if step 5 created a stash.
9. **Print success** — confirms the branch is up to date.

## Error modes

| Condition | Behavior |
|-----------|----------|
| Argument supplied but `$PROJECTS_DIR` unset | Throw with hint to set it or omit the argument, exit 1 |
| Argument matches zero subdirs of `$PROJECTS_DIR` | `SuggestionError` listing available dirs, exit 1 |
| Argument matches multiple subdirs | `SuggestionError` listing matching dirs, exit 1 |
| cwd is not a git repo | Throw `Not a git repository: <cwd>`, exit 1 |
| Repo has neither `master` nor `main` | Throw `No "master" or "main" branch found in <cwd>`, exit 1 |
| Any `runCommand` step exits non-zero (checkout, pull, stash, pop) | Throw with command output, exit 1. **The autostash (if any) stays in `git stash list`** — recover with `git stash list` + `git stash pop`. |
| `git stash pop` reports merge conflicts | runCommand throws on non-zero exit. Stash entry remains, conflict markers are in the working tree. |

## Implementation notes

- Source: `src/do-pull.ts`.
- Shared helpers used: `assertGitRepo`, `getCurrentBranch`, `findMasterBranch`,
  `hasChanges` (from `common/git-utils.ts`); `matchDirectory`, `getDirectories`
  (from `common/fs-helpers.ts`); `runCommand` (from `common/command-runner.ts`);
  `log`, `theme` (from `common/logger.ts`); `printUsage` (from `common/usage.ts`);
  `SuggestionError` (from `common/errors.ts`).
- The stash label `"dopull autostash"` is passed via `JSON.stringify` to safely
  embed in the shell command string used by `runCommand`.
- Pulls use the user's configured `pull.rebase` / `pull.ff` settings — the
  script does not override them.
