/**
 * Cursor position/visibility carried on each rendered {@link Frame}. The
 * original fork file was not vendored; this restores the type from its usage
 * (constructed in renderer.ts/frame.ts, read in the diff/output path).
 */

export type Cursor = {
  readonly x: number;
  readonly y: number;
  readonly visible: boolean;
};
