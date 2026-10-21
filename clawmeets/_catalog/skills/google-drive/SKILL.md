---
name: google-drive
description: >
  Google Drive read-only (search / read). Invoked via
  `clawmeets gdrive {search,get,auth,revoke}`. Requires Google OAuth
  (drive.readonly) — Authenticate via Agent Settings → Skills → google-drive.
  Google Docs / Sheets / Slides export as text / first-tab TSV.
---

# /clawmeets:google-drive

Drive read access via the `clawmeets gdrive` CLI.

## Step 0 — Preflight

Token at `$CLAWMEETS_AGENT_DIR/skill-hub/state/google-drive/token.json` required.
If absent, reply: "Open Agent Settings → Skills → google-drive and click Authenticate."

## Step 1 — Pick the subcommand

| Intent | Command |
|---|---|
| "find files about X" | `clawmeets gdrive search "name contains 'X'"` |
| Read one file body | `clawmeets gdrive get <file-id>` |

Drive query syntax: `name contains 'foo'`, `mimeType = '...'`,
`'<folder>' in parents`, `modifiedTime > '2025-01-01T00:00:00Z'`. See
https://developers.google.com/drive/api/guides/search-files.

## Step 2 — Interactive read

`get` returns `{id, name, mime_type, modified_time, content}`. Google Docs /
Slides export as text and Sheets as first-tab TSV. Binary types and bodies over
256 KB return `content: null` — open those via the file's `web_view_link`
(from `search`).

## Step 3 — Fetching files on a schedule

These commands only fetch. If your SOP has you pull files regularly, where you
store them, how you deduplicate them (the file `id` is stable), and how you
track what you already fetched (e.g. a `modifiedTime > '<last run>'` search
term) is up to that SOP.
