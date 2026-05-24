#!/usr/bin/env node
/**
 * pack/build pipeline.
 *
 * Compiles every `src/do-*.ts` script into a self-contained executable file
 * inside `~/.local/bin/<dirname>` and refreshes a delimited block in
 * `~/.zshrc` with one alias per script.
 *
 * Usage:
 *   pnpm pack <dirname>
 *
 * TODO: migrate inline styling/logger to `src/common/logger.ts` once that
 * module exists (Agent 2 is creating common/ in parallel).
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import LIVR from 'livr';
import chalk from 'chalk';
import dotenv from 'dotenv';

// ─────────────────────────────────────────────────────────────
// Theme & Logger (inline; migrate to src/common/logger.ts later)
// ─────────────────────────────────────────────────────────────
const theme = {
  success: chalk.green,
  error: chalk.red,
  warning: chalk.yellow,
  info: chalk.blue,
  dim: chalk.dim,
  bold: chalk.bold,
  highlight: chalk.cyan,
};

const symbols = {
  success: chalk.green('✔'),
  error: chalk.red('✖'),
  warning: chalk.yellow('⚠'),
  info: chalk.blue('ℹ'),
  arrow: chalk.dim('→'),
};

type LogFn = (message: string) => void;

interface Logger {
  readonly info: LogFn;
  readonly success: LogFn;
  readonly error: LogFn;
  readonly warning: LogFn;
  readonly step: LogFn;
  readonly blank: () => void;
}

const log: Logger = {
  info: (message) => console.log(`${symbols.info} ${message}`),
  success: (message) => console.log(`${symbols.success} ${theme.success(message)}`),
  error: (message) => console.error(`${symbols.error} ${theme.error(message)}`),
  warning: (message) => console.log(`${symbols.warning} ${theme.warning(message)}`),
  step: (message) => console.log(`${symbols.arrow} ${message}`),
  blank: () => console.log(),
};

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const BLOCK_BEGIN = '# >>> scripts pack: BEGIN <<<';
const BLOCK_END = '# >>> scripts pack: END <<<';
const SAFE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const SHEBANG = '#!/usr/bin/env node\n';
const PACK_DIR_ENV_VAR = 'SCRIPTS_PACK_DIR';
const DEFAULT_PACK_DIR = 'custom_scripts';

// ─────────────────────────────────────────────────────────────
// Paths (resolve relative to this file, regardless of cwd)
// ─────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');
const ZSHRC_PATH = path.join(os.homedir(), '.zshrc');

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
interface CompiledScript {
  readonly sourcePath: string;
  readonly aliasName: string;
  readonly outputPath: string;
}

interface LivrErrorMap {
  readonly [field: string]: string | LivrErrorMap;
}

// ─────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────
/**
 * Resolves the install dir name from `process.env[SCRIPTS_PACK_DIR_ENV_VAR]`,
 * falling back to `DEFAULT_PACK_DIR`. Validates the resolved value via LIVR
 * so a stray env value with unsafe characters can't escape the install root.
 */
const resolveDirName = (): string => {
  const envValue = process.env[PACK_DIR_ENV_VAR]?.trim();
  const candidate = envValue && envValue.length > 0 ? envValue : DEFAULT_PACK_DIR;

  const validator = new LIVR.Validator({
    dirname: [
      'required',
      'not_empty',
      'string',
      { min_length: 1 },
      { max_length: 64 },
      { like: SAFE_NAME_PATTERN.source },
    ],
  });

  const result = validator.validate({ dirname: candidate }) as { dirname: string } | false;
  if (result) return result.dirname;

  log.blank();
  log.error(`Invalid value for ${PACK_DIR_ENV_VAR}`);
  const errors = validator.getErrors() as LivrErrorMap | string | null;
  if (typeof errors === 'string') {
    console.log(`   ${theme.dim('•')} ${theme.warning(errors)}`);
  } else if (errors && typeof errors === 'object') {
    for (const [field, code] of Object.entries(errors)) {
      const message = typeof code === 'string' ? code : JSON.stringify(code);
      console.log(`   ${theme.dim('•')} ${theme.bold(field)}: ${theme.warning(message)}`);
    }
  }
  log.blank();
  console.log(theme.dim('   Allowed characters: letters, digits, dot, underscore, dash.'));
  console.log(theme.dim(`   Set ${PACK_DIR_ENV_VAR}=<name> in .env, or unset it to use the default.`));
  log.blank();
  process.exit(1);
};

