---
name: mailbox
description: >
  IMAP+SMTP mailbox (search / read / attachment / send). Provider-agnostic —
  works with Gmail (app password), iCloud, Fastmail, Outlook, ProtonMail
  Bridge, self-hosted Dovecot/Postfix. Invoked via
  `clawmeets mailbox {list-folders,search,get,attachment,send}`. No OAuth —
  credentials via `${VAR}` env vars referenced from
  `$CLAWMEETS_AGENT_DIR/skill-hub/configs/mailbox.json`.
---

# /clawmeets:mailbox

IMAP + SMTP mailbox via the `clawmeets mailbox` CLI.

## Step 0 — Preflight

Config at `$CLAWMEETS_AGENT_DIR/skill-hub/configs/mailbox.json` with an
`imap` block (and an optional `smtp` block for sending). Env vars referenced
as `${VAR}` must be exported on the runner. Missing config ⇒ reply "Open Agent
Settings → Skills → mailbox → Configure first."

## Step 1 — Pick the subcommand

| Intent | Command |
|---|---|
| List folders | `clawmeets mailbox list-folders` |
| Search | `clawmeets mailbox search "from:alice@x.com subject:invoice" --folder INBOX --max 20` |
| Read one (headers + text/html body + attachment list) | `clawmeets mailbox get <UID>` |
| Attachment | `clawmeets mailbox attachment <UID> <part-id> --out path.pdf` |
| Send | `clawmeets mailbox send --to ... --subject "..." --body -` |

Search mini-DSL: `from:`, `to:`, `subject:`, `since:YYYY-MM-DD`,
`before:`, bare flags `unseen` / `seen` / `flagged` / `answered`, bare
words → BODY substring.

## Step 2 — Send safely

Always reflect the user's intent back before sending. Pipe long bodies
via stdin: `--body -`.

## Step 3 — Fetching mail on a schedule

These commands only fetch (and send). If your SOP has you pull mail regularly,
where you store it, how you deduplicate it (`get` returns `message_id_hash`,
derived from the RFC822 Message-ID), and how you track what you already fetched
(e.g. a `since:` search term from your last run) is up to that SOP.
