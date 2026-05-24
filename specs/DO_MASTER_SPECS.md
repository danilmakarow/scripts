# domaster (switch to master/main with latest changes)

The `domaster` script stashes any uncommitted work, switches the project to
its master/main branch, and pulls the latest. The stash is **left intact** in
`git stash list` so the user can `git stash pop` later if they want the WIP on
master — feature-branch WIP rarely belongs on master, so this is a deliberate
"keep, do not pop" decision.

## Usage

```bash
domaster              # operate on cwd
domaster <project>    # resolve <project> against $PROJECTS_DIR (fuzzy match)
```

The argument is optional and behaves identically to `dopull`:

- **No argument** — operates on `process.cwd()`. The cwd must be a git repo.
- **One argument** — fuzzy substring match against subdirectories of
  `$PROJECTS_DIR`. Same rules as `dopull` (exact > unique substring > error).

`$PROJECTS_DIR` is only required when an argument is supplied.

### Examples

```bash
# Switch current dir to master and pull
domaster

# Switch $PROJECTS_DIR/core to master and pull
domaster core

# Fuzzy
domaster lucid
```

## What it does (step by step)

1. **Resolve cwd** — argument-aware.
2. **Assert git repo** — `assertGitRepo(cwd)`.
3. **Read branch state** — `getCurrentBranch(cwd)`, `findMasterBranch(cwd)`,
   `hasChanges(cwd)`.
4. **Print a header** — cwd, current branch, master branch, and whether a
   stash will be created.
5. **Stash if dirty** — `git stash push -u -m "domaster autostash"` (includes
   untracked files via `-u`). Skipped if the working tree is clean.
6. **Checkout master/main** — `git checkout <master>`. Skipped when the user
   is already on master/main.
7. **Pull** — `git pull` on master/main.
8. **Print success** — confirms the branch and, if a stash was created, prints
   a hint to recover it via `git stash pop`.

The script does **not** pop the autostash. The stash entry stays in
`git stash list` indefinitely; the user is in control of when (and whether) to
restore it.

## Error modes

| Condition | Behavior |
|-----------|----------|
| Argument supplied but `$PROJECTS_DIR` unset | Throw with hint, exit 1 |
| Argument matches zero subdirs of `$PROJECTS_DIR` | `SuggestionError` listing available dirs, exit 1 |
| Argument matches multiple subdirs | `SuggestionError` listing matching dirs, exit 1 |
| cwd is not a git repo | Throw `Not a git repository: <cwd>`, exit 1 |
| Repo has neither `master` nor `main` | Throw `No "master" or "main" branch found in <cwd>`, exit 1 |
| Any `runCommand` step exits non-zero | Throw with command output, exit 1. Stash (if any) stays in `git stash list`. |

## Implementation notes

- Source: `src/do-master.ts`.
- Shares the same helper set as `dopull`.
- The "leave the stash alone" decision is intentional — see header.
