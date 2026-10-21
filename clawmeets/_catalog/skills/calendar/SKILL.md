---
name: calendar
description: >
  CalDAV calendar (list / events / create / update / delete). Provider-agnostic
  — iCloud / Fastmail / Nextcloud / Radicale / SOGo / mailcow. Invoked via
  `clawmeets caldav {list,list-events,get,create,update,delete}`. No OAuth —
  credentials via `${VAR}` env vars in
  `$CLAWMEETS_AGENT_DIR/skill-hub/configs/calendar.json`.
---

# /clawmeets:calendar

CalDAV calendar via the `clawmeets caldav` CLI.

## Step 0 — Preflight

Config at `$CLAWMEETS_AGENT_DIR/skill-hub/configs/calendar.json` with a
`caldav` block (url/username/password, env vars `${VAR}`). Missing config ⇒
reply "Open Agent Settings → Skills → calendar → Configure first."

## Step 1 — Pick the subcommand

| Intent | Command |
|---|---|
| List calendars | `clawmeets caldav list` |
| Events in range | `clawmeets caldav list-events --time-min ... --time-max ...` |
| Get one | `clawmeets caldav get <UID>` |
| Create | `clawmeets caldav create --summary "..." --start ... --end ... [--attendees a,b]` |
| Update | `clawmeets caldav update <UID> --summary "..."` |
| Delete | `clawmeets caldav delete <UID>` |

## Step 2 — Calendar selection

When `--calendar-url` is omitted, subcommands search every calendar named in
the config's `default_calendars` list (all calendars if that list is empty);
`create` writes to the first of them.

## Step 3 — Fetching events on a schedule

These commands only fetch (and edit). If your SOP has you pull events
regularly, where you store them, how you deduplicate them (the iCalendar `uid`
is stable; `last_modified` tells you when it changed), and how you track what
you already fetched (e.g. a rolling `--time-min` / `--time-max` window) is up
to that SOP.
