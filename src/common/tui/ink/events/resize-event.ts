/**
 * Terminal resize event type. Referenced only as an optional handler parameter
 * type in event-handlers.ts; this stripped build never dispatches resize events
 * (resize is handled at the render() level instead).
 */

export interface ResizeEvent {
  readonly columns: number;
  readonly rows: number;
}
