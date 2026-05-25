/**
 * Fresh, slimmed-down render() orchestrator for the vendored Ink engine.
 *
 * Replaces the fork's 1,722-line ink.tsx. It keeps only the frame loop —
 * build DOM via the reconciler, compute yoga layout, diff into a screen
 * buffer, write to the terminal — and the alternate-screen takeover.
 *
 * Deliberately omitted vs. the original: text selection, search highlight,
 * mouse/hit-testing, keyboard input, focus dispatch, raw-stdin handling,
 * console patching, the instances registry, and frame instrumentation. The
 * scripts drive a non-interactive dashboard, so none of that is wired.
 */

import React, { type ReactNode } from 'react';
import { ConcurrentRoot } from 'react-reconciler/constants.js';

import { FRAME_INTERVAL_MS } from './ink/constants.js';
import { createNode, type DOMElement } from './ink/dom.js';
import { FocusManager } from './ink/focus.js';
import { emptyFrame, type Frame } from './ink/frame.js';
import { LogUpdate } from './ink/log-update.js';
import { optimize } from './ink/optimizer.js';
import reconciler from './ink/reconciler.js';
import createRenderer, { type Renderer } from './ink/renderer.js';
import {
  CharPool,
  createScreen,
  HyperlinkPool,
  StylePool,
} from './ink/screen.js';
import {
  SYNC_OUTPUT_SUPPORTED,
  type Terminal,
  writeDiffToTerminal,
} from './ink/terminal.js';
import { CURSOR_HOME, cursorPosition, ERASE_SCREEN } from './ink/termio/csi.js';
import {
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
} from './ink/termio/dec.js';
import { TerminalSizeContext } from './ink/components/TerminalSizeContext.js';

// ─────────────────────────────────────────────────────────────
// Constants (mirrors of the frozen patch objects from the fork)
// ─────────────────────────────────────────────────────────────
const ALT_SCREEN_ANCHOR_CURSOR = Object.freeze({ x: 0, y: 0, visible: false });
const CURSOR_HOME_PATCH = Object.freeze({
  type: 'stdout' as const,
  content: CURSOR_HOME,
});
const ERASE_THEN_HOME_PATCH = Object.freeze({
  type: 'stdout' as const,
  content: ERASE_SCREEN + CURSOR_HOME,
});

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
export interface RenderOptions {
  /** Output stream to render to. Defaults to `process.stdout`. */
  readonly stdout?: NodeJS.WriteStream;
  /** Take over the alternate screen buffer (full-screen). Defaults to true. */
  readonly altScreen?: boolean;
}

export interface RenderInstance {
  /** Re-render the tree with a new root node. */
  readonly rerender: (node: ReactNode) => void;
  /** Tear down the UI, restore the terminal, and resolve {@link waitUntilExit}. */
  readonly unmount: (error?: Error) => void;
  /** Resolves once {@link unmount} runs (or rejects if it was passed an error). */
  readonly waitUntilExit: () => Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
/** Leading + trailing throttle, used to cap re-render frequency at one frame. */
const throttle = (fn: () => void, waitMs: number): (() => void) => {
  let lastRun = 0;
  let timer: NodeJS.Timeout | null = null;
  const run = (): void => {
    lastRun = Date.now();
    timer = null;
    fn();
  };
  return () => {
    const elapsed = Date.now() - lastRun;
    if (elapsed >= waitMs) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      run();
    } else if (!timer) {
      timer = setTimeout(run, waitMs - elapsed);
    }
  };
};

/** Minimal root component: exposes terminal size to children via context. */
const RootApp = ({
  columns,
  rows,
  children,
}: {
  columns: number;
  rows: number;
  children?: ReactNode;
}): React.ReactElement => (
  <TerminalSizeContext.Provider value={{ columns, rows }}>
    {children}
  </TerminalSizeContext.Provider>
);

// ─────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────
/** Drives the reconciler + renderer for one terminal output stream. */
class InkInstance {
  private readonly stdout: NodeJS.WriteStream;
  private readonly terminal: Terminal;
  private readonly stylePool: StylePool;
  private readonly charPool: CharPool;
  private readonly hyperlinkPool: HyperlinkPool;
  private readonly rootNode: DOMElement;
  private readonly renderer: Renderer;
  private readonly container: unknown;
  private readonly logUpdate: LogUpdate;
  private readonly scheduleRender: () => void;

