/**
 * Bracketed-paste event type. Referenced only as an optional handler parameter
 * type in event-handlers.ts; this stripped build never dispatches paste events.
 */

export interface PasteEvent {
  readonly text: string;
}
