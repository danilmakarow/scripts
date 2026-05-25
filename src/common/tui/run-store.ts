/**
 * Framework-agnostic state for a single script run. The Ink dashboard reads it
 * via `subscribe`/`getSnapshot` (useSyncExternalStore), and the imperative
 * script-facing API ({@link RunStore} methods) mutates it. Every mutation
 * swaps in a fresh immutable snapshot so subscribers re-render predictably.
 */

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
export type StepStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';
export type ProcessStatus = 'running' | 'done' | 'failed';
export type RunStatus = 'running' | 'success' | 'failure';
export type LogLevel = 'info' | 'success' | 'warning' | 'error' | 'step';

export interface StepState {
  readonly id: number;
  /** Label shown while pending/active/failed (e.g. "Compiling X"). */
  readonly label: string;
  /** Optional label shown once done (e.g. "Compiled X"). */
  readonly doneLabel?: string;
  readonly status: StepStatus;
  readonly startedAt?: number;
  readonly endedAt?: number;
}

/** A step to add: an in-progress label and an optional completed label. */
export interface StepSpec {
  readonly label: string;
  readonly doneLabel?: string;
}

export interface ProcessState {
  readonly id: number;
  readonly command: string;
  readonly label: string;
  readonly status: ProcessStatus;
  readonly lines: readonly string[];
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly exitCode?: number;
}

export interface LogEntry {
  readonly id: number;
  readonly level: LogLevel;
  readonly message: string;
}

export interface RunSnapshot {
  readonly name: string;
  readonly subtitle?: string;
  readonly startedAt: number;
  readonly status: RunStatus;
  readonly steps: readonly StepState[];
  readonly processes: readonly ProcessState[];
  readonly logs: readonly LogEntry[];
}

/** Max number of streamed output lines kept per process for the live window. */
const PROCESS_TAIL_LINES = 8;

// ─────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────
/** Mutable run state with an immutable snapshot for React subscribers. */
export class RunStore {
  private nextId = 1;
  private listeners = new Set<() => void>();
  private snapshot: RunSnapshot;

  constructor(name: string, subtitle?: string) {
    this.snapshot = {
      name,
      subtitle,
      startedAt: Date.now(),
      status: 'running',
      steps: [],
      processes: [],
      logs: [],
    };
  }

  /** Registers a subscriber; returns an unsubscribe function. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Returns the current immutable snapshot (stable ref between mutations). */
  readonly getSnapshot = (): RunSnapshot => this.snapshot;

  /** Replaces the snapshot and notifies subscribers. */
  private commit = (patch: Partial<RunSnapshot>): void => {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  };

  /** Adds steps (all pending). Returns their ids. */
  addSteps = (specs: readonly StepSpec[]): number[] => {
    const created = specs.map((spec) => ({
      id: this.nextId++,
      label: spec.label,
      doneLabel: spec.doneLabel,
      status: 'pending' as StepStatus,
    }));
    this.commit({ steps: [...this.snapshot.steps, ...created] });
    return created.map((step) => step.id);
  };

  /** Marks a step active (and the previously active step done). */
  startStep = (id: number): void => {
    const now = Date.now();
    this.commit({
      steps: this.snapshot.steps.map((step) => {
        if (step.id === id) return { ...step, status: 'active', startedAt: now };
        if (step.status === 'active') return { ...step, status: 'done', endedAt: now };
        return step;
      }),
    });
  };

  /** Marks a step finished with the given terminal status. */
  finishStep = (id: number, status: 'done' | 'failed' | 'skipped' = 'done'): void => {
    const now = Date.now();
    this.commit({
      steps: this.snapshot.steps.map((step) =>
        step.id === id ? { ...step, status, endedAt: now } : step,
      ),
    });
  };

  /** Adds a running process window and returns its id. */
  startProcess = (command: string, label: string): number => {
    const id = this.nextId++;
    this.commit({
      processes: [
        ...this.snapshot.processes,
        { id, command, label, status: 'running', lines: [], startedAt: Date.now() },
      ],
    });
    return id;
  };

  /** Appends one streamed output line to a process (keeps a bounded tail). */
  appendProcessLine = (id: number, line: string): void => {
    this.commit({
      processes: this.snapshot.processes.map((proc) => {
        if (proc.id !== id) return proc;
        const lines = [...proc.lines, line].slice(-PROCESS_TAIL_LINES);
        return { ...proc, lines };
      }),
    });
  };

  /** Marks a process finished with its exit code. */
  finishProcess = (id: number, exitCode: number): void => {
    const now = Date.now();
    this.commit({
      processes: this.snapshot.processes.map((proc) =>
        proc.id === id
          ? { ...proc, status: exitCode === 0 ? 'done' : 'failed', endedAt: now, exitCode }
          : proc,
      ),
    });
  };

  /** Appends a one-shot log line to the run. */
  log = (level: LogLevel, message: string): void => {
    this.commit({
      logs: [...this.snapshot.logs, { id: this.nextId++, level, message }],
    });
  };

  /** Sets the overall run status (used right before teardown). */
  setStatus = (status: RunStatus): void => {
    this.commit({ status });
  };
}
