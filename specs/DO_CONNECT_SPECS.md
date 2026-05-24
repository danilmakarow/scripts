# doconnect

A CLI for cross-package local development. Builds a source pnpm package and
wires its `dist/` into the dependency tree of the next package via a `file:`
link, then refreshes the freshly built content directly inside the target's
pnpm virtual store (bypassing `pnpm i` on the steady-state path). Supports
chaining multiple packages in a single run.

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
  `overrides`, `pnpm.overrides`, and `resolutions` in the target's
  `package.json`, plus the top-level `overrides:` block in
  `pnpm-workspace.yaml` (the pnpm 10+ workspace-override location, which
  takes precedence over `dependencies` at resolution time).
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
doconnect [-n[p|d]] <project1> <project2> [project3...]
```

### Flags

All flags are short and combinable (`-nd` ≡ `-n -d`). They only apply when
exactly two project arguments are given.

| Flag | Effect                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------- |
| `-n` | If the source package isn't already declared in the target's `package.json`, add it (instead of erroring out).   |
| `-p` | When adding via `-n`, declare the entry under `dependencies` (this is the default if neither `-p` nor `-d` set). |
| `-d` | When adding via `-n`, declare the entry under `devDependencies`.                                                 |

Constraints:

- `-n` requires exactly two project arguments — it cannot be used with a chain
  of 3+. Without `-n`, a missing dep in the target still fails fast.
- `-p` and `-d` are mutually exclusive.
- `-p` / `-d` without `-n` is rejected — dep-section selection is only
  meaningful when adding a new entry.

The new entry is written with the same `file:${PROJECTS_DIR}/<sourceDir>/dist`
link that the rewire step would produce, so no rewrite warning is emitted on
the same run.

### Examples

```bash
# Update fintech360-psp-adapter inside core
doconnect fintech360 core

# Update psp-integration-core inside fintech360-psp-adapter
doconnect psp-integration fintech360

# Chain: build lib into core, then build core into app
doconnect lib core app

# Add lib as a regular dependency of core (if missing), then connect
doconnect -n lib core
doconnect -np lib core  # explicit equivalent

# Add lib as a devDependency of core (if missing), then connect
doconnect -nd lib core
```

## How it works

1. Loads `PROJECTS_DIR` from `.env` and validates it via LIVR.
2. Resolves every CLI arg against the subdirectories of `PROJECTS_DIR`,
   requiring exactly one fuzzy match per argument.
3. For each adjacent pair `(source, target)`:
   1. Reads the source's package name from `dist/package.json` (or root
      `package.json` as a fallback) and confirms it appears in the target's
      dependency tree. When `-n` is set (only allowed with exactly two
      project args), the entry is first added to `dependencies` or
      `devDependencies` (controlled by `-p` / `-d`, default `-p`) if it
      isn't already present.
4. Once everything validates, walks the chain:
   1. Runs `pnpm generate` in the source.
   2. Reads the freshly built `dist/package.json` to determine the package name.
   3. Rewrites every reference to that package in the target's `package.json`
      to `file:${PROJECTS_DIR}/<sourceDir>/dist`. References in
      `dependencies`, `devDependencies`, `overrides`, `pnpm.overrides`, and
      `resolutions` are all updated. If the target has a `pnpm-workspace.yaml`
      with the package listed under the top-level `overrides:` block, that
      entry is rewritten too (pnpm 10+ resolves workspace overrides before
      consulting `dependencies`, so missing this step makes the file: link a
      no-op).
   4. For every built package, finds matching virtual-store entries in the
      target at
      `node_modules/.pnpm/<scope>+<name>@file+...+dist_<peerhash>/node_modules/<scope>/<name>/`
      and overwrites them with a fresh copy of the source `dist/`. This
      sidesteps pnpm 11's lockfile-trust short-circuit for directory-type
      `file:` resolutions.
   5. Falls back to `pnpm i` in the target when any of the following holds:
      - `package.json` actually changed in step 3 (`needsUpdate`).
      - A built package referenced in the target isn't yet present in the
        virtual store (first-time link).
      - The source's `dependencies` / `peerDependencies` /
        `optionalDependencies` differ from the previously injected copy
        (the sibling wiring inside the virtual-store entry is stale).
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
