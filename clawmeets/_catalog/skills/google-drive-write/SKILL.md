---
name: google-drive-write
description: >
  Google Sheets read + write (per-target). Each named target binds one
  spreadsheet's named tab + id-column. Invoked via
  `clawmeets gdrive-write {read-rows,append-rows,update-cell,auth}`. Separate
  from `google-drive` so the sheets-write OAuth scope is opt-in (one agent
  can hold both tokens). No sync trigger — used inline by content-engine
  pipelines (e.g. marketing template's instagram agent: read brief sheet →
  generate image → write back).
---

# /clawmeets:google-drive-write

Google Sheets read+write via the `clawmeets gdrive-write` CLI.

## Step 0 — Preflight

Token at `$CLAWMEETS_AGENT_DIR/skill-hub/state/google-drive-write/token.json`
required. Configure `sheet_targets` via Agent Settings → Skills →
google-drive-write → Configure.

## Step 1 — Pick the subcommand

| Intent | Command |
|---|---|
| Read all rows | `clawmeets gdrive-write read-rows --target <name>` |
| Append rows | `clawmeets gdrive-write append-rows --target <name> --rows-file rows.json` |
| Update one cell | `clawmeets gdrive-write update-cell --target <name> --row-id <id> --column <col> --value <val>` |

Each target's `name` is the logical key the LLM uses; `spreadsheet_id`,
`sheet_name`, and `row_id_column` are configured separately.

## Step 2 — Append shape

`--rows-file` is a JSON list of dicts keyed by column name. Unknown keys
are silently dropped (extend the Sheet header first if you need a new
column). Missing keys are written as empty strings. Stream via stdin:
`clawmeets gdrive-write append-rows --target ideas --rows -`.

## Step 3 — Update by primary key

`update-cell` looks up the row whose `row_id_column` matches `--row-id`
and writes `--value` into `--column`. Errors verbosely on missing
column / missing row so the agent can self-correct.
