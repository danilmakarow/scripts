/**
 * Local shim for claude-code-src's `src/utils/debug.ts`. The vendored Ink
 * engine only consumes `logForDebugging`; here it is a no-op so engine-internal
 * debug logging never corrupts the live terminal UI.
 */

type DebugLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** No-op debug sink for the vendored engine (intentionally silent). */
export const logForDebugging = (
  _message: string,
  _options?: { level?: DebugLogLevel },
): void => {};
