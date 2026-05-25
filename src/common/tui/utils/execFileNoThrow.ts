/**
 * Local shim for claude-code-src's `src/utils/execFileNoThrow.ts`. The vendored
 * engine only calls this from OSC clipboard/tmux helpers (setClipboard,
 * tab-status detection) that this non-interactive build never triggers. The
 * stub reports a non-zero exit so any capability probe treats the feature as
 * unavailable, and never spawns a subprocess.
 */

interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** No-op subprocess runner: always reports "unavailable" without spawning. */
export const execFileNoThrow = async (
  _file: string,
  _args: string[],
  _options?: Record<string, unknown>,
): Promise<ExecResult> => ({ code: 1, stdout: '', stderr: '' });
