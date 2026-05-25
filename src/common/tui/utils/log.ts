/**
 * Local shim for claude-code-src's `src/utils/log.ts`. The vendored Ink engine
 * only consumes `logError`. Writing to stderr mid-render would corrupt the live
 * UI, so this is a no-op; the high-level logging API owns real error reporting.
 */

/** No-op error sink for the vendored engine (intentionally silent). */
export const logError = (_error: unknown): void => {};
