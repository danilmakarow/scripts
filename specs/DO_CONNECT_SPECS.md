# doconnect

A CLI for cross-package local development. Builds a source pnpm package and
wires its `dist/` into the dependency tree of the next package via a `file:`
link, then re-installs. Supports chaining multiple packages in a single run.

Source lives at `src/do-connect.ts`. After running `pnpm pack <dirname>` it is
installed as the zsh alias `doconnect`.

## Features

- **Fuzzy matching**: pass partial names (e.g. `fintech360` matches
  `fintech360-psp-adapter`).
- **Up-front validation**: confirms every directory exists and the relevant
  dependency is declared before doing any heavy work.
- **Chain support**: 3+ args walks the chain (`a → b → c`), rebuilding and
  re-linking at every step.
- **Override-aware**: rewrites entries in `dependencies`, `devDependencies`,
  `overrides`, `pnpm.overrides`, and `resolutions`.
- **Pretty UX**: shared logger + spinner + 3-line streaming tail of subprocess
  output (see `src/common/`).

## Setup

1. Copy `.env.example` to `.env` in the project root:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and set your projects directory:

   ```
   PROJECTS_DIR=/Users/username/projects
   ```

3. Install deps and pack the scripts:

   ```bash
   pnpm install
   pnpm pack <install-dirname>
   ```

   Re-source `~/.zshrc` (or open a new shell) to pick up the `doconnect` alias.

## Usage

```bash
doconnect <project1> <project2> [project3...]
```

### Examples

```bash
# Update fintech360-psp-adapter inside core
doconnect fintech360 core

# Update psp-integration-core inside fintech360-psp-adapter
doconnect psp-integration fintech360

# Chain: build lib into core, then build core into app
doconnect lib core app
```

## How it works

1. Loads `PROJECTS_DIR` from `.env` and validates it via LIVR.
2. Resolves every CLI arg against the subdirectories of `PROJECTS_DIR`,
   requiring exactly one fuzzy match per argument.
3. For each adjacent pair `(source, target)`:
   1. Reads the source's package name from `dist/package.json` (or root
      `package.json` as a fallback) and confirms it appears in the target's
      dependency tree.
4. Once everything validates, walks the chain:
   1. Runs `pnpm generate` in the source.
   2. Reads the freshly built `dist/package.json` to determine the package name.
   3. Rewrites every reference to that package in the target's `package.json`
      to `file:${PROJECTS_DIR}/<sourceDir>/dist`. References in
      `dependencies`, `devDependencies`, `overrides`, `pnpm.overrides`, and
      `resolutions` are all updated.
   4. Clears matching `node_modules/.pnpm/@pn+<sourceDir>*` cache entries in
      the target.
   5. Runs `pnpm i` in the target.
5. When chaining, every previously built package is re-linked into every
   subsequent target, so a long chain ends with all upstream packages wired.

## Path resolution

The `file:` link is built from the validated `PROJECTS_DIR`:

```
file:${PROJECTS_DIR}/<sourceDir>/dist
```

(There used to be a hardcoded `/Users/danil/projects/...` here; it is fixed.)

## Error handling

- **Missing arguments**: shows the styled usage banner and exits with code 1.
- **Missing/extra fuzzy match**: prints the available (or matching) directories
  via a `SuggestionError` rendering.
- **Missing/invalid env**: LIVR errors are pretty-printed and the process exits
  with code 1.
- **Build/install failures**: the failing subprocess's `stderr` (first 5 lines)
  is shown beneath the error message.

## Implementation notes

The script imports its helpers from `src/common/`:

- `logger.ts` — chalk theme, symbols, simple `log` object.
- `output-window.ts` — 3-line streaming display.
- `command-runner.ts` — `runCommand(command, { cwd, description })` with
  spinner + streamed output.
- `env.ts` — `loadEnv` + `validateEnv<T>(rules, source)` LIVR helper.
- `errors.ts` — `SuggestionError` class.
- `fs-helpers.ts` — `getDirectories`, `readJson<T>`, `writeJson`,
  `pathExists`.
- `usage.ts` — styled usage banner renderer.
