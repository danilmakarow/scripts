# scripts

Personal collection of TypeScript CLI scripts installed as zsh aliases. Each script lives in `src/` as `do-<name>.ts` and becomes a `do<name>` zsh command after running the pack/build script.

## Layout

```
src/
  do-*.ts          # User-facing commands (one per file)
  common/          # Reusable helpers shared across scripts
  config/          # Build/packaging scripts (e.g. build.ts)
specs/             # One spec file per do-* script
dist/              # Build output (gitignored)
```

## Naming convention

`src/do-<name>.ts` produces a zsh alias named `do<name>` (dashes stripped).
Example: `src/do-connect.ts` → `doconnect` command.

## Build & install

```bash
pnpm run pack
```

(Note: `pnpm run pack` — bare `pnpm pack` is shadowed by pnpm's built-in tarball command.)

The install dir name comes from `SCRIPTS_PACK_DIR` (in `.env` or process env), defaulting to `custom-scripts`. It is always created under `os.tmpdir()`.

This:
1. Resolves & validates the dir name from env (or default).
2. Cleans the target dir under macOS `os.tmpdir()/<dirname>`.
3. Compiles every `src/do-*.ts` to that dir as a self-contained ESM bundle.
4. Removes the previously installed block from `~/.zshrc` and re-adds aliases pointing at the new dir.

Re-source `~/.zshrc` (or open a new shell) to pick up the changes.

## Conventions

- TypeScript strict mode. Never use `any` — find or create the right type.
- Arrow functions for new declarations. Short JSDoc on every new function.
- Early-exit pattern: handle edge cases first, main logic last.
- No single-letter variable names. Intention-revealing identifiers.
- Class member ordering: static → private → public, fields then constructor then methods.
- Reuse helpers from `src/common/` instead of duplicating. Add new helpers there grouped by concern (e.g. `logger.ts`, `git-client.ts`, `command-runner.ts`).
- Validate all input at script entry (env vars, args, git state) before any heavy work.
- For git-related scripts: verify the cwd is a git repo and that there are changes before kicking off long-running operations.
- Log progress via the shared logger so spinners and streamed output stay consistent across scripts.

## Per-script docs

Every `do-*.ts` has a matching `specs/DO_<NAME>_SPECS.md` describing what the script does, its arguments, env requirements, and edge cases.
