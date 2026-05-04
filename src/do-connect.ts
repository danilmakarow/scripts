#!/usr/bin/env node
/**
 * doconnect — chains local pnpm packages together for cross-repo development.
 *
 * Builds each source package and rewires the next package's `package.json`
 * (dependencies / devDependencies / overrides / pnpm.overrides / resolutions)
 * to point at the freshly built `dist/` via a `file:` link, then re-installs.
 *
 * Usage:
 *   doconnect <project1> <project2> [project3...]
 *
 * The first argument is a fuzzy partial; each subsequent argument is the
 * target the previous one is wired into. Names are resolved against the
 * subdirectories of `PROJECTS_DIR` (loaded from `.env`).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { log, symbols, theme } from './common/logger';
import { runCommand } from './common/command-runner';
import { loadEnv, validateEnv } from './common/env';
import { SuggestionError } from './common/errors';
import { getDirectories, pathExists, readJson, writeJson } from './common/fs-helpers';
import { printUsage } from './common/usage';

// ─────────────────────────────────────────────────────────────
// Bootstrap — load .env that sits next to the bundled script
// ─────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ envPath: path.join(__dirname, '.env') });

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
interface AppEnv {
  readonly PROJECTS_DIR: string;
}

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  resolutions?: Record<string, string>;
  pnpm?: {
    overrides?: Record<string, string>;
  };
  [key: string]: unknown;
}

interface ChainStep {
  readonly sourceDir: string;
  readonly targetDir: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly packageName: string;
}

interface BuiltPackage {
  readonly sourceDir: string;
  readonly packageName: string;
}

interface OverrideLocation {
  readonly label: string;
  readonly container: Record<string, Record<string, string> | undefined> | undefined;
  readonly key: string;
}

// ─────────────────────────────────────────────────────────────
// Env validation
// ─────────────────────────────────────────────────────────────
const env = validateEnv<AppEnv>({
  PROJECTS_DIR: ['required', 'string', { min_length: 1 }],
});

const PROJECTS_DIR = env.PROJECTS_DIR;

// ─────────────────────────────────────────────────────────────
// Directory resolution
// ─────────────────────────────────────────────────────────────
/** Resolves a fuzzy partial to a unique subdirectory of PROJECTS_DIR. */
const matchDirectory = (partial: string, directories: readonly string[]): string => {
  if (directories.includes(partial)) return partial;

  const matches = directories.filter((dir) => dir.includes(partial));
  if (matches.length === 0) {
    throw new SuggestionError(`No directory found matching "${partial}"`, {
      suggestionLabel: 'Available directories:',
      suggestions: directories,
    });
  }
  if (matches.length > 1) {
    throw new SuggestionError(`Multiple directories match "${partial}"`, {
      suggestionLabel: 'Matching directories:',
      suggestions: matches,
    });
  }

  return matches[0];
};

// ─────────────────────────────────────────────────────────────
// package.json helpers
// ─────────────────────────────────────────────────────────────
/** Reads `name` from dist/package.json or root package.json of a project dir. */
const getPackageName = (projectPath: string): string => {
  const distPkgPath = path.join(projectPath, 'dist', 'package.json');
  if (pathExists(distPkgPath)) {
    const distPkg = readJson<PackageJson>(distPkgPath);
    if (distPkg.name) return distPkg.name;
  }

  const rootPkgPath = path.join(projectPath, 'package.json');
  if (pathExists(rootPkgPath)) {
    const rootPkg = readJson<PackageJson>(rootPkgPath);
    if (rootPkg.name) return rootPkg.name;
  }

  throw new Error(`Could not determine package name for ${path.basename(projectPath)}`);
};

/** Asserts that `packageName` is referenced as a dep in target's package.json. */
const validateDependency = (packageName: string, targetDir: string, targetPath: string): void => {
  const targetPkgPath = path.join(targetPath, 'package.json');
  if (!pathExists(targetPkgPath)) {
    throw new Error(`package.json not found in ${targetDir}`);
  }

  const targetPkg = readJson<PackageJson>(targetPkgPath);
  const isInDeps = targetPkg.dependencies?.[packageName] !== undefined;
  const isInDevDeps = targetPkg.devDependencies?.[packageName] !== undefined;
  if (!isInDeps && !isInDevDeps) {
    throw new Error(`"${packageName}" is not a dependency in ${targetDir}/package.json`);
  }
};

