---
name: google-calendar
description: >
  Google Calendar (list / get / create / update / delete events). Invoked via
  `clawmeets gcal {calendars,list-events,get,create,update,delete,auth,revoke}`.
  Requires Google OAuth — Authenticate via Agent Settings → Skills →
  google-calendar. The token resolves from
  `$CLAWMEETS_AGENT_DIR/skill-hub/state/google-calendar/`.
---

# /clawmeets:google-calendar

Google Calendar via the `clawmeets gcal` CLI.

## Step 0 — Preflight

Token at `$CLAWMEETS_AGENT_DIR/skill-hub/state/google-calendar/token.json` is required.
If absent, reply: "Open Agent Settings → Skills → google-calendar and click Authenticate."

## Step 1 — Pick the subcommand

| Intent | Command |
|---|---|
| List user's calendars | `clawmeets gcal calendars` |
| "what's on my calendar this week?" | `clawmeets gcal list-events --time-min ... --time-max ...` |
| Fetch one event | `clawmeets gcal get <event-id>` |
| Create event | `clawmeets gcal create --summary "..." --start ... --end ... [--attendees a,b,c]` |
| Patch event | `clawmeets gcal update <event-id> --fields '{"summary":"new"}'` (or `--fields -` stdin) |
| Delete event | `clawmeets gcal delete <event-id>` |

`--token` self-resolves — omit it.

## Step 2 — Interactive use

Parse JSON output and respond conversationally. Times are RFC3339 UTC
(`2026-04-20T00:00:00Z`).

## Step 3 — Fetching events on a schedule

These commands only fetch (and edit). If your SOP has you pull events
regularly, where you store them, how you deduplicate them (the event `id` is
stable per occurrence; `iCalUID` is shared across a recurring series), and how
you track what you already fetched (e.g. a rolling `--time-min` / `--time-max`
window) is up to that SOP.