  private terminalColumns: number;
  private terminalRows: number;
  private frontFrame: Frame;
  private backFrame: Frame;
  private altScreenActive: boolean;
  private prevFrameContaminated = false;
  private needsEraseBeforePaint = false;
  private isUnmounted = false;
  private currentNode: ReactNode = null;

  private resolveExit: () => void = () => {};
  private rejectExit: (error: Error) => void = () => {};
  private readonly exitPromise: Promise<void>;

  constructor(options: RenderOptions) {
    this.stdout = options.stdout ?? process.stdout;
    this.altScreenActive = (options.altScreen ?? true) && Boolean(this.stdout.isTTY);
    this.terminal = { stdout: this.stdout, stderr: process.stderr };
    this.terminalColumns = this.stdout.columns || 80;
    this.terminalRows = this.stdout.rows || 24;
    this.stylePool = new StylePool();
    this.charPool = new CharPool();
    this.hyperlinkPool = new HyperlinkPool();
    this.frontFrame = this.makeEmptyFrame();
    this.backFrame = this.makeEmptyFrame();
    this.exitPromise = new Promise<void>((resolve, reject) => {
      this.resolveExit = resolve;
      this.rejectExit = reject;
    });

    this.logUpdate = new LogUpdate({
      isTTY: Boolean(this.stdout.isTTY),
      stylePool: this.stylePool,
    });

    // Defer onRender to a microtask so React layout effects commit first; the
    // throttle (leading + trailing) caps repaints at one terminal frame.
    this.scheduleRender = throttle(
      () => queueMicrotask(this.onRender),
      FRAME_INTERVAL_MS,
    );

    this.rootNode = createNode('ink-root');
    this.rootNode.focusManager = new FocusManager(() => false);
    this.renderer = createRenderer(this.rootNode, this.stylePool);
    this.rootNode.onRender = this.scheduleRender;
    this.rootNode.onImmediateRender = this.onRender;
    this.rootNode.onComputeLayout = this.onComputeLayout;

    this.container = reconciler.createContainer(
      this.rootNode,
      ConcurrentRoot,
      null,
      false,
      null,
      'id',
      () => {},
      () => {},
      () => {},
      () => {},
    );

    if (this.stdout.isTTY) {
      this.stdout.on('resize', this.handleResize);
    }
    process.once('exit', this.handleProcessExit);

    if (this.altScreenActive) {
      this.stdout.write(ENTER_ALT_SCREEN + ERASE_SCREEN + CURSOR_HOME + HIDE_CURSOR);
      this.resetFramesForAltScreen();
    }
  }

  /** Builds a blank frame sized to the current terminal. */
  private makeEmptyFrame = (): Frame =>
    emptyFrame(
      this.terminalRows,
      this.terminalColumns,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    );

  /** Recomputes yoga layout during React's commit phase. */
  private onComputeLayout = (): void => {
    if (this.isUnmounted || !this.rootNode.yogaNode) return;
    this.rootNode.yogaNode.setWidth(this.terminalColumns);
    this.rootNode.yogaNode.calculateLayout(this.terminalColumns);
  };

  /** Resets both frame buffers to blank alt-screen-sized frames. */
  private resetFramesForAltScreen = (): void => {
    const blank = (): Frame => ({
      screen: createScreen(
        this.terminalColumns,
        this.terminalRows,
        this.stylePool,
        this.charPool,
        this.hyperlinkPool,
      ),
      viewport: { width: this.terminalColumns, height: this.terminalRows + 1 },
      cursor: { x: 0, y: 0, visible: true },
    });
    this.frontFrame = blank();
    this.backFrame = blank();
    this.logUpdate.reset();
    this.prevFrameContaminated = true;
  };

