/**
 * Local shim for claude-code-src's `src/utils/env.ts`. The vendored Ink engine
 * only reads `env.terminal` (used for extended-keyboard detection, which this
 * stripped build never wires). `undefined` keeps that detection disabled.
 */

interface InkEnv {
  /** Detected terminal program name; unused in this build. */
  readonly terminal: string | undefined;
}

/** Minimal env surface consumed by the vendored engine. */
export const env: InkEnv = {
  terminal: undefined,
};
