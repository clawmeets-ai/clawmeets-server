---
name: playwright-save-skill
description: Crystallize a successful playwright-browser explore (prior turn drove `clawmeets browser` CLI subcommands via Bash) into a single SKILL.md workflow document that's replayable as `/personal:<name>`. The saved file mixes natural-language steps (where judgment lives) with concrete `clawmeets browser` invocations (where deterministic mechanism lives). Use ONLY when (a) the user just asked to save what just happened, AND (b) the prior turn drove the `playwright-browser` skill (you shelled `clawmeets browser navigate`, `clawmeets browser snapshot`, `clawmeets browser click`, etc.) AND `$CLAWMEETS_AGENT_DIR/personal-skill-hub/_explore/<task-id>/recording.md` exists on disk. For non-Playwright work — including saving a WebFetch-based procedure as a generic personal skill — let `/clawmeets:reflect`'s Promote mode handle it; do not invoke this skill.
---

# Save a Playwright explore as a workflow SKILL.md

Owns one job: take the recording from the explore (`$CLAWMEETS_AGENT_DIR/personal-skill-hub/_explore/<task-id>/recording.md`) and crystallize it as `personal-skill-hub/skills/<name>/SKILL.md` — a single markdown file that other turns of you can read top-to-bottom and re-execute against new inputs.

