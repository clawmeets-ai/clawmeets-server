---
name: gmail
description: >
  Read, search, send, and archive Gmail messages. Invoked via Bash subcommands
  (`clawmeets gmail search|get|labels|attachment|send|archive|auth|revoke`); the
  token resolves from `$CLAWMEETS_AGENT_DIR/skill-hub/state/gmail/`. For
  requests like "any emails about X?" or "send Y to Z" shell the matching
  subcommand. Requires Google OAuth — install + Authenticate via Agent
  Settings → Skills → gmail before first use.
---

# /clawmeets:gmail

Gmail integration. The agent profile decides *when* to read/search/send;
this skill is *how* — Bash invocations of the `clawmeets gmail` CLI.

## Step 0 — Preflight

Token at `$CLAWMEETS_AGENT_DIR/skill-hub/state/gmail/token.json` is required.
If absent, reply with:

> The gmail skill isn't authenticated for this agent yet. Open Agent Settings → Skills → gmail and click "Authenticate", or run `clawmeets gmail auth` on the runner.

## Step 1 — Pick the subcommand

| Marker / intent | Command |
|---|---|
| "any emails from / about …" | `clawmeets gmail search "<query>" --max 20` |
| "open the email …" | `clawmeets gmail get <message-id>` |
| "what attachment was on …" | `clawmeets gmail attachment <message-id> <attachment-id> --out <path>` |
| "send an email to …" | `clawmeets gmail send --to … --subject "…" --body -` (pipe body via stdin) |
| "archive this / clear these out of my inbox" | `clawmeets gmail archive <id> [<id> …]` |
| "archive everything from …" | `clawmeets gmail archive -q "<query>" --max N --dry-run` first, then re-run without `--dry-run` |
| "put that back in my inbox" | `clawmeets gmail archive <id> --undo` |
| List labels | `clawmeets gmail labels` |

The CLI self-resolves `--token` from `$CLAWMEETS_AGENT_DIR` — omit it.

## Step 2 — Fetching mail on a schedule

These commands only fetch. If your SOP has you pull mail regularly, where you
store it, how you deduplicate it (Gmail's message `id` is stable), and how you
track what you already fetched (e.g. an `after:<epoch>` search term from your
last run) is up to that SOP.

## Step 3 — Interactive use

For search / read / send, pipe long bodies via stdin (`--body -`), parse the
JSON output, and synthesize a conversational reply. Don't paste raw JSON into
chat.

## Step 3b — Archiving (the only write op besides send)

Gmail archive == removing the `INBOX` label. Nothing is deleted: the mail stays
in All Mail and `clawmeets gmail archive <id> --undo` puts it back. Say that
when you report — it's what makes a bulk archive safe to accept.

```bash
clawmeets gmail archive 18f2a1b3c4d5e6f7                       # one message
clawmeets gmail archive -q "from:news older_than:30d" --max 50 --dry-run
clawmeets gmail archive -q "from:news older_than:30d" --max 50  # for real
```

**Query mode: ALWAYS `--dry-run` first**, show the user the matched subjects,
and only re-run without the flag after they confirm. Explicit-id archive needs
no confirmation step — the user already named the message.

Output JSON carries `matched` (with subject/from/date in query mode),
`archived`, and `failed: [{id, error}]`. Two things to surface in your reply:
- `truncated: true` means the match count hit `--max` and more mail may match —
  tell the user, and offer to re-run with a higher `--max`.
- A non-empty `failed` names the specific messages that didn't move; the rest
  did. Re-running is safe — archiving an already-archived message is a no-op.
