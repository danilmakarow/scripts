# TUI Guide — how the full-screen logging engine works

A map of the terminal UI under `src/common/tui/`, written for someone fluent in
JS/React but new to terminal programming.

## TL;DR

It's **React-DOM, but the "DOM" is a 2-D grid of character cells and the
"browser paint" is writing escape codes to `stdout`.** Same reconcile → commit →
diff → patch loop as the web; only the host environment changes. You build a
React tree of `<Box>`/`<Text>`, a reconciler turns it into a node tree, Yoga
lays it out with flexbox, the tree is painted into a virtual screen grid, that
grid is diffed against the previous frame, and the difference is written to the
terminal as a handful of bytes.

You will almost never open the engine (`tui/ink/`, `tui/native-ts/`). Day to day
you touch **`runScript` / `runCommand` / `runStep` / `log` / `fmt`** (Part 5).

---

## Part 1 — How a terminal actually works

There is no DOM, no elements, no `appendChild`. A terminal gives you four things:

1. **`stdout` is a byte stream.** `process.stdout.write("hi")` puts `h`, `i`
   wherever the cursor is, then advances the cursor. That's the whole drawing
   API — a stream of bytes.

2. **ANSI escape codes are the real API.** Some byte sequences aren't printed —
   they're commands. They start with `ESC` (`\x1b`) then `[` (this prefix is
   called **CSI**):

   ```
   \x1b[2J        clear screen          \x1b[31m       text is now red
   \x1b[H         cursor to row1,col1   \x1b[0m        reset styling
   \x1b[10;5H     cursor to row10,col5  \x1b[?25l      hide cursor
   \x1b[?1049h    enter alternate screen
   ```

   So "red text at row 10" is literally
   `stdout.write("\x1b[10;5H\x1b[31mhello\x1b[0m")`. Styling is **stateful and
   positional** — you set a color, write, then unset it. These strings live in
   `tui/ink/termio/` (`csi.ts`, `dec.ts`, `osc.ts`).

3. **The alternate screen buffer** is the terminal's modal/overlay. `\x1b[?1049h`
   swaps to a blank screen saving the user's scrollback; `\x1b[?1049l` swaps back
   and restores it exactly. This is how vim/htop take over and leave no trace.
   **It's our full-screen takeover** — and why the report prints *after*, on the
   restored normal screen.

4. **There are no "elements" to update.** Wrote "Loading… 50%" and want "60%"?
   You don't have a handle to that text — you must move the cursor back and
   overwrite the characters. This is exactly the problem React solves on the web.

---

## Part 2 — The big idea: a virtual screen + diffing

Re-drawing the whole screen every frame flickers and is slow, so the engine does
what the virtual DOM does:

| Web / React-DOM | Our terminal engine | File |
|---|---|---|
| Components → Fiber tree | Components → Fiber tree | (React itself) |
| Reconciler diffs fibers | **The same `react-reconciler`** | `tui/ink/reconciler.ts` |
| Host = real DOM nodes | Host = our node tree (`ink-box`/`ink-text`) | `tui/ink/dom.ts` |
| CSS / flexbox layout | **Yoga** flexbox engine | `tui/native-ts/yoga-layout/`, `tui/ink/layout/` |
| Paint → pixels | Paint → a grid of character cells (**the virtual screen**) | `tui/ink/{screen,output,render-node-to-output}.ts` |
| Commit = minimal DOM mutations | Diff old grid vs new grid → minimal **patches** | `tui/ink/log-update.ts` |
| Browser applies mutations | Serialize patches → ANSI bytes → `stdout` | `tui/ink/terminal.ts` |

The **Screen** (`screen.ts`) is the key object — the terminal's "virtual DOM": a
2-D grid where each **cell** is `{ char, styleId, width, hyperlink }`. (It's
stored as a packed `Int32Array` for speed/low-GC, but conceptually it's just
`grid[y][x] = cell`.) Strings and styles are interned to integer IDs via
`CharPool`/`StylePool` (the flyweight pattern), so comparing two cells is an int
compare.

