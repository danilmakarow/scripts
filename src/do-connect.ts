#!/usr/bin/env node
/**
 * doconnect — chains local pnpm packages together for cross-repo development.
 *
 * Builds each source package and rewires the next package's `package.json`
 * (dependencies / devDependencies / overrides / pnpm.overrides / resolutions)
 * to point at the freshly built `dist/` via a `file:` link. When the link is
 * already correct, the freshly built `dist/` is copied directly over the
 * target's pnpm virtual-store snapshot at
 * `node_modules/.pnpm/<entry>/node_modules/<pkg>/`, bypassing `pnpm i`.
 * pnpm 11 short-circuits a plain `pnpm i` for `type: directory` `file:`
 * deps (the lockfile has no integrity hash to invalidate). Falls back to
 * `pnpm i` on initial wiring, when the package isn't yet in the store, or
 * when the source's dependency set changed.
 *
 * Usage:
 *   doconnect [-n[p|d]] <project1> <project2> [project3...]
 *
 * The first argument is a fuzzy partial; each subsequent argument is the
 * target the previous one is wired into. Names are resolved against the
 * subdirectories of `PROJECTS_DIR` (loaded from `.env`).
 *
 * Flags (only valid with exactly two project arguments):
 *   -n  Add the source package as a dependency of the target if it isn't
 *       already declared. Without `-n`, a missing dep is a hard error.
 *   -p  When adding (`-n`), declare it under `dependencies` (default).
 *   -d  When adding (`-n`), declare it under `devDependencies`.
 *
 * Flags can be combined: `doconnect -nd lib core` is `-n -d`.
 */

import fs from 'node:fs';
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
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  resolutions?: Record<string, string>;
  pnpm?: {
    overrides?: Record<string, string>;
  };
  [key: string]: unknown;
}

interface RefreshResult {
  readonly refreshed: string[];
  readonly depsChanged: boolean;
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

type DependencySection = 'dependencies' | 'devDependencies';

interface ParsedArgs {
  readonly addIfMissing: boolean;
  readonly depSection: DependencySection;
  readonly positional: readonly string[];
}

// ─────────────────────────────────────────────────────────────
// Env validation
// ─────────────────────────────────────────────────────────────
const env = validateEnv<AppEnv>({
  PROJECTS_DIR: ['required', 'string', { min_length: 1 }],
});

const PROJECTS_DIR = env.PROJECTS_DIR;

// ─────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────
/**
 * Parses raw CLI args into positional project names and short flags.
 * Supports combined short flags (e.g. `-nd` ≡ `-n -d`). Throws on unknown
 * flags or on mutually exclusive `-p` + `-d`. `-p` / `-d` without `-n` is
 * rejected because dep-section selection is only meaningful when adding.
 */
const parseArgs = (args: readonly string[]): ParsedArgs => {
  let addIfMissing = false;
  let productionFlag = false;
  let devFlag = false;
  const positional: string[] = [];

  for (const arg of args) {
    const isShortFlag = arg.startsWith('-') && !arg.startsWith('--') && arg.length > 1;
    if (!isShortFlag) {
      positional.push(arg);
      continue;
    }

    for (const char of arg.slice(1)) {
      if (char === 'n') addIfMissing = true;
      else if (char === 'p') productionFlag = true;
      else if (char === 'd') devFlag = true;
      else throw new Error(`Unknown flag: -${char}`);
    }
  }

  if (productionFlag && devFlag) {
    throw new Error('Cannot specify both -p and -d');
  }
  if ((productionFlag || devFlag) && !addIfMissing) {
    throw new Error('-p / -d only apply together with -n');
  }

  return {
    addIfMissing,
    depSection: devFlag ? 'devDependencies' : 'dependencies',
    positional,
  };
};

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

/**
 * Adds `packageName` to the target's `package.json` under `depSection` if it
 * isn't already present in `dependencies` or `devDependencies`. The entry is
 * written directly as the expected `file:` link so the subsequent rewire
 * step finds it already correct. Returns true when the file was modified.
 */
const ensureDependencyEntry = (
  packageName: string,
  sourceDir: string,
  targetDir: string,
  targetPath: string,
  depSection: DependencySection,
): boolean => {
  const targetPkgPath = path.join(targetPath, 'package.json');
  if (!pathExists(targetPkgPath)) {
    throw new Error(`package.json not found in ${targetDir}`);
  }

  const targetPkg = readJson<PackageJson>(targetPkgPath);
  const alreadyPresent =
    targetPkg.dependencies?.[packageName] !== undefined ||
    targetPkg.devDependencies?.[packageName] !== undefined;
  if (alreadyPresent) return false;

  const expectedLink = `file:${path.join(PROJECTS_DIR, sourceDir, 'dist')}`;
  if (depSection === 'dependencies') {
    if (!targetPkg.dependencies) targetPkg.dependencies = {};
    targetPkg.dependencies[packageName] = expectedLink;
  } else {
    if (!targetPkg.devDependencies) targetPkg.devDependencies = {};
    targetPkg.devDependencies[packageName] = expectedLink;
  }

  writeJson(targetPkgPath, targetPkg);
  log.success(`Added ${packageName} to ${depSection} in ${targetDir}/package.json`);
  return true;
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
// pnpm-workspace.yaml overrides
// ─────────────────────────────────────────────────────────────
/**
 * In pnpm 10+, workspace-wide overrides live in `pnpm-workspace.yaml`'s
 * top-level `overrides:` block (the pnpm 9 location was `pnpm.overrides`
 * in `package.json`). These take precedence over `dependencies`, so if a
 * package is overridden there and we don't also rewrite the override, pnpm
 * ignores our `file:` link and resolves to whatever the override says
 * (e.g. `latest` → the registry tag).
 *
 * Performs an in-place line-by-line edit so we don't reformat the file or
 * introduce a YAML parser dependency. Only entries inside the top-level
 * `overrides:` block are touched.
 *
 * Returns true if any line was rewritten.
 */
const rewireWorkspaceOverrides = (
  targetPath: string,
  builtPackages: readonly BuiltPackage[],
): boolean => {
  const yamlPath = path.join(targetPath, 'pnpm-workspace.yaml');
  if (!pathExists(yamlPath)) return false;

  const expectedLinks = new Map<string, string>();
  for (const built of builtPackages) {
    expectedLinks.set(
      built.packageName,
      `file:${path.join(PROJECTS_DIR, built.sourceDir, 'dist')}`,
    );
  }

  const original = fs.readFileSync(yamlPath, 'utf-8');
  const lines = original.split('\n');
  let currentSection: string | null = null;
  let didChange = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];

    const sectionMatch = line.match(/^([a-zA-Z_][\w-]*):\s*$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }

    if (currentSection !== 'overrides') continue;

    const entryMatch = line.match(
      /^(\s+)(?:'([^']+)'|"([^"]+)"|([^\s:]+))\s*:\s*(.+?)\s*$/,
    );
    if (!entryMatch) continue;