The saved file is the **only** thing that runs at replay time. There's no separate test script, no `.feature` file, no sidecar. Correctness comes from two layers:
- **User review** — you show the candidate markdown before saving so the user can catch design issues (wrong parameterization, missing branch, drifted intent).
- **Verify-replay** — you re-run the candidate against the seed input and confirm it reproduces the explore output, catching mechanical drift (a step got dropped, a value didn't get parameterized).

## Carve-out check (run before doing anything)

Two conditions must both hold. If either fails, **stop** and explain:

1. **A Playwright recording exists for the current task.** The prior turn drove the `playwright-browser` skill via Bash (visible `clawmeets browser navigate` / `clawmeets browser snapshot` / `clawmeets browser click` / etc. invocations) AND `$CLAWMEETS_AGENT_DIR/personal-skill-hub/_explore/<task-id>/recording.md` exists on disk.

   If not, reply: "I don't see a recent Playwright recording to save. If you want to save a non-Playwright procedure as a personal skill, that's `/clawmeets:reflect`'s Promote mode — try asking again after a regular reply." Stop.

2. **The user actually asked to save the *Playwright* run.** If the prior turn used `WebFetch` (or any tool other than `clawmeets browser`), this is the wrong skill — even if a stale `_explore/` dir exists. Reply with the same message as (1). Stop.

If both hold, proceed.

## Save procedure

### Step 1 — Read the recording

Read `$CLAWMEETS_AGENT_DIR/personal-skill-hub/_explore/<task-id>/recording.md`. It contains the verbatim sequence of `clawmeets browser <subcmd>` invocations you ran during the explore, interleaved with notes about what each step accomplished and what judgments you made.

### Step 2 — Ask for the user's description / SOP (if not already supplied)

The recording captures *what* happened; the user's description captures *why* — the intent that should generalize to new inputs. Examples: "find the best price for any wine query", "scrape the most contrarian view article on a topic", "log my hours for a given client and date range".

If the user's save request already included this ("save this as a skill for finding best wine prices"), use it as-is. Otherwise, reply with one focused question:

> What's this skill for? A one-line description plus any rules for how it should generalize (e.g. "find best price for wine X; prefer in-stock distributors; skip non-US sellers"). I'll show you the candidate markdown before saving.

Wait for the answer.

### Step 3 — One-pass translation

Generate a candidate SKILL.md combining the recording + description into one document:

- **Frontmatter**: `name`, `description` (from user input), `inputs` declaring parameters with type + comment.
- **Deterministic steps**: one numbered step per CLI invocation sequence, with a fenced `bash` block holding the verbatim `clawmeets browser` call(s). Use the real positional CLI — `navigate <url>`, `fill '<selector>' '<value>'`, `click '<selector>'`, `press-key <key>` (selectors are Playwright's, not `--ref`). Replace seed-specific literals with `{{input.<name>}}` placeholders. Always pass `--storage <name>` (agent-level identity) and `--session <dir>` (project-level working state, default `$PWD/.playwright-session`) so the saved skill replays against the same browser state model the explore used. See `skills/playwright-browser/SKILL.md` for the two-tier state contract. These calls auto-route to a running browser daemon (fast path) when present and fall back to one-shot otherwise — same commands either way, so nothing extra to record; replay is just faster when a daemon is up.
- **Judgment steps**: one numbered step per decision, in natural language, encoding the rule (not the seed-specific outcome). The user's description shapes how you phrase these — if they said "prefer in-stock distributors", that becomes the rule under the "pick a result" step.
- **Branches**: preserve conditional paths the explore actually took (e.g. "no match → try alternative query, at most twice").

Worked shape:

````markdown
---
name: search-provi-skill
description: Look up wine pricing on Provi by fuzzy query
inputs:
  query: string  # e.g. "Pacalet Gevrey-Chambertin 2022"
---

# search-provi-skill

Look up the buy-box pricing for a wine on app.provi.com. Handles fuzzy queries by letting the caller pick the best result and retrying with an alternative if no match is found.

## Workflow

### Step 1 — Visit the Provi homepage

```bash
clawmeets browser navigate https://app.provi.com \
  --storage provi --session "$PWD/.playwright-session"
clawmeets browser snapshot \
  --storage provi --session "$PWD/.playwright-session"
```

### Step 2 — Check if the session is signed in

Read the snapshot from Step 1. If you see a sign-in form, "Log in to continue" message, or any indication the session is logged out, the login has expired — reply with the auth handoff (`clawmeets browser start --storage provi`, or `auth` for the one-shot fallback) and stop.

### Step 3 — Submit the search query

Selectors are Playwright's (CSS / `text=` / `role=`), derived from the current snapshot — positional, not flags:

```bash
clawmeets browser navigate https://app.provi.com/product_listing \
  --storage provi --session "$PWD/.playwright-session"
clawmeets browser snapshot \
  --storage provi --session "$PWD/.playwright-session"
clawmeets browser fill 'input[name="search"]' "{{input.query}}" \
  --storage provi --session "$PWD/.playwright-session"
clawmeets browser press-key Enter \
  --storage provi --session "$PWD/.playwright-session"
clawmeets browser snapshot \
  --storage provi --session "$PWD/.playwright-session"
```

### Step 4 — Find the best matching result

Read the result list from Step 3's snapshot. Pick the wine that best matches `{{input.query}}` — consider producer, wine name, vintage, region, appellation. Match by semantic intent, not literal substring.

- **Clear match** → click it: `clawmeets browser click 'text=<result title>' --storage provi --session "$PWD/.playwright-session"`, then snapshot, continue to Step 5.
- **No clear match** → derive an alternative query (drop vintage, broaden producer to last name only); set `{{input.query}}` to the alternative and re-run from Step 3. Give up after 2 alternatives.

### Step 5 — Extract pricing

Read the product page snapshot from Step 4. Extract `case_price`, `bottle_price`, `vintage`, `format`, `distributor`. Return as a markdown table.
````

That's the entire saved skill. ~100 lines.

### Step 4 — Show the candidate to the user

Reply with the candidate SKILL.md inline (or write it to `/tmp/_save_candidate.md` and reference the path if it's long). Ask:

> Here's the candidate skill. Review and reply 'looks good' to save, or tell me what to change.

Loop on edits. Don't proceed to verify-replay until the user has confirmed.

### Step 5 — Verify replay against the seed input

Once the user approves, write the candidate to `/tmp/_save_candidate.md`. Then read it back as if you were a fresh turn invoked via `/personal:<name>` with the same input the explore used. Walk it top-to-bottom: execute each `bash` block (shelling `clawmeets browser <subcmd>` for each call), apply judgment to each natural-language step, see if the final output matches what the explore returned.

- **Match** → proceed to atomic move.
- **Drift** → the transcription doesn't reproduce what was actually done. Common causes: a step got dropped during translation, a parameterization leaked (some seed value wasn't replaced), the wrong branch was preserved. Reply with the diff between explore output and replay output; offer to re-translate.

This is the mechanical safety net. User review catches design issues; verify-replay catches mechanical bugs.

### Step 6 — Atomic move

Create the target dir and write the verified SKILL.md:

```bash
mkdir -p "$CLAWMEETS_AGENT_DIR/personal-skill-hub/skills/<name>"
mv /tmp/_save_candidate.md "$CLAWMEETS_AGENT_DIR/personal-skill-hub/skills/<name>/SKILL.md"
```

Clean up `_explore/<task-id>/` — it's just the recording at this point and the SKILL.md supersedes it.

The skill is now invokable as `/personal:<name>` on the next Claude subprocess spawn. Tell the user.

## Things to NOT do

- Do not invoke this skill if no Playwright recording exists for the current task. Re-read the carve-out check.
- Do not skip the user-review step. The verify-replay step catches mechanical drift but won't catch design issues (wrong scope, missing branch, intent mismatch) — only the user can.
- Do not skip the verify-replay step. User review catches design issues but won't catch transcription bugs (a step dropped, a literal value not parameterized) — only re-running can.
- Do not "fix bugs" in the recording during translation. If the explore had a wart, the saved skill inherits it (you can re-explore later to clean up). The recording is the source of truth.
- Do not save anything outside `personal-skill-hub/skills/<name>/SKILL.md`. No sidecar files. No script. No MANIFEST. The single-file rule is what makes the saved skill auditable.
- Do not embed scoring functions, picking heuristics, or "is this right?" regex in any `bash` block. Those decisions belong in natural-language steps where the replay-time LLM applies judgment with full context.
- Do not delete `_explore/<task-id>/` until Step 6 has succeeded. If verify-replay fails, the user can ask you to retry and the recording is still on disk.