Each frame produces a fresh Screen; `log-update.render(prev, next)` walks the
changed cells and emits **patches** (`{cursorMove}`, `{stdout:"text"}`);
`writeDiffToTerminal` turns those into the ANSI byte string. So "50% → 60%"
becomes ~6 bytes: *move cursor, write "6"*. That's the whole game.

---

## Part 3 — One frame, end to end

Say `Dashboard` calls `setTick(t+1)` (spinner advances). The journey:

```
 setState (React)
   │
   ▼
 react-reconciler commits the fiber changes              ← react-reconciler (npm)
   │   via our host-config: createInstance→createNode,
   │   commitUpdate→setStyle/setAttribute, appendChild…   ← tui/ink/reconciler.ts (host config)
   │                                                         tui/ink/dom.ts       (the nodes)
   ▼
 reconciler's resetAfterCommit() fires two callbacks WE wired in render.tsx:
   ├─ rootNode.onComputeLayout() → Yoga computes x/y/w/h for every node
   │                                                       ← tui/ink/layout + native-ts/yoga
   └─ rootNode.onRender()        → our frame producer      ← tui/render.tsx (onRender)
        │
        ▼
   renderer(node…) walks the laid-out tree and PAINTS each node's text into a
   new Screen grid at its Yoga coordinates                ← tui/ink/renderer.ts
                                                             → render-node-to-output.ts (walk+paint)
                                                             → output.ts → screen.ts (cells)
        │
        ▼
   logUpdate.render(prevFrame, nextFrame) diffs the two Screens → Patch[]
                                                           ← tui/ink/log-update.ts
        │
        ▼
   writeDiffToTerminal(terminal, patches) → one ANSI string → stdout.write
                                                           ← tui/ink/terminal.ts
```

Supporting details:

- **Double buffering** (`frontFrame`/`backFrame` in `render.tsx`): keep last
  frame's Screen to diff against, then swap. (Current vs work-in-progress tree.)
- **A `Frame`** (`frame.ts`) is just `{ screen, viewport, cursor }`.
- **Full-damage compare** (see Part 8): we force the diff to compare every cell
  each frame, but it still only *writes* the cells that changed.

---

## Part 4 — Layout is Yoga (flexbox)

`<Box flexDirection="column" padding={1}>` isn't CSS, but it's the same flexbox
algorithm — **Yoga**, Facebook's engine (the one React Native uses). Every node
has a `yogaNode`; on commit we call `calculateLayout(terminalWidth)` and Yoga
fills in each node's computed `left/top/width/height` **in character cells**
instead of pixels. `render-node-to-output.ts` reads those coordinates to know
where to stamp each box border and each Text character into the grid.

The fork shipped a **pure-TypeScript port** of Yoga
(`tui/native-ts/yoga-layout/index.ts`) — the biggest single file and the one
real reason we vendored the fork instead of npm `ink` (no WASM binary to bundle).

---

## Part 5 — Using it (the API you'll actually touch)

A script wraps its work in `runScript`; `log` and `runCommand` automatically
route into the live dashboard. Pre-flight validation stays *before* `runScript`
and reports via `main().catch(reportError)`. (Reference: `src/do-pull.ts`.)

