---
name: homekit
description: >
  Apple HomeKit / Apple Home control via the macOS `shortcuts` CLI. The user
  builds the Shortcuts (Bedtime, Away-mode, Set Bedroom Temp); this skill just
  enumerates and invokes them through `clawmeets homekit list-shortcuts` and
  `clawmeets homekit run-shortcut "<name>"`. macOS 12+ only. No OAuth, no
  config. If the runner is non-macOS, the CLI errors out — reply that the
  skill is unavailable on this host.
---

# /clawmeets:homekit

Two Bash subcommands. The Shortcuts app is the contract; this skill never
reinvents device primitives or duplicates the editor.

## Step 1 — Discover

When you first need to control devices on a new agent, call
`clawmeets homekit list-shortcuts` once and remember the result (or cache it
under `memory/learnings/` if you'll use it across sessions).

## Step 2 — Invoke

```bash
clawmeets homekit run-shortcut "Bedtime"
clawmeets homekit run-shortcut "Set Bedroom Temp" --input -   # piped stdin
```

Returns `{ok, exit_code, stdout, stderr}`. Report back conversationally — e.g.
"Set Bedroom Temp ran OK." Don't paste raw stdout if it's empty.

## Step 3 — Errors

The CLI exits 1 with a clear message if the platform isn't macOS or the
`shortcuts` binary is missing. Surface that error to the user without
re-formatting; they need to know the host can't drive HomeKit.