// ─────────────────────────────────────────────────────────────
// Directory helpers
// ─────────────────────────────────────────────────────────────
/** Removes the target dir (if present), recreates it, and asserts it is empty. */
const prepareTargetDir = async (targetDir: string): Promise<void> => {
  await fsp.rm(targetDir, { recursive: true, force: true });
  await fsp.mkdir(targetDir, { recursive: true });

  const remaining = await fsp.readdir(targetDir);
  if (remaining.length !== 0) {
    throw new Error(`Target dir was not empty after cleanup: ${targetDir}`);
  }
};

/** Lists `do-*.ts` files in src/, asserts each is a regular file, returns absolute paths. */
const discoverScripts = async (): Promise<readonly string[]> => {
  const entries = await fsp.readdir(SRC_DIR, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith('do-') && entry.name.endsWith('.ts'))
    .map((entry) => path.join(SRC_DIR, entry.name));

  for (const candidate of candidates) {
    const stat = await fsp.stat(candidate);
    if (!stat.isFile()) {
      throw new Error(`Expected regular file but got non-file entry: ${candidate}`);
    }
  }

  if (candidates.length === 0) {
    throw new Error(`No src/do-*.ts scripts found in ${SRC_DIR}`);
  }

  return candidates;
};

/** Maps `src/do-foo-bar.ts` → output filename `dofoobar.js`. */
const aliasNameFor = (sourcePath: string): string => {
  const base = path.basename(sourcePath, '.ts'); // do-foo-bar
  return base.split('-').join('');
};

// ─────────────────────────────────────────────────────────────
// .env copy
// ─────────────────────────────────────────────────────────────
/**
 * Copies `<projectRoot>/.env` into the target dir so the installed scripts
 * can locate it via `path.join(__dirname, '.env')` after bundling. Throws if
 * the source `.env` is missing — the do-* scripts require it at runtime.
 */
const copyEnvFile = async (targetDir: string): Promise<void> => {
  if (!fs.existsSync(ENV_FILE)) {
    throw new Error(
      `.env not found at ${ENV_FILE}. Create it (copy .env.example) before running pack.`,
    );
  }
  await fsp.copyFile(ENV_FILE, path.join(targetDir, '.env'));
};

