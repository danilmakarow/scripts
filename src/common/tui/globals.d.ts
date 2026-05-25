/**
 * Ambient declarations the vendored Ink engine depends on. The original fork
 * referenced a repo-level `global.d.ts` that wasn't part of the reconstructed
 * source, so these are restored here from how the engine uses them:
 *
 *  - the `ink-*` host elements the reconciler creates (JSX intrinsics),
 *  - the optional `Bun` runtime global (engine falls back to Node when absent),
 *  - the React Compiler runtime's `c` memo-cache helper.
 *
 * (`bidi-js`, which ships no types, is declared in its own script-context
 * file — an ambient module declaration can't live in this module file.)
 */

import type { ReactNode, Ref } from 'react';
import type { DOMElement } from './ink/dom.js';
import type { Styles, TextStyles } from './ink/styles.js';
import type { EventHandlerProps } from './ink/events/event-handlers.js';

/** Props accepted by the engine's host elements (superset across all five). */
interface InkHostProps extends EventHandlerProps {
  ref?: Ref<DOMElement>;
  style?: Styles;
  textStyles?: TextStyles;
  tabIndex?: number;
  autoFocus?: boolean;
  internal_static?: boolean;
  children?: ReactNode;
}

interface InkIntrinsicElements {
  'ink-root': InkHostProps;
  'ink-box': InkHostProps;
  'ink-text': InkHostProps;
  'ink-virtual-text': InkHostProps;
  'ink-link': InkHostProps;
}

// The automatic JSX runtime (jsx: react-jsx) resolves intrinsic elements via
// `react`'s JSX namespace; the global one is kept for older lookups.
declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements extends InkIntrinsicElements {}
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements extends InkIntrinsicElements {}
  }

  /** Present only under the Bun runtime; the engine guards every access. */
  const Bun:
    | {
        stringWidth(input: string, options?: { ambiguousIsNarrow?: boolean }): number;
        wrapAnsi(input: string, columns: number, options?: unknown): string;
        semver: {
          order(a: string, b: string): -1 | 0 | 1;
          satisfies(version: string, range: string): boolean;
        };
      }
    | undefined;
}

declare module 'react/compiler-runtime' {
  // The React Compiler memo cache stores arbitrary per-slot values; `any[]` is
  // what the runtime actually is, and typing it tighter breaks all compiled
  // component output that reads `$[i]`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const c: (size: number) => any[];
}
