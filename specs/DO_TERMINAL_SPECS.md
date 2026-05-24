# doterminal (open N new Terminal.app windows)

The `doterminal` script opens a fixed number of new macOS Terminal.app
windows, each starting in the current working directory. Implemented via
`osascript` against `Terminal`.

## Usage

```bash
doterminal <count>
```

- `<count>` is required: a positive integer between **1** and **10**
  (inclusive). The upper bound exists to prevent accidental fork-bomb-style
  invocations.
- Each new window starts in the same `cwd` the script was launched from and
  runs `clear` so its prompt is the first thing visible.

### Examples

```bash
# One new window
doterminal 1

# Four new windows
doterminal 4
```

## What it does (step by step)

1. **Parse the count argument** — rejects anything that isn't a base-10
   positive integer; rejects values outside `[1, 10]`.
2. **Resolve cwd** — `process.cwd()`.
3. **Print a header** with count + cwd.
4. **Loop `count` times**: invoke `osascript` with a four-line `tell`
   block targeting `Terminal`:
   ```applescript
   tell application "Terminal"
     do script "cd '<cwd>'; clear"
     activate
     end tell
   ```
   The `cwd` is single-quoted in the shell command (safe against spaces and
   special characters) and the entire shell command is escaped for embedding
   inside an AppleScript double-quoted string (`\` → `\\`, `"` → `\"`).
5. **Print a success line** after each window opens.

## Error modes

| Condition | Behavior |
|-----------|----------|
| Missing arg / `-h` / `--help` | Print usage banner, exit 0 for help, exit 1 for missing arg |
| Arg not a base-10 integer | Throw `Invalid count "<raw>" — must be a positive integer`, exit 1 |
| Arg outside `[1, 10]` | Throw `Count out of range: <n> (allowed: 1–10)`, exit 1 |
| `osascript` exits non-zero (e.g. Terminal.app permission denied) | Throw with stderr, exit 1 |

## Platform notes

- macOS only. Targets `Terminal.app` specifically (not iTerm). This is a
  deliberate choice — auto-detecting `$TERM_PROGRAM` was considered and
  rejected to keep the script simple.
- The first run after a fresh OS install may trigger an Automation
  permission prompt — grant the parent process (e.g. Terminal, iTerm, or the
  IDE running the script) access to control Terminal.app via System Settings
  → Privacy & Security → Automation.

## Implementation notes

- Source: `src/do-terminal.ts`.
- Uses `execa` with arg-array invocation (no shell), so the only string
  escaping required is at the AppleScript level (handled by the local
  `shellSingleQuote` + `escapeAppleScriptString` helpers).
- No external dependencies beyond what other `do-*` scripts already pull in
  (`execa`, the shared `common/*` helpers).