    const [, indent, singleQ, doubleQ, unquoted, rawValue] = entryMatch;
    const keyName = singleQ ?? doubleQ ?? unquoted;
    if (!keyName) continue;

    const expectedLink = expectedLinks.get(keyName);
    if (!expectedLink) continue;
    if (rawValue === `'${expectedLink}'` || rawValue === expectedLink) continue;

    log.warning(
      `${keyName} in pnpm-workspace.yaml overrides is "${rawValue}", updating to "${expectedLink}"`,
    );
    lines[lineIndex] = `${indent}'${keyName}': '${expectedLink}'`;
    didChange = true;
  }

  if (didChange) fs.writeFileSync(yamlPath, lines.join('\n'), 'utf-8');
  return didChange;
};

// ─────────────────────────────────────────────────────────────
// Virtual-store refresh
// ─────────────────────────────────────────────────────────────
/** Shallow equality for `Record<string, string>`, treating undefined as empty. */
const recordsEqual = (
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean => {
  const leftKeys = Object.keys(left ?? {});
  const rightKeys = Object.keys(right ?? {});
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if ((left ?? {})[key] !== (right ?? {})[key]) return false;
  }
  return true;
};

/** True iff source vs. injected agree on dependencies / peer / optional sets. */
const dependenciesMatch = (source: PackageJson, injected: PackageJson): boolean =>
  recordsEqual(source.dependencies, injected.dependencies) &&
  recordsEqual(source.peerDependencies, injected.peerDependencies) &&
  recordsEqual(source.optionalDependencies, injected.optionalDependencies);

/**
 * Replaces every matching snapshot of `packageName` inside the target's pnpm
 * virtual store with the freshly built `dist/`. Each match lives at
 * `node_modules/.pnpm/<scope>+<name>@file+...+dist_<peerhash>/node_modules/<packageName>/`;
 * there can be more than one when the package is resolved with different
 * peer-dep combinations.
 *
 * Returns the list of refreshed entries plus whether the source's runtime
 * dependency set drifted from any injected copy — the caller uses that to
 * decide whether the virtual store wiring still matches and a `pnpm i` is
 * needed.
 */
