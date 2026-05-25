/**
 * Ink components for the full-screen run dashboard: a header with the script
 * name + live elapsed timer, a step list with per-step status/spinner, and
 * bordered windows streaming the tail of each running subprocess (the
 * claude-code-src style). Driven by {@link RunStore}.
 */

import React, { useContext, useEffect, useState, useSyncExternalStore } from 'react';

import Box from './ink/components/Box.js';
import Text from './ink/components/Text.js';
import { TerminalSizeContext } from './ink/components/TerminalSizeContext.js';
import { splitFormatted } from './format.js';
import type {
  LogEntry,
  ProcessState,
  RunStore,
  StepState,
} from './run-store.js';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const TICK_MS = 90;

const COLOR = {
  cyan: 'ansi:cyan',
  green: 'ansi:green',
  red: 'ansi:red',
  yellow: 'ansi:yellow',
  gray: 'ansi:blackBright',
  white: 'ansi:white',
} as const;

const LOG_COLOR = {
  info: COLOR.cyan,
  success: COLOR.green,
  warning: COLOR.yellow,
  error: COLOR.red,
  step: COLOR.gray,
} as const;

// All width-1 glyphs. ✔/✖/⚠ measure as width 2 (emoji/East-Asian) but render
// as width 1 in terminals, which drifts the incremental diff's cursor math.
const LOG_GLYPH = {
  info: 'ℹ',
  success: '✓',
  warning: '▲',
  error: '✗',
  step: '→',
} as const;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
/** Formats a millisecond duration as `m:ss` (or `s.s` under a minute). */
const formatElapsed = (ms: number): string => {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

/**
 * Fixed-width elapsed string. A stable width keeps the timer's cells at the
 * same columns frame-to-frame, so digit-count changes can't reposition it and
 * leave stale digits behind (the cause of the "10x" artifact).
 */
const DURATION_WIDTH = 7;
const padDuration = (ms: number): string => formatElapsed(ms).padStart(DURATION_WIDTH);

/** Re-renders the subtree every {@link TICK_MS} so spinners/timers animate. */
const useTick = (): number => {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return tick;
};

/**
 * Renders a (possibly code-marked) string, highlighting code spans. Inline
 * `<Text>` children become virtual-text, so this stays a single text run.
 */
const Formatted = ({
  text,
  dim,
}: {
  text: string;
  dim?: boolean;
}): React.ReactElement => (
  <Text dim={dim ?? false}>
    {splitFormatted(text).map((segment, index) =>
      segment.code ? (
        <Text key={index} color={COLOR.cyan}>
          {segment.text}
        </Text>
      ) : (
        segment.text
      ),
    )}
  </Text>
);

// ─────────────────────────────────────────────────────────────
// Components
// ─────────────────────────────────────────────────────────────
/** Animated braille spinner; `frame` advances once per tick. */
const Spinner = ({ frame }: { frame: number }): React.ReactElement => (
  <Text color={COLOR.cyan}>{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}</Text>
);

/** Header line: script name (left) and live elapsed timer (right, fixed-width). */
const Header = ({
  name,
  subtitle,
  elapsedMs,
}: {
  name: string;
  subtitle?: string;
  elapsedMs: number;
}): React.ReactElement => (
  <Box flexDirection="column">
    <Box width="100%">
      <Box flexGrow={1}>
        <Text bold color={COLOR.cyan}>{` ${name} `}</Text>
      </Box>
      <Box flexShrink={0}>
        <Text dim>{`${padDuration(elapsedMs)} `}</Text>
      </Box>
    </Box>
    {subtitle ? <Formatted text={` ${subtitle}`} dim /> : null}
  </Box>
);

/** Single step row: status glyph + label + fixed-width duration. */
const StepRow = ({
  step,
  frame,
  now,
}: {
  step: StepState;
  frame: number;
  now: number;
}): React.ReactElement => {
  const label =
    step.status === 'done' && step.doneLabel ? step.doneLabel : step.label;
  const duration =
    step.startedAt !== undefined
      ? padDuration((step.endedAt ?? now) - step.startedAt)
      : ''.padStart(DURATION_WIDTH);
  return (
    <Box>
      <Box width={2}>
        {step.status === 'active' ? (
          <Spinner frame={frame} />
        ) : step.status === 'done' ? (
          <Text color={COLOR.green}>✓</Text>
        ) : step.status === 'failed' ? (
          <Text color={COLOR.red}>✗</Text>
        ) : step.status === 'skipped' ? (
          <Text dim>–</Text>
        ) : (
          <Text dim>○</Text>
        )}
      </Box>
      <Box flexGrow={1}>
        <Formatted text={label} dim={step.status === 'pending'} />
      </Box>
      <Box flexShrink={0}>
        <Text dim>{duration}</Text>
      </Box>
    </Box>
  );
};

/** Bordered window streaming the tail of one subprocess's output. */
const ProcessWindow = ({
  proc,
  frame,
  now,
}: {
  proc: ProcessState;
  frame: number;
  now: number;
}): React.ReactElement => {
  const borderColor =
    proc.status === 'running' ? COLOR.cyan : proc.status === 'done' ? COLOR.green : COLOR.red;
  const elapsed = padDuration((proc.endedAt ?? now) - proc.startedAt);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1}>
      <Box width="100%">
        <Box flexGrow={1}>
          {proc.status === 'running' ? (
            <Spinner frame={frame} />
          ) : proc.status === 'done' ? (
            <Text color={COLOR.green}>✓</Text>
          ) : (
            <Text color={COLOR.red}>✗</Text>
          )}
          <Formatted text={` ${proc.label}`} />
        </Box>
        <Box flexShrink={0}>
          <Text dim>{elapsed}</Text>
        </Box>
      </Box>
      {proc.lines.map((line, index) => (
        <Text key={index} dim wrap="truncate-end">
          {line.length > 0 ? line : ' '}
        </Text>
      ))}
    </Box>
  );
};

/** Recent one-shot log lines shown beneath the live area. */
const LogLine = ({ entry }: { entry: LogEntry }): React.ReactElement => (
  <Box>
    <Text color={LOG_COLOR[entry.level]}>{LOG_GLYPH[entry.level]}</Text>
    <Formatted text={` ${entry.message}`} />
  </Box>
);

/** Full-screen dashboard for the active run. */
export const Dashboard = ({ store }: { store: RunStore }): React.ReactElement => {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const frame = useTick();
  const now = Date.now();

  const size = useContext(TerminalSizeContext);
  const rows = size?.rows ?? 24;
  const columns = size?.columns ?? 80;

  const runningProcesses = snapshot.processes.filter((proc) => proc.status === 'running');
  const recentLogs = snapshot.logs.slice(-6);

  return (
    <Box flexDirection="column" width={columns} height={rows} paddingX={1}>
      <Header name={snapshot.name} subtitle={snapshot.subtitle} elapsedMs={now - snapshot.startedAt} />

      <Box flexDirection="column" marginTop={1}>
        {snapshot.steps.map((step) => (
          <StepRow key={step.id} step={step} frame={frame} now={now} />
        ))}
      </Box>

      <Box flexDirection="column" flexGrow={1} marginTop={runningProcesses.length > 0 ? 1 : 0}>
        {runningProcesses.map((proc) => (
          <ProcessWindow key={proc.id} proc={proc} frame={frame} now={now} />
        ))}
      </Box>

      {recentLogs.length > 0 ? (
        <Box flexDirection="column">
          {recentLogs.map((entry) => (
            <LogLine key={entry.id} entry={entry} />
          ))}
        </Box>
      ) : null}
    </Box>
  );
};
