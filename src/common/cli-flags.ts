/**
 * Shared parsing for the global `-d` / `--debug` flag, which opts a run's
 * report into showing the finalizing `log.*` lines (hidden by default).
 *
 * The flag is consumed — spliced out of `process.argv` before each script
 * parses its own arguments — so it never collides with a script's positional
 * args or short flags. Only an exact standalone `-d` token is removed, so
 * doconnect's combined `-nd` (devDependencies) is left untouched.
 */

let consumed = false;
let debugEnabled = false;

/**
 * Removes any standalone `-d` / `--debug` token from `process.argv` and reports
 * whether one was present. Memoized: the first call (from a script's `main`,
 * before its own arg parsing) strips and records the result; later calls (e.g.
 * from `runScript`) return that same value.
 */
export const consumeDebugFlag = (): boolean => {
  if (consumed) return debugEnabled;
  consumed = true;

  const kept = process.argv.filter((arg) => arg !== '-d' && arg !== '--debug');
  debugEnabled = kept.length !== process.argv.length;
  if (debugEnabled) process.argv.splice(0, process.argv.length, ...kept);

  return debugEnabled;
};
