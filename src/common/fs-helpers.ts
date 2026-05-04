/**
 * Small filesystem helpers used by `do-*` scripts: directory listings and
 * typed JSON read/write.
 */

import fs from 'node:fs';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────
/** Returns the names of all immediate subdirectories of `dirPath`. */
export const getDirectories = (dirPath: string): string[] => {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    throw new Error(`Cannot read directory: ${dirPath}`);
  }
};

/** Reads `filePath` as UTF-8 JSON and returns it parsed as `T`. */
export const readJson = <T>(filePath: string): T => {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as T;
};

/**
 * Writes `data` to `filePath` as pretty-printed JSON (2-space indent) with a
 * trailing newline.
 */
export const writeJson = (filePath: string, data: unknown): void => {
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(filePath, serialized, 'utf-8');
};

/** Returns true if `filePath` exists on disk (file or directory). */
export const pathExists = (filePath: string): boolean => fs.existsSync(filePath);
