/**
 * Typed error helper for "errors with suggestions". Used when a script wants
 * to fail with a friendly hint listing valid alternatives (e.g. "no directory
 * matched, here are the available ones").
 */

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
export interface SuggestionErrorOptions {
  /** Heading shown above the bullet list (e.g. "Available directories:"). */
  readonly suggestionLabel: string;
  /** Suggested alternatives to render as bullets. */
  readonly suggestions: readonly string[];
}

// ─────────────────────────────────────────────────────────────
// SuggestionError
// ─────────────────────────────────────────────────────────────
/**
 * Error subclass that carries a labeled list of suggested values. Catch sites
 * can use {@link SuggestionError.is} to detect it and render the hints.
 */
export class SuggestionError extends Error {
  /** Type guard for use in `catch` blocks. */
  public static is(value: unknown): value is SuggestionError {
    return value instanceof SuggestionError;
  }

  public readonly suggestionLabel: string;
  public readonly suggestions: readonly string[];

  constructor(message: string, options: SuggestionErrorOptions) {
    super(message);
    this.name = 'SuggestionError';
    this.suggestionLabel = options.suggestionLabel;
    this.suggestions = options.suggestions;
  }
}
