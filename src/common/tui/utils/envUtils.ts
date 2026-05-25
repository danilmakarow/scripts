/**
 * Local shim for claude-code-src's `src/utils/envUtils.ts`. The vendored Ink
 * engine only consumes `isEnvTruthy` (faithful copy of the original).
 */

/** Returns true when an env-var-like value represents an enabled flag. */
export const isEnvTruthy = (envVar: string | boolean | undefined): boolean => {
  if (!envVar) return false;
  if (typeof envVar === 'boolean') return envVar;
  return ['1', 'true', 'yes', 'on'].includes(envVar.toLowerCase().trim());
};
