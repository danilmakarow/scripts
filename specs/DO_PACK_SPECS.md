# pack (build & install pipeline)

The `pack` script compiles every `src/do-*.ts` command into a self-contained
executable JS file inside `~/.local/bin/<dirname>` and refreshes a delimited
block in `~/.zshrc` so each command becomes a zsh alias.

It is the only mechanism for installing/refreshing the `do*` commands on the
user's machine.

## Usage

```bash
pnpm run pack
```

> NOTE: invoke as `pnpm run pack`, not `pnpm pack`. `pnpm pack` is a built-in
> pnpm command that creates an npm tarball, and it shadows custom scripts
> named `pack` when called without `run`.

The install dir name is **resolved from environment**, not from a CLI argument:

- If `SCRIPTS_PACK_DIR` is set (in `.env` or process env) and non-empty, that
  value is used.
- Otherwise the default `custom_scripts` is used.

The dir is always created under `~/.local/bin/` (i.e.
`~/.local/bin/<dirname>`), so the compiled bundles survive reboots and
`$TMPDIR` cleanup.

### Examples

```bash
# Default install location: ~/.local/bin/custom_scripts
pnpm run pack

# Override via .env
echo "SCRIPTS_PACK_DIR=scripts-dev" >> .env
pnpm run pack

# Override inline
SCRIPTS_PACK_DIR=experimental pnpm run pack
```

## What it does (step by step)

1. **Load `.env`** from the project root so `SCRIPTS_PACK_DIR` can be set
   there.
2. **Resolve the dir name** from `process.env.SCRIPTS_PACK_DIR` (trimmed),
   falling back to `custom_scripts`. Validates the resolved value via LIVR
   (consistent with `do-connect`'s env validation) — required, non-empty,
   ≤ 64 chars, matches `[A-Za-z0-9._-]+` — i.e. no slashes, spaces, shell
   metacharacters, or path traversal. A bad env value cannot escape the
   install root.
3. **Resolve the target dir** to `path.join(os.homedir(), '.local', 'bin', <dirname>)`.
4. **Clear the target dir** (`rm -rf` then `mkdir -p`) and verify it is empty
   afterwards. Refuses to continue if anything remains.
5. **Discover scripts** — reads `src/`, picks every regular file matching
   `do-*.ts`, and asserts each is a regular file. Fails clearly if zero
   scripts are found.
6. **Copy `.env`** from `<projectRoot>/.env` into the target dir. Throws if
   the source `.env` does not exist — env vars must be defined before pack
   so the installed binaries can locate them. Each `do-*` script's
   `loadEnv({ envPath: path.join(__dirname, '.env') })` resolves to the
   install dir at runtime, so this is what makes env vars work for the
   compiled bundles.
7. **Write a sibling `package.json`** declaring `{"type":"module"}` so the
   compiled `.js` files are loaded as ESM regardless of where they sit.
8. **Compile each script** with esbuild as a bundled, ESM, Node 20+ target,
   single self-contained `.js` file with a `#!/usr/bin/env node` shebang
   prepended (any source-level shebangs are deduplicated). The bundle gets
   a `createRequire(import.meta.url)` banner so bundled CJS dependencies
   that call `require()` (e.g. `cross-spawn` via `execa`) keep working.
   Output filename strips dashes from the source name —
   `src/do-connect.ts` → `<targetDir>/doconnect.js`.
9. **`chmod 0755`** every output file so it is directly executable.
10. **Refresh the `~/.zshrc` alias block.** See block format and idempotency
    sections below.
11. **Print a summary** with the install directory, every alias name and its
    path, and a reminder to `source ~/.zshrc`.

## `~/.zshrc` block format

The script manages a delimited block bounded by sentinel comments:

```
# >>> scripts pack: BEGIN <<<
alias docheckout="/Users/<you>/.local/bin/custom_scripts/docheckout.js"
alias docommit="/Users/<you>/.local/bin/custom_scripts/docommit.js"
alias doconnect="/Users/<you>/.local/bin/custom_scripts/doconnect.js"
alias domr="/Users/<you>/.local/bin/custom_scripts/domr.js"
# >>> scripts pack: END <<<
```

- One `alias` line per compiled script, in discovery order (alphabetical by
  source filename).
- The block is appended to the bottom of `~/.zshrc`, separated from the
  preceding content by exactly one blank line.
- Lines outside the sentinels are never touched.

## Idempotency guarantee

Running `pnpm run pack` is fully idempotent with respect to `~/.zshrc`:

- The script reads the entire file into memory.
- If a previous block (`BEGIN`/`END` sentinels) is found, it is removed —
  including the newline immediately preceding `BEGIN`, so re-running does not
  accumulate blank lines.
- A fresh block is then appended.
- The file is written atomically: contents go to a `.zshrc.pack.<pid>.tmp`
  alongside `~/.zshrc`, then `fs.rename` swaps it in place.

After N consecutive runs of `pack`, `~/.zshrc` contains exactly one block,
identical to the result of the first run.

The script also clears the target dir before writing, so re-running leaves no
stale `.js` files from previous packs.

## Error modes

| Condition | Behavior |
|-----------|----------|
| `SCRIPTS_PACK_DIR` set to an invalid value (empty after trim, too long, unsafe chars) | Print field error from LIVR + allowed-character hint + how to fix, exit 1 |
| Target dir cannot be cleaned/created | Throw with the underlying fs error, exit 1 |
| Target dir not empty after cleanup | Throw with target path, exit 1 |
| Zero `src/do-*.ts` files | Throw `No src/do-*.ts scripts found in <SRC_DIR>`, exit 1 |
| `<projectRoot>/.env` missing | Throw with the path and hint to copy `.env.example`, exit 1 |
| esbuild compile fails | Throw with esbuild error, exit 1 |
| Compiled output missing or empty after build | Throw with output path, exit 1 |
| `~/.zshrc` contains `BEGIN` sentinel without matching `END` | Refuse to edit, throw clear error, exit 1 |
| `~/.zshrc` does not exist | Treated as empty file; new file is created |
| Atomic write fails | Throw underlying fs error; original `~/.zshrc` is untouched (rename is atomic) |

All error paths print via the inline logger (red `✖` prefix), exit non-zero,
and never partially update `~/.zshrc` (write is atomic via tmp + rename).

## Implementation notes

- Source: `src/config/build.ts`.
- The script resolves `PROJECT_ROOT`/`SRC_DIR` relative to its own file via
  `import.meta.url`, so it works regardless of cwd.
- esbuild is configured with `bundle: true`, `platform: 'node'`,
  `target: 'node20'`, `format: 'esm'`, `packages: 'bundle'` so output is
  self-contained — only Node built-ins remain external.
- A sibling `package.json` with `{"type":"module"}` is written into the
  target dir before compiling so Node loads the `.js` bundles as ESM.
- Inline logger/theme mirror `do-connect.js`; will migrate to
  `src/common/logger.ts` later (TODO comment in source).