/** Returns the dependency-section locations that may declare the package. */
const overrideLocationsFor = (targetPkg: PackageJson): OverrideLocation[] => [
  { label: 'overrides', container: targetPkg as Record<string, Record<string, string> | undefined>, key: 'overrides' },
  { label: 'pnpm.overrides', container: targetPkg.pnpm as Record<string, Record<string, string> | undefined> | undefined, key: 'overrides' },
  { label: 'resolutions', container: targetPkg as Record<string, Record<string, string> | undefined>, key: 'resolutions' },
];

/**
 * Updates every reference to each built package inside `targetPkg` to point
 * at the expected `file:` link. Mutates `targetPkg`. Returns whether the
 * package.json needs to be re-written and the list of source dirs whose
 * caches need clearing.
 */
const rewireTargetPkg = (
  targetPkg: PackageJson,
  builtPackages: readonly BuiltPackage[],
): { readonly needsUpdate: boolean; readonly cachesToClear: string[] } => {
  let needsUpdate = false;
  const cachesToClear: string[] = [];

  for (const built of builtPackages) {
    const expectedLink = `file:${path.join(PROJECTS_DIR, built.sourceDir, 'dist')}`;
    let foundInTarget = false;

    for (const section of ['dependencies', 'devDependencies'] as const) {
      const sectionPkg = targetPkg[section];
      if (sectionPkg && sectionPkg[built.packageName] !== undefined) {
        foundInTarget = true;
        if (sectionPkg[built.packageName] !== expectedLink) {
          log.warning(
            `${built.packageName} in ${section} is "${sectionPkg[built.packageName]}", updating to "${expectedLink}"`,
          );
          sectionPkg[built.packageName] = expectedLink;
          needsUpdate = true;
        }
        break;
      }
    }

    for (const { label, container, key } of overrideLocationsFor(targetPkg)) {
      const overrideMap = container?.[key];
      if (overrideMap && overrideMap[built.packageName] !== undefined) {
        foundInTarget = true;
        if (overrideMap[built.packageName] !== expectedLink) {
          log.warning(
            `${built.packageName} in ${label} is "${overrideMap[built.packageName]}", updating to "${expectedLink}"`,
          );
          overrideMap[built.packageName] = expectedLink;
          needsUpdate = true;
        }
      }
    }

    if (foundInTarget) cachesToClear.push(built.sourceDir);
  }

  return { needsUpdate, cachesToClear };
};

