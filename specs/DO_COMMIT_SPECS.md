# docommit

A CLI that stages every change in the current git repo, asks Claude Haiku to
draft a Conventional Commits message describing the diff, commits, and pushes.

Source lives at `src/do-commit.ts`. After running `pnpm pack <dirname>` it is
installed as the zsh alias `docommit`.

## Usage

```bash
docommit
```

There are no positional arguments. Pass `--help` (or `-h`) to print the usage
banner instead of running.

## Env requirements

| Variable            | Required | Purpose                                       |
| ------------------- | -------- | --------------------------------------------- |
| `ANTHROPIC_API_KEY` | yes      | Auth for the Anthropic SDK / Haiku call.      |

The script loads `.env` from the bundled script directory (next to the compiled
`do-commit.js`) on startup, then validates with LIVR. A missing or empty
`ANTHROPIC_API_KEY` fails fast with a friendly error before any git operation.

## Flow

1. **Repo check.** `git rev-parse --is-inside-work-tree` (via the shared
   `assertGitRepo` helper). Aborts with exit code 1 if cwd is not a git
   working tree.
2. **Pending-changes check.** `git status --porcelain` (via `hasChanges`). If
   the working tree is clean the script logs *"Nothing to commit — working
   tree is clean."* and exits **0** without doing any heavy work or making
   any AI call.
3. **Stage everything.** `git add -A`.
4. **Capture diff.** `git status --porcelain` and `git diff --cached`. If the
   diff exceeds **80 000 characters**, it is truncated and a warning line is
   logged so the operator knows the model only saw a slice.
5. **Generate message.** A single non-streamed call to
   `client.messages.create({...})` with:
   - **model** `claude-haiku-4-5-20251001` (the fastest current Anthropic model
     and an explicit project requirement)
   - **system** prompt — the verbatim Conventional Commits instructions (see
     below)
   - **user** message — the captured `git status --porcelain` and
     `git diff --cached`, plus a one-line truncation note when applicable.
   - **max_tokens** 1024.
6. **Validate response.** The first text block is unwrapped from any
   surrounding triple-backtick fences and rejected if:
   - it is empty after trimming
   - it still contains a code fence
   - it contains a `Co-Authored-By:` line
   - the first line is longer than **100 characters**.
7. **Commit.** The validated message is written to a tempfile under
   `os.tmpdir()`, then `git commit -F <tmpfile>` runs so multi-line bodies and
   footers survive verbatim. The tempfile is removed in a `finally` block.
8. **Push.** `git push`. Whatever the remote prints is streamed through the
   shared 3-line output window.

Every shell-out goes through `runCommand` from `src/common/command-runner.ts`,
giving the same spinner + streamed-tail UX as `doconnect`.

## The system prompt (verbatim)

```
Write the commit message using Conventional Commits:
- Title format: <type>[optional scope]: <description>
- Types: fix (PATCH bump), feat (MINOR bump), build, chore, ci, docs, style, refactor, perf, test
- The most important change drives the title and its type prefix
- Breaking API changes: append ! after the type/scope (e.g. feat!: ...) AND add a footer "BREAKING CHANGE: <description>"
- Any commit type can carry a BREAKING CHANGE footer; outline every breaking change explicitly in the body or footer
- Additional footers may follow git trailer format (e.g. Refs: #123)
- Do NOT include any Co-Authored-By line
```

The user message tells the model to respond with **only** the commit message,
no preamble or commentary, and includes the captured status + diff.

## Model

| Field          | Value                          |
| -------------- | ------------------------------ |
| Model id       | `claude-haiku-4-5-20251001`    |
| Streaming      | no — single `messages.create`  |
| Max output     | 1024 tokens                    |
| System prompt  | see above                      |

## Error modes

| Condition                                 | Behaviour                                           |
| ----------------------------------------- | --------------------------------------------------- |
| `ANTHROPIC_API_KEY` missing/empty         | LIVR error block, exit 1.                           |
| cwd not a git repo                        | "Not a git repository: <cwd>", exit 1.              |
| Working tree clean                        | Friendly *"Nothing to commit"* line, exit 0.        |
| `git add -A` / status / diff fails        | Subprocess failure surfaced via the shared runner.  |
| Haiku response empty / fenced / has CABy  | Validation error, exit 1, no commit attempted.      |
| Haiku title line > 100 chars              | Validation error, exit 1, no commit attempted.      |
| `git commit` fails                        | runner error, exit 1; tempfile is still cleaned up. |
| `git push` fails                          | runner error, exit 1 (commit has already happened). |

## Implementation notes

- The Anthropic client is **inlined** inside `do-commit.ts`. It is not promoted
  to `src/common/` yet; if other AI-using scripts arrive later a shared helper
  can be extracted then.
- Two helpers are exposed in `src/common/git-utils.ts` so other git-using
  scripts can reuse them:
  - `assertGitRepo(cwd: string): Promise<void>`
  - `hasChanges(cwd: string): Promise<boolean>`
  These shell out via `execa` directly (no spinner) — they're cheap upfront
  validations and shouldn't paint a spinner. Heavyweight git commands
  (`git add -A`, `git commit`, `git push`, `git diff --cached`) go through
  `runCommand` for the streamed UX.
- `simple-git` is in the project's deps but is **not used** by this script.
  The shell-out approach via `runCommand` keeps the on-screen UX identical to
  the rest of the repo, which the project explicitly prefers. If a future
  refactor wants the typed API, the swap is contained.

## Post-build alias

After `pnpm pack <dirname>`:

```bash
docommit
```

(`do-commit.ts` → `docommit`, dashes stripped per project convention.)
