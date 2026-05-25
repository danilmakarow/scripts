# dotmux (start/stop saved tmux layouts)

The `dotmux` script is a registry of saved tmux layouts. Instead of keeping a
pile of one-off bash scripts, each layout ("dotscript") is declared in-source
as a tmux **session name** plus the **windows** it opens, one long-running
command per window. The CLI exposes start/stop/restart over those layouts.

## Usage

```bash
dotmux <name> <operation>
```

- `<name>` — a registered dotscript. Matched **exactly**; an unknown name
  fails with the list of available scripts.
- `<operation>` — one of `up` / `down` / `restart`. Matched as a **substring**
  (contains), so the shortest unambiguous fragment works:
  - `u` → `up`
  - `do` → `down`
  - `re` → `restart`

### Examples

```bash
# Start the session detached, one window per command
dotmux nexus-ngrok up

# Kill the session
dotmux nexus-ngrok down

# Restart (operation matched as a substring)
dotmux nexus-ngrok re
```

## Operations

| Operation | Behavior |
|-----------|----------|
| `up`      | Start the session **detached**. First window via `tmux new-session -d`, the rest appended via `tmux new-window`. If the session already exists, logs a warning and does nothing (idempotent). |
| `down`    | `tmux kill-session` the session. If it isn't running, logs an info line and does nothing. |
| `restart` | `down` (if running) then `up`. |

After `up`, attach with `tmux attach -t <name>`.

## Saved dotscripts

### `nexus-ngrok`

Two windows, each running an ngrok tunnel to the local Nexus dev server on
port `3333`:

| Window     | Command |
|------------|---------|
| `webhook`  | `ngrok http --domain nexus-webhook.ngrok.app http://127.0.0.1:3333` |
| `redirect` | `ngrok http --domain nexus-redirect.ngrok.app http://127.0.0.1:3333` |

## What it does (step by step)

1. **Parse args** — requires exactly two (`<name> <operation>`); `-h` /
   `--help` or a wrong arg count prints the usage banner.
2. **Resolve `<name>`** — exact match against the dotscript registry; unknown
   names throw a `SuggestionError` listing available scripts.
3. **Resolve `<operation>`** — substring match against `up` / `down` /
   `restart`; no match or an ambiguous match throws a `SuggestionError`.
4. **Run the operation** against the tmux session, streaming each `tmux`
   invocation as a dashboard step.

## Error modes

| Condition | Behavior |
|-----------|----------|
| Missing args / wrong count | Print usage banner, exit 1 |
| `-h` / `--help` | Print usage banner, exit 0 |
| Unknown `<name>` | `SuggestionError` with available script names, exit 1 |
| Unknown / ambiguous `<operation>` | `SuggestionError` with operations, exit 1 |
| A `tmux` command exits non-zero (e.g. tmux not installed) | Throw with stderr, exit 1 |

## Implementation notes

- Source: `src/do-tmux.ts`.
- Session existence is probed with `tmux has-session -t =<name>` run directly
  via `execa` (`reject: false`) — a missing session is an expected non-zero
  exit, not a failure to surface. The `=` prefix forces an exact-name match so
  neither the check nor `kill-session` can touch a different session via tmux's
  prefix matching.
- The session name, window names, and window commands are single-quoted
  (`shellSingleQuote`) before being interpolated into the shell command passed
  to `runCommand`.
- `tmux` only reports failure when the session/window cannot be created; it
  returns 0 once a pane is spawned, so a tunnel command that later dies (e.g.
  ngrok exiting) is **not** caught here — inspect it by attaching to the
  session.
- Adding a new layout is one entry in the `DOTSCRIPTS` table — no new file.
```