```ts
import { log } from './common/logger';
import { runCommand } from './common/command-runner';
import { runScript, runStep, reportError, fmt, code } from './common/tui/index';

const main = async () => {
  // 1. pre-flight (before the dashboard) — may throw → reportError
  const cwd = resolveProjectCwd(args[0]);
  await assertGitRepo(cwd);
  const branch = await getCurrentBranch(cwd);

  // 2. the run — full-screen dashboard takes over here
  await runScript({ name: 'dopull', subtitle: fmt`${cwd} · ${branch}` }, async () => {
    // a subprocess → live process window + a step row
    await runCommand('git pull', {
      cwd,
      description: fmt`Pulling ${branch}`,   // present-progressive, shown while running
      doneDescription: fmt`Pulled ${branch}`, // past-tense, shown once ✓
    });

    // non-subprocess work → a live step with spinner+timer
    await runStep({ active: 'Generating message', done: 'Generated message' },
      () => askModel(...));

    log.success(fmt`${branch} up to date`);  // a one-shot line (plain string or fmt)
  });
};

main().catch(reportError);   // pre-flight errors only; in-run failures are reported by runScript
```

What each piece does:

- **`runScript({ name, subtitle }, body)`** — in a TTY: enters the alt screen,
  mounts the dashboard, runs `body`, then releases the terminal and prints the
  report. Outside a TTY: falls back to plain console output. It owns the exit
  code (sets `process.exitCode = 1` on failure) so the report flushes — don't
  call `process.exit()` yourself.
- **`runCommand(cmd, { cwd, description, doneDescription })`** — runs a
  subprocess, streams its output into a bordered window, and records a step.
  `description` shows while running, `doneDescription` after.
- **`runStep(label, fn)`** — wraps non-command work as a live step. `label` is a
  string, or `{ active, done }` for the two-label form.
- **`log.info/success/warning/error/step(msg)`** — one-shot lines. Pass **plain
  strings** (or `fmt`) — never chalk/`theme`; the dashboard owns the colors.
- **`fmt` / `code`** (from `tui/format.ts`, re-exported by `tui/index.ts`) —
  inline highlighting. ``fmt`Pulling ${branch}` `` highlights every interpolated
  value; `code(x)` highlights one value inside a plain string. They work in both
  the live dashboard and the released report.
- **`reportError`** — pretty-prints a pre-flight error (incl. `SuggestionError`
  hints) and sets exit code 1.
- **`-d` / `--debug`** (global, via `src/common/cli-flags.ts`) — opts the report
  into showing the finalizing `log.*` lines (hidden by default; the report is
  just the step checklist otherwise).

---

## Part 6 — The dashboard internals (when you want to change the UI)

Our layer on top of the engine is plain React you already know:

- **`tui/run-store.ts`** — a classic external store (`subscribe` / `getSnapshot`,
  immutable snapshots) holding the run state: steps, processes, log lines. No
  React in it. `log`/`runCommand`/`runStep` mutate it.
- **`tui/components.tsx`** — the dashboard, ordinary React. `Dashboard` reads the
  store via **`useSyncExternalStore(store.subscribe, store.getSnapshot)`** (the
  React hook built for exactly this), plus a `useTick` interval that re-renders
  every ~90ms so spinners/timers animate. `<Box>`/`<Text>` are the engine's host
  components (think `<div>`/`<span>` with flexbox props). `<Formatted>` renders
  `fmt`/`code` spans by splitting on the sentinels and coloring code spans.
- **`tui/index.ts`** — the public API (`runScript`, `runStep`, `reportError`,
  `printReport`) and the active-run registry that `logger`/`command-runner` read.
- **`logger.ts` / `command-runner.ts`** — check "is a run active?"; if so, mutate
  the store instead of writing to the console. So one `log.info(...)` → store
  mutation → `useSyncExternalStore` re-render → reconciler commit → diff → a few
  bytes to stdout. The Part-3 pipeline fires from one log call.

