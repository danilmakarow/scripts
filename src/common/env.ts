/**
 * Env loading + LIVR-based validation. Each script declares its own schema and
 * gets back a strongly-typed object, with a pretty error console rendering on
 * validation failure.
 */

import dotenv from 'dotenv';
import LIVR from 'livr';
import { log, theme } from './logger';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
export type LivrRules = Record<string, unknown>;

export type LivrErrors = Record<string, string | Record<string, unknown>>;

export interface LoadEnvOptions {
  /** Absolute path to a `.env` file to load before reading process.env. */
  readonly envPath?: string;
  /** Suppress dotenv's own console output. Defaults to true. */
  readonly quiet?: boolean;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
/** Loads variables from a `.env` file into `process.env`. */
export const loadEnv = (options: LoadEnvOptions = {}): void => {
  const { envPath, quiet = true } = options;
  if (envPath) {
    dotenv.config({ path: envPath, quiet });
    return;
  }
  dotenv.config({ quiet });
};

/** Renders a single LIVR error map as dim/warning bullets to the console. */
const renderErrors = (errors: unknown): void => {
  if (typeof errors === 'string') {
    console.log(`   ${theme.dim('•')} ${theme.warning(errors)}`);
    return;
  }
  if (errors === null || typeof errors !== 'object') {
    console.log(`   ${theme.dim('•')} ${theme.warning(String(errors))}`);
    return;
  }

  for (const [field, code] of Object.entries(errors as Record<string, unknown>)) {
    const message = typeof code === 'string' ? code : JSON.stringify(code);
    console.log(`   ${theme.dim('•')} ${theme.bold(field)}: ${theme.warning(message)}`);
  }
};

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────
/**
 * Validates an env (or arbitrary) object against a LIVR rule set, returning
 * the typed validated payload. On failure, prints a friendly error block
 * and exits the process with code 1.
 */
export const validateEnv = <T>(
  rules: LivrRules,
  source: Record<string, string | undefined> = process.env,
): T => {
  const validator = new LIVR.Validator<T>(rules);

  // Project to only the fields the schema cares about so unrelated env vars
  // don't surprise the validator.
  const projected: Record<string, string | undefined> = {};
  for (const key of Object.keys(rules)) {
    projected[key] = source[key];
  }

  const result = validator.validate(projected);
  if (result) return result;

  log.blank();
  log.error('Environment validation failed');
  console.log();
  renderErrors(validator.getErrors());
  console.log();
  console.log(
    `   ${theme.dim('Create a')} ${theme.highlight('.env')} ${theme.dim('file based on')} ${theme.highlight('.env.example')}`,
  );
  log.blank();
  process.exit(1);
};
