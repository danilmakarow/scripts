/**
 * 3-line scrolling display for streamed subprocess output. Strips ANSI codes
 * for measurement, truncates long lines to terminal width, and re-renders
 * the spinner header above the lines on every update.
 */

import logUpdate from 'log-update';
import { theme } from './logger';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const DEFAULT_MAX_LINES = 3;
const DEFAULT_MAX_WIDTH = 76;
const TERMINAL_PADDING = 4;
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

// ─────────────────────────────────────────────────────────────
// OutputWindow
// ─────────────────────────────────────────────────────────────
/**
 * Renders a fixed-height scrolling tail of subprocess output beneath a
 * spinner header. Use {@link addLine} for each chunk and
 * {@link updateSpinnerText} to refresh the header line.
 */
export class OutputWindow {
  private readonly maxLines: number;
  private readonly lines: string[];
  private spinnerText: string;

  constructor(maxLines: number = DEFAULT_MAX_LINES) {
    this.maxLines = maxLines;
    this.lines = [];
    this.spinnerText = '';
  }

  /** Re-renders the current spinner header + tail buffer to the terminal. */
  private render(): void {
    const output = this.lines.length > 0
      ? `${this.spinnerText}\n${this.lines.join('\n')}`
      : this.spinnerText;

    logUpdate(output);
  }

  /** Appends one line to the tail buffer (ANSI-stripped, width-clamped). */
  public addLine(line: string): void {
    const cleanLine = line.replace(ANSI_PATTERN, '');
    const maxWidth = process.stdout.columns
      ? process.stdout.columns - TERMINAL_PADDING
      : DEFAULT_MAX_WIDTH;
    const displayLine = cleanLine.length > maxWidth
      ? `${cleanLine.substring(0, maxWidth - 3)}...`
      : cleanLine;

    this.lines.push(theme.dim(displayLine));
    if (this.lines.length > this.maxLines) {
      this.lines.shift();
    }
    this.render();
  }

  /** Updates the spinner header line above the tail buffer. */
  public updateSpinnerText(text: string): void {
    this.spinnerText = text;
    this.render();
  }

  /** Clears the rendered output and empties the tail buffer. */
  public clear(): void {
    this.lines.length = 0;
    logUpdate.clear();
  }
}