// ─────────────────────────────────────────────────────────────
// Compilation
// ─────────────────────────────────────────────────────────────
/** Bundles one TS entry into a single self-contained `.js` file with shebang. */
const compileScript = async (sourcePath: string, targetDir: string): Promise<CompiledScript> => {
  const aliasName = aliasNameFor(sourcePath);
  const outputPath = path.join(targetDir, `${aliasName}.js`);

  await esbuild.build({
    entryPoints: [sourcePath],
    bundle: true,
    platform: 'node',
    target: 'node20',
    // ESM so source-level `import.meta.url` keeps working. We pair this with
    // a sibling package.json declaring "type":"module" (written in main()).
    format: 'esm',
    outfile: outputPath,
    // Keep node built-ins external; bundle everything else for portability.
    packages: 'bundle',
    // Some bundled deps (e.g. cross-spawn via execa) emit CJS `require()`
    // calls that ESM Node refuses. The createRequire shim restores require()
    // inside the bundled module scope.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: 'silent',
    sourcemap: false,
    minify: false,
  });

  // De-dupe shebangs: source files start with `#!/usr/bin/env node` and we
  // want exactly one at the very top. Strip every leading shebang line, then
  // prepend exactly one.
  const compiled = await fsp.readFile(outputPath, 'utf-8');
  const withoutShebangs = compiled.replace(/^(#![^\n]*\n)+/, '');
  await fsp.writeFile(outputPath, `${SHEBANG}${withoutShebangs}`, { encoding: 'utf-8' });

  await fsp.chmod(outputPath, 0o755);

  const stat = await fsp.stat(outputPath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Compiled output missing or empty: ${outputPath}`);
  }

  return { sourcePath, aliasName, outputPath };
};

/** Writes a minimal package.json into the target dir declaring ESM module type. */
const writeTargetPackageJson = async (targetDir: string): Promise<void> => {
  const manifest = { type: 'module', private: true };
  const manifestPath = path.join(targetDir, 'package.json');
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf-8' });
};

// ─────────────────────────────────────────────────────────────
// .zshrc block management
// ─────────────────────────────────────────────────────────────
/** Strips a previously installed pack block (BEGIN/END sentinels) from raw text. */
const stripExistingBlock = (text: string): string => {
  const beginIndex = text.indexOf(BLOCK_BEGIN);
  if (beginIndex === -1) return text;

  const endMarkerIndex = text.indexOf(BLOCK_END, beginIndex);
  if (endMarkerIndex === -1) {
    throw new Error(
      `Found "${BLOCK_BEGIN}" in ~/.zshrc without matching "${BLOCK_END}" — refusing to edit.`,
    );
  }

  const endLineEnd = text.indexOf('\n', endMarkerIndex);
  const sliceEnd = endLineEnd === -1 ? text.length : endLineEnd + 1;

  // Also drop the newline immediately preceding the begin sentinel, if any,
  // to avoid leaving an extra blank line on each re-run.
  let sliceStart = beginIndex;
  if (sliceStart > 0 && text[sliceStart - 1] === '\n') sliceStart -= 1;

  return text.slice(0, sliceStart) + text.slice(sliceEnd);
};

/** Builds the alias block text for the given compiled scripts. */
const buildAliasBlock = (scripts: readonly CompiledScript[]): string => {
  const lines: string[] = [BLOCK_BEGIN];
  for (const script of scripts) {
    lines.push(`alias ${script.aliasName}="${script.outputPath}"`);
  }
  lines.push(BLOCK_END);
  return lines.join('\n') + '\n';
};

/** Atomically writes `content` to `targetPath` via tmp file + rename in same dir. */
const writeAtomic = async (targetPath: string, content: string): Promise<void> => {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.pack.${process.pid}.tmp`);
  await fsp.writeFile(tmpPath, content, { encoding: 'utf-8', mode: 0o644 });
  await fsp.rename(tmpPath, targetPath);
};

/** Reads ~/.zshrc, strips any existing pack block, appends fresh block, atomic write. */
const updateZshrc = async (scripts: readonly CompiledScript[]): Promise<void> => {
  let original = '';
  try {
    original = await fsp.readFile(ZSHRC_PATH, 'utf-8');
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT') throw error;
    // Fresh ~/.zshrc — start empty.
  }

  const stripped = stripExistingBlock(original);
  const trimmedTail = stripped.length > 0 && !stripped.endsWith('\n') ? `${stripped}\n` : stripped;
  const separator = trimmedTail.length > 0 && !trimmedTail.endsWith('\n\n') ? '\n' : '';
  const next = `${trimmedTail}${separator}${buildAliasBlock(scripts)}`;

  await writeAtomic(ZSHRC_PATH, next);
};

// ─────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────
/** Prints a friendly summary of installed scripts. */
const printSummary = (targetDir: string, scripts: readonly CompiledScript[]): void => {
  log.blank();
  console.log(theme.bold('  pack complete'));
  console.log(`  ${theme.dim('install dir:')} ${theme.highlight(targetDir)}`);
  log.blank();
  console.log(theme.dim('  installed aliases:'));
  for (const script of scripts) {
    console.log(`    ${symbols.arrow} ${theme.highlight(script.aliasName)}  ${theme.dim('→')}  ${script.outputPath}`);
  }
  log.blank();
  console.log(`  ${theme.warning('Reminder:')} run ${theme.highlight('source ~/.zshrc')} or open a new shell to pick up aliases.`);
  log.blank();
};

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
/** Entry point: resolves dir name, prepares dir, compiles scripts, updates ~/.zshrc. */
const main = async (): Promise<void> => {
  // Load .env from the project root so SCRIPTS_PACK_DIR can be configured there.
  dotenv.config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

  const dirname = resolveDirName();
  const targetDir = path.join(os.homedir(), '.local', 'bin', dirname);
  const dirSource = process.env[PACK_DIR_ENV_VAR]?.trim()
    ? `${PACK_DIR_ENV_VAR}=${dirname}`
    : `default "${dirname}"`;
  log.info(`Install dir name: ${theme.highlight(dirname)} ${theme.dim(`(${dirSource})`)}`);

  log.step(`Preparing target dir: ${theme.highlight(targetDir)}`);
  await prepareTargetDir(targetDir);

  log.step(`Discovering ${theme.highlight('src/do-*.ts')} scripts`);
  const sources = await discoverScripts();
  log.success(`Found ${sources.length} script${sources.length === 1 ? '' : 's'}`);

  log.step(`Copying ${theme.highlight('.env')} to target dir`);
  await copyEnvFile(targetDir);

  log.step('Compiling scripts');
  await writeTargetPackageJson(targetDir);
  const compiled: CompiledScript[] = [];
  for (const sourcePath of sources) {
    const result = await compileScript(sourcePath, targetDir);
    compiled.push(result);
    log.success(`compiled ${theme.highlight(path.basename(sourcePath))} → ${theme.dim(result.outputPath)}`);
  }

  log.step(`Updating ${theme.highlight('~/.zshrc')} alias block`);
  await updateZshrc(compiled);
  log.success('~/.zshrc updated');

  printSummary(targetDir, compiled);
};

main().catch((err: unknown) => {
  log.blank();
  const message = err instanceof Error ? err.message : String(err);
  log.error(message);
  if (err instanceof Error && err.stack) {
    console.error(theme.dim(err.stack.split('\n').slice(1, 4).join('\n')));
  }
  log.blank();
  process.exit(1);
});