  /** Produces one frame, diffs it, and writes the patches to the terminal. */
  private onRender = (): void => {
    if (this.isUnmounted) return;

    const terminalWidth = this.stdout.columns || 80;
    const terminalRows = this.stdout.rows || 24;
    const frame = this.renderer({
      frontFrame: this.frontFrame,
      backFrame: this.backFrame,
      isTTY: Boolean(this.stdout.isTTY),
      terminalWidth,
      terminalRows,
      altScreen: this.altScreenActive,
      // Always treat the previous screen as unsafe to blit from: the engine's
      // per-node dirty tracking misses in-place Text content changes, so
      // blitting copies stale characters. Re-rendering fresh each frame is
      // cheap at CLI sizes and guarantees correct output.
      prevFrameContaminated: true,
    });

    // Force full-screen damage every frame. Per-node damage tracking misses
    // in-place Text content changes (a step's label swapping active→done, or
    // duration digits changing), leaving stale/garbled characters and inflated
    // timers. Full damage makes the diff COMPARE every cell; it still only
    // WRITES the cells that actually changed, so there's no flicker — just a
    // cheap full compare (~cols×rows) per frame, which is negligible here.
    frame.screen.damage = {
      x: 0,
      y: 0,
      width: frame.screen.width,
      height: frame.screen.height,
    };

    // Alt-screen: anchor the physical cursor to (0,0) before every diff so the
    // relative cursor moves can't drift if the emulator perturbs the cursor.
    let prevFrame = this.frontFrame;
    if (this.altScreenActive) {
      prevFrame = { ...this.frontFrame, cursor: ALT_SCREEN_ANCHOR_CURSOR };
    }

    const diff = this.logUpdate.render(
      prevFrame,
      frame,
      this.altScreenActive,
      SYNC_OUTPUT_SUPPORTED,
    );

    this.backFrame = this.frontFrame;
    this.frontFrame = frame;

    const optimized = optimize(diff);
    const hasDiff = optimized.length > 0;
    if (this.altScreenActive && hasDiff) {
      if (this.needsEraseBeforePaint) {
        this.needsEraseBeforePaint = false;
        optimized.unshift(ERASE_THEN_HOME_PATCH);
      } else {
        optimized.unshift(CURSOR_HOME_PATCH);
      }
      optimized.push({
        type: 'stdout',
        content: cursorPosition(terminalRows, 1),
      });
    }

    writeDiffToTerminal(
      this.terminal,
      optimized,
      this.altScreenActive && !SYNC_OUTPUT_SUPPORTED,
    );
    this.prevFrameContaminated = false;
  };

  /** Re-renders the React tree at the new terminal size. */
  private handleResize = (): void => {
    const columns = this.stdout.columns || 80;
    const rows = this.stdout.rows || 24;
    if (columns === this.terminalColumns && rows === this.terminalRows) return;
    this.terminalColumns = columns;
    this.terminalRows = rows;
    if (this.altScreenActive) {
      this.resetFramesForAltScreen();
      this.needsEraseBeforePaint = true;
    }
    if (this.currentNode !== null) this.rerender(this.currentNode);
  };

  /** Best-effort terminal restore if the process exits without unmount(). */
  private handleProcessExit = (): void => {
    if (this.isUnmounted || !this.stdout.isTTY) return;
    this.stdout.write((this.altScreenActive ? EXIT_ALT_SCREEN : '') + SHOW_CURSOR);
  };

  /** Mounts/updates the React tree synchronously. */
  rerender = (node: ReactNode): void => {
    this.currentNode = node;
    const tree = (
      <RootApp columns={this.terminalColumns} rows={this.terminalRows}>
        {node}
      </RootApp>
    );
    reconciler.updateContainerSync(tree, this.container, null, () => {});
    reconciler.flushSyncWork();
  };

  /** Tears down the UI and restores the terminal. */
  unmount = (error?: Error): void => {
    if (this.isUnmounted) return;
    this.onRender();
    this.isUnmounted = true;

    if (this.stdout.isTTY) {
      this.stdout.off('resize', this.handleResize);
    }
    process.off('exit', this.handleProcessExit);

    reconciler.updateContainerSync(null, this.container, null, () => {});
    reconciler.flushSyncWork();

    if (this.stdout.isTTY) {
      this.stdout.write((this.altScreenActive ? EXIT_ALT_SCREEN : '') + SHOW_CURSOR);
    }

    this.rootNode.yogaNode?.free();
    this.rootNode.yogaNode = undefined;

    if (error) this.rejectExit(error);
    else this.resolveExit();
  };

  /** Resolves when the instance unmounts. */
  waitUntilExit = (): Promise<void> => this.exitPromise;
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────
/**
 * Mounts a React node into the terminal and returns a handle to update or
 * tear it down. With `altScreen` (default), takes over the full screen.
 */
export const render = (
  node: ReactNode,
  options: RenderOptions = {},
): RenderInstance => {
  const instance = new InkInstance(options);
  instance.rerender(node);
  return {
    rerender: instance.rerender,
    unmount: instance.unmount,
    waitUntilExit: instance.waitUntilExit,
  };
};