App data flow (the mirror of the engine's):

```
log.info() / runCommand()  →  run-store mutation  →  Dashboard re-renders  →  [Part 3]  →  stdout
```

---

## Part 7 — Where to look for what

| I want to… | Look at |
|---|---|
| Change what the dashboard looks like | `tui/components.tsx` (pure React) |
| Add/track new run state | `tui/run-store.ts` + `components.tsx` |
| Change the script API / report format | `tui/index.ts` |
| Change inline highlighting (`fmt`/`code`) | `tui/format.ts` |
| Change `log` / `runCommand` behavior | `src/common/logger.ts`, `command-runner.ts` |
| The `-d` debug flag | `src/common/cli-flags.ts` |
| Understand the frame loop / alt-screen | `tui/render.tsx` (start here to read the engine) |
| See how React maps to terminal nodes | `tui/ink/reconciler.ts` + `dom.ts` |
| Understand the cell grid / diffing | `tui/ink/screen.ts`, `log-update.ts` |
| See how nodes get painted | `tui/ink/render-node-to-output.ts`, `output.ts` |
| Find a raw ANSI escape code | `tui/ink/termio/{csi,dec,osc}.ts` |
| Layout / flexbox behavior | `tui/ink/layout/`, `tui/native-ts/yoga-layout/` |
| Ambient type shims (JSX intrinsics, Bun, bidi-js) | `tui/globals.d.ts`, `tui/bidi-js.d.ts` |

---

## Part 8 — Gotchas (read before editing the dashboard)

**🔴 Width-1 glyphs ONLY in the dashboard.** The incremental diff uses *relative*
cursor moves. If a glyph's engine-measured width (`stringWidth()`) disagrees with
how the terminal actually renders it, the cursor drifts and garbles the rest of
the row (the "10× timer" bug). `✔` / `✖` / `⚠` measure as width **2**
(emoji/East-Asian) but render as width 1 → drift. Use width-1 glyphs only:
`✓ ✗ ▲ ℹ → ○ –` and the braille spinner frames. **Verify any new glyph** with the
engine's `stringWidth()` — it must return `1`.

**🔴 Never `console.*` inside a `runScript` body.** Raw `console.log` /
`console.error` / `process.stdout.write` writes straight to the alt screen and
corrupts the dashboard. Use `log.*` (plain strings) instead. Pre-flight console
output (before `runScript`) is fine.

**Full-damage every frame is intentional.** `render.tsx` sets
`prevFrameContaminated: true` and forces full-screen `damage` each frame. Per-node
dirty tracking misses in-place `<Text>` content changes (a step label swapping
active→done, duration digits ticking), which would leave stale characters. Full
damage makes the diff *compare* every cell but still only *writes* the changed
ones — a cheap full compare at CLI sizes, no flicker.

**`fmt` highlights EVERY interpolation.** Append static or conditional suffixes
*outside* the template, e.g.
``fmt`${cwd} · ${branch}` + (needsStash ? ' · will stash' : '')``. Markers are
NUL/SOH sentinels stripped by `splitFormatted` / `formatForConsole` /
`stripFormatting` before reaching the terminal.

**The engine is vendored** from `~/personal-projects/claude-code-src/ink` — treat
`tui/ink/` and `tui/native-ts/` like `node_modules`. Build notes: `tsconfig` needs
`jsx: react-jsx` + `.tsx` in `include`; esbuild bundles JSX with `jsx:'automatic'`;
`tui/ink/devtools.ts` is a stub so the reconciler's dev-only `import('./devtools.js')`
resolves.

---

## Part 9 — Trace it yourself (reading order)

1. `tui/index.ts` — `runScript` (how a run starts/ends).
2. `tui/render.tsx` — `InkInstance.onRender` (the heart; Part 3 is right there).
3. `tui/ink/reconciler.ts` — skim the host-config object (`createInstance`,
   `commitUpdate`, `resetAfterCommit`) to see React → nodes.
4. `tui/ink/screen.ts` — the `Cell` / `Screen` types (the virtual grid).
5. `tui/ink/log-update.ts` `render()` (grid diff → patches) and
   `tui/ink/terminal.ts` `writeDiffToTerminal` (patches → ANSI).

The one thing to internalize: **the `Screen` grid is the virtual DOM, and ANSI
byte-writes are the DOM patches.** Everything else is machinery to build that grid
from your React tree and diff it efficiently.
