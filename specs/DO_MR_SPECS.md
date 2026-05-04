# domr

A CLI that performs the full "ship this change" flow: stage every working-tree
change, ask Claude Haiku for a Conventional Commits message, commit, push, and
then open a merge request (GitLab) or pull request (GitHub) targeting the
repository's default branch.

Source lives at `src/do-mr.ts`. After running `pnpm pack <dirname>` it is
installed as the zsh alias `domr`.

## Features

- **One-shot ship**: stages, commits, pushes, and opens the MR/PR in a single
  command.
- **Master-aware branching**: when invoked on `master` / `main`, asks Haiku to
  suggest a `<type>/<kebab-summary>` branch name, creates that branch, commits
  on it, and pushes with `-u origin`.
- **Idempotent re-runs**: if an open MR/PR already exists for the current
  branch, prints its URL and exits without trying to create a duplicate.
- **Auto default-branch detection**: queries the host API (`/projects/:id` on
  GitLab, `/repos/:owner/:repo` on GitHub) to determine the target branch —
  works on repos that use either `master` or `main`.
- **Multi-host**: GitLab (`gitlab.com` and self-hosted on the same domain) and
  GitHub via the same `GitClient` Strategy.

## Setup

1. Copy `.env.example` to `.env` in the project root:

   ```bash
   cp .env.example .env
   ```

2. Set the required variables:

   ```
   ANTHROPIC_API_KEY=sk-ant-...
   GIT_ACCESS_TOKEN=glpat-...   # GitLab Personal Access Token or GitHub PAT
   ```

   The same `GIT_ACCESS_TOKEN` is used for whichever host the current repo's
   `origin` resolves to. Required scopes:
   - GitLab: `api` (read + write merge requests).
   - GitHub: `repo` (or fine-grained: contents + pull-requests R/W).

3. Install deps and pack the scripts:

   ```bash
   pnpm install
   pnpm pack <install-dirname>
   ```

   Re-source `~/.zshrc` (or open a new shell) to pick up the `domr` alias.

## Usage

```bash
domr
```

No arguments. Behavior depends entirely on the state of the repo at `cwd`.

## Behavior

1. **Sanity checks**:
   - cwd must be inside a git working tree (`assertGitRepo`).
   - There must be uncommitted changes (`hasChanges`). If clean, prints
     "Working tree is clean — nothing to commit." and exits 0.

2. **Stage**: runs `git add -A`.

3. **Ask Haiku**:
   - On any non-master branch, asks for a `commitMessage` only.
   - On `master` / `main`, asks for `{ branchName, commitMessage }` JSON. The
     branch name must match `^[a-z]+\/[a-z0-9-]+$`. Up to 9 numeric suffixes
     are tried if the suggested branch already exists locally.

4. **Branch + commit**: when on master, creates the new branch first
   (`git checkout -b`). Then writes the commit message to a tempfile and runs
   `git commit -F`. The tempfile is removed afterwards.

5. **Push**: `git push -u origin <branch>` via `GitClient.pushBranch`.

6. **Find or create MR/PR**:
   - Resolves `origin` URL → host + `namespace/repo` via the `GitClient`.
   - If host is `unknown` (neither GitLab nor GitHub), prints a warning and
     exits successfully — push already succeeded.
   - Otherwise, queries the host for an open MR/PR sourced from the current
     branch:
     - GitLab: `GET /projects/:id/merge_requests?source_branch=...&state=opened`
     - GitHub: `GET /repos/:owner/:repo/pulls?head=:owner:branch&state=open`
   - If one exists, prints its URL and exits 0.
   - Otherwise creates a new MR/PR targeting the repo's default branch
     (auto-detected). Title = the commit subject. Description = the commit
     body, falling back to the subject if no body.

## Idempotency

`domr` is safe to re-run on the same branch:
- If the working tree is clean and the MR/PR already exists, the command
  short-circuits at the "nothing to commit" guard. To re-check the MR/PR you
  can manually `git push` and inspect it via the host UI.
- Once an open MR/PR exists, subsequent runs that produce no new commits print
  the existing URL without creating duplicates. (If you commit additional
  changes between runs, those go onto the existing branch and are picked up by
  the same MR/PR automatically.)

## Branch-from-master behavior

When invoked while sitting on `master` or `main`:
- Haiku is asked for both a `branchName` and a `commitMessage`.
- `branchName` must satisfy `<type>/<kebab-slug>` and the type prefix must
  match the conventional-commits type used in the message subject.
- If the suggested name collides with a local branch, the script appends `-2`,
  `-3`, ... up to `-10` and uses the first free name. If all 10 are taken it
  raises a `SuggestionError` listing every attempted name.
- The new branch is created off whatever you currently have committed locally
  on master — same semantics as `git checkout -b`.

## Error modes

| Condition                                  | Behavior                                                            |
| ------------------------------------------ | ------------------------------------------------------------------- |
| Missing `ANTHROPIC_API_KEY` / `GIT_ACCESS_TOKEN` | LIVR validation prints a friendly block and exits 1.           |
| Not a git repo                             | `assertGitRepo` throws "Not a git repository: <cwd>", exit 1.       |
| Clean working tree                         | Prints "Working tree is clean — nothing to commit." exit 0.         |
| Detached HEAD                              | `getCurrentBranch` throws, exit 1.                                  |
| Branch-name collision (master flow)        | `SuggestionError` listing all 10 attempted names, exit 1.           |
| Haiku response not JSON / missing fields   | Throws a descriptive `Error`, exit 1.                               |
| `git push` fails                           | Underlying error surfaces with a 5-line `stderr` preview, exit 1.   |
| GitLab/GitHub API call fails               | `GitClientError` printed with status + truncated body, exit 1.      |
| Unsupported git host                       | Warning logged after push; script still exits 0 (push succeeded).   |
| `--help` / `-h`                            | Prints the usage banner via `printUsage`, exit 0.                   |

## Implementation notes

- Reuses every helper from `src/common/`:
  - `logger.ts`, `command-runner.ts`, `env.ts`, `errors.ts`, `usage.ts`.
  - `git-utils.ts`: `assertGitRepo`, `hasChanges`, `getCurrentBranch`,
    `isMasterBranch`.
  - `git-client.ts`: the `GitClient` class with `GitlabAdapter` /
    `GithubAdapter` Strategy implementations.
- Built-in Node 22+ `fetch` is used for all HTTP — no axios/node-fetch.
- HTTP errors get wrapped in `GitClientError` so the CLI can render
  status + truncated body on failure.