// ─────────────────────────────────────────────────────────────
// Usage banner
// ─────────────────────────────────────────────────────────────
/** Prints the doconnect usage banner. */
const showUsage = (): void => {
  printUsage({
    title: 'doconnect',
    description: 'Connect local pnpm packages by chaining file: links',
    usage: 'doconnect <project1> <project2> [project3...]',
    examples: [
      { command: 'doconnect fintech360 core' },
      { command: 'doconnect lib core app', comment: '# chain: lib→core, then core→app' },
    ],
    steps: [
      'Validate all folders and dependencies upfront',
      'For each pair: build source, update link, install in target',
    ],
  });
};

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
/** Entry point: resolves dirs, validates deps, then walks the chain. */
const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    showUsage();
    process.exit(1);
  }

  const directories = getDirectories(PROJECTS_DIR);

  // ── Phase 1: Resolve all directories ──
  const resolvedDirs = args.map((arg) => matchDirectory(arg, directories));

  // ── Phase 2: Validate all dependencies upfront ──
  const chain: ChainStep[] = [];
  for (let stepIndex = 0; stepIndex < resolvedDirs.length - 1; stepIndex += 1) {
    const sourceDir = resolvedDirs[stepIndex];
    const targetDir = resolvedDirs[stepIndex + 1];
    const sourcePath = path.join(PROJECTS_DIR, sourceDir);
    const targetPath = path.join(PROJECTS_DIR, targetDir);

    const packageName = getPackageName(sourcePath);
    validateDependency(packageName, targetDir, targetPath);

    chain.push({ sourceDir, targetDir, sourcePath, targetPath, packageName });
  }

  log.success('All directories and dependencies validated');

  // ── Phase 3: Execute chain ──
  log.blank();
  if (resolvedDirs.length === 2) {
    console.log(theme.bold('  Updating package'));
    console.log(`  ${theme.highlight(resolvedDirs[0])} ${symbols.arrow} ${theme.highlight(resolvedDirs[1])}`);
  } else {
    console.log(theme.bold('  Updating package chain'));
    console.log(`  ${resolvedDirs.map((dir) => theme.highlight(dir)).join(` ${symbols.arrow} `)}`);
  }
  log.blank();

  const builtPackages: BuiltPackage[] = [];

  for (let targetIndex = 1; targetIndex < resolvedDirs.length; targetIndex += 1) {
    const sourceDir = resolvedDirs[targetIndex - 1];
    const targetDir = resolvedDirs[targetIndex];
    const sourcePath = path.join(PROJECTS_DIR, sourceDir);
    const targetPath = path.join(PROJECTS_DIR, targetDir);

    if (resolvedDirs.length > 2) {
      const prefix = resolvedDirs.slice(0, targetIndex).join(', ');
      console.log(theme.bold(`  Step ${targetIndex}/${resolvedDirs.length - 1}: ${prefix} → ${targetDir}`));
      log.blank();
    }

    // Build the immediate source.
    await runCommand('pnpm generate', {
      cwd: sourcePath,
      description: `Building ${sourceDir}`,
    });

    // Read freshly built package name from dist/package.json.
    const sourceDistPkgPath = path.join(sourcePath, 'dist', 'package.json');
    if (!pathExists(sourceDistPkgPath)) {
      throw new Error(`Source dist/package.json not found at ${sourceDistPkgPath}. Did the build succeed?`);
    }

    const sourceDistPkg = readJson<PackageJson>(sourceDistPkgPath);
    const builtPackageName = sourceDistPkg.name;
    if (!builtPackageName) {
      throw new Error('Could not determine package name from source dist/package.json');
    }

    builtPackages.push({ sourceDir, packageName: builtPackageName });

    // Rewire the target's package.json to point at every built source.
    const targetPkgPath = path.join(targetPath, 'package.json');
    const targetPkg = readJson<PackageJson>(targetPkgPath);
    const { needsUpdate, cachesToClear } = rewireTargetPkg(targetPkg, builtPackages);

    if (needsUpdate) {
      writeJson(targetPkgPath, targetPkg);
      log.success(`Updated file links in ${targetDir}/package.json`);
    } else {
      log.success(`All links already correct in ${targetDir}/package.json`);
    }

    // Clear caches for matched packages so pnpm picks up fresh dist/.
    for (const dirToClear of cachesToClear) {
      await runCommand(`rm -rf node_modules/.pnpm/@pn+${dirToClear}* || true`, {
        cwd: targetPath,
        description: `Clearing cache for @pn/${dirToClear}`,
      });
    }

    // Re-install with the rewired links.
    await runCommand('pnpm i', {
      cwd: targetPath,
      description: `Installing dependencies in ${targetDir}`,
    });

    if (resolvedDirs.length > 2) {
      log.blank();
      log.success(`Completed: ${cachesToClear.join(', ')} → ${targetDir}`);
      log.blank();
    }
  }

  log.blank();
  if (chain.length === 1) {
    log.success(`Updated ${chain[0].sourceDir} → ${chain[0].targetDir}`);
  } else {
    log.success(`Chain complete: ${resolvedDirs.join(' → ')}`);
  }
  log.blank();
};

// ─────────────────────────────────────────────────────────────
// Error reporter
// ─────────────────────────────────────────────────────────────
main().catch((err: unknown) => {
  log.blank();
  const message = err instanceof Error ? err.message : String(err);
  log.error(message);

  if (SuggestionError.is(err)) {
    log.blank();
    console.log(theme.dim(`  ${err.suggestionLabel}`));
    for (const suggestion of err.suggestions) {
      console.log(`    ${theme.dim('•')} ${suggestion}`);
    }
  } else if (err instanceof Error && 'stderr' in err && typeof (err as { stderr?: unknown }).stderr === 'string') {
    const stderr = (err as { stderr: string }).stderr;
    if (stderr.trim().length > 0) {
      console.log();
      console.log(theme.dim('  Error details:'));
      stderr
        .split('\n')
        .slice(0, 5)
        .forEach((line) => {
          if (line.trim()) console.log(`    ${theme.dim(line)}`);
        });
    }
  }

  log.blank();
  process.exit(1);
});