const refreshInjectedPackage = (
  targetPath: string,
  packageName: string,
  sourceDistPath: string,
): RefreshResult => {
  const virtualStoreDir = path.join(targetPath, 'node_modules', '.pnpm');
  if (!pathExists(virtualStoreDir)) return { refreshed: [], depsChanged: false };

  const entryPrefix = `${packageName.replace('/', '+')}@file+`;
  const matchingEntries = fs
    .readdirSync(virtualStoreDir)
    .filter((entry) => entry.startsWith(entryPrefix));
  if (matchingEntries.length === 0) return { refreshed: [], depsChanged: false };

  const sourcePkgPath = path.join(sourceDistPath, 'package.json');
  const sourcePkg = pathExists(sourcePkgPath) ? readJson<PackageJson>(sourcePkgPath) : null;

  const refreshed: string[] = [];
  let depsChanged = false;

  for (const entry of matchingEntries) {
    const injectedPath = path.join(virtualStoreDir, entry, 'node_modules', packageName);
    if (!pathExists(injectedPath)) continue;

    if (sourcePkg) {
      const injectedPkgPath = path.join(injectedPath, 'package.json');
      if (pathExists(injectedPkgPath)) {
        const injectedPkg = readJson<PackageJson>(injectedPkgPath);
        if (!dependenciesMatch(sourcePkg, injectedPkg)) depsChanged = true;
      }
    }

    fs.rmSync(injectedPath, { recursive: true, force: true });
    fs.cpSync(sourceDistPath, injectedPath, { recursive: true });
    refreshed.push(entry);
  }

  return { refreshed, depsChanged };
};

// ─────────────────────────────────────────────────────────────
// Usage banner
// ─────────────────────────────────────────────────────────────
/** Prints the doconnect usage banner. */
const showUsage = (): void => {
  printUsage({
    title: 'doconnect',
    description: 'Connect local pnpm packages by chaining file: links',
    usage: 'doconnect [-n[p|d]] <project1> <project2> [project3...]',
    examples: [
      { command: 'doconnect fintech360 core' },
      { command: 'doconnect lib core app', comment: '# chain: lib→core, then core→app' },
      { command: 'doconnect -n lib core', comment: '# add lib to core deps if missing' },
      { command: 'doconnect -nd lib core', comment: '# add lib to core devDeps if missing' },
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
  const { addIfMissing, depSection, positional } = parseArgs(process.argv.slice(2));

  if (positional.length < 2) {
    showUsage();
    process.exit(1);
  }

  if (addIfMissing && positional.length !== 2) {
    throw new Error('-n requires exactly two project arguments');
  }

  const directories = getDirectories(PROJECTS_DIR);

  // ── Phase 1: Resolve all directories ──
  const resolvedDirs = positional.map((arg) => matchDirectory(arg, directories));

  // ── Phase 2: Validate all dependencies upfront ──
  const chain: ChainStep[] = [];
  for (let stepIndex = 0; stepIndex < resolvedDirs.length - 1; stepIndex += 1) {
    const sourceDir = resolvedDirs[stepIndex];
    const targetDir = resolvedDirs[stepIndex + 1];
    const sourcePath = path.join(PROJECTS_DIR, sourceDir);
    const targetPath = path.join(PROJECTS_DIR, targetDir);

    const packageName = getPackageName(sourcePath);

    if (addIfMissing) {
      ensureDependencyEntry(packageName, sourceDir, targetDir, targetPath, depSection);
    }

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

    // Also rewire `pnpm-workspace.yaml` overrides, since pnpm 10+ resolves
    // through workspace overrides before reading `dependencies`.
    const workspaceOverridesChanged = rewireWorkspaceOverrides(targetPath, builtPackages);
    if (workspaceOverridesChanged) {
      log.success(`Updated overrides in ${targetDir}/pnpm-workspace.yaml`);
    }

    // Refresh injected packages directly in the target's virtual store
    // instead of running `pnpm i`: pnpm 11 short-circuits installs for
    // `type: directory` `file:` resolutions because the lockfile has no
    // integrity hash to compare against. Falls back to `pnpm i` when
    // `package.json` actually changed, the package isn't in the store
    // yet (first-time link), or the source's dep set drifted.
    let installNeeded = needsUpdate || workspaceOverridesChanged;
    const refreshSummary: string[] = [];

    if (!installNeeded) {
      for (const built of builtPackages) {
        const sourceDistPath = path.join(PROJECTS_DIR, built.sourceDir, 'dist');
        const { refreshed, depsChanged } = refreshInjectedPackage(
          targetPath,
          built.packageName,
          sourceDistPath,
        );

        if (depsChanged) {
          log.warning(`${built.packageName}: source dependencies changed — running pnpm install`);
          installNeeded = true;
          break;
        }

        if (refreshed.length === 0 && cachesToClear.includes(built.sourceDir)) {
          log.warning(`${built.packageName}: not yet in virtual store — running pnpm install`);
          installNeeded = true;
          break;
        }

        if (refreshed.length > 0) {
          const suffix = refreshed.length > 1 ? ` (×${refreshed.length})` : '';
          refreshSummary.push(`${built.packageName}${suffix}`);
        }
      }
    }

    if (installNeeded) {
      await runCommand('pnpm i', {
        cwd: targetPath,
        description: `Installing dependencies in ${targetDir}`,
      });
    } else if (refreshSummary.length > 0) {
      log.success(`Refreshed in ${targetDir}: ${refreshSummary.join(', ')}`);
    }

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
