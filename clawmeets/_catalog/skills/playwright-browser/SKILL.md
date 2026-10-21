---
name: playwright-browser
description: >
  Drive a real Chrome browser via Python playwright when WebFetch can't do the
  job — login required, JavaScript-rendered UI, or multi-step interaction. Each
  subcommand cold-starts Chrome (no daemon) against a persistent profile,
  performs one action, and lets the profile carry state forward. Runs HEADED by
  default and applies a stealth fingerprint, so it survives Cloudflare's
  managed-challenge tier. Vocabulary: `clawmeets browser {start, stop, auth,
  navigate, snapshot, click, fill, press-key, screenshot, wait-for}`. Optional
  fast path: `clawmeets browser start` runs one long-lived browser per agent
  (tab per project) to drop the cold start and keep login fully live. Two-tier state:
  agent-level `--storage <name>` (long-lived identity, written by `auth`) +
  project-level `--session <dir>` (a persistent Chrome profile per project
  sandbox; defaults to `$PWD/.playwright-session`). Setup: `clawmeets bootstrap
  browser` once per runner, then `clawmeets browser auth --storage <name>` per
  agent identity. Pairs with `playwright-save-skill` to crystallize a successful
  explore.
---

# /clawmeets:playwright-browser

Browser automation via the `clawmeets browser` CLI (Python playwright).

## When to NOT use this skill

WebFetch is faster for static public HTML. Only reach for the browser when
**at least one** is true:
- The site requires login (password, MFA, passkey, SSO).
- The content is rendered by JavaScript after page load.
- The task needs interaction (click / fill / multi-step nav).
- The user explicitly wants this saved as a replayable skill.

## Preflight

1. **Chromium installed?** `clawmeets bootstrap browser` writes
   `{data_dir}/.playwright_bootstrapped`. If missing, reply:
   > Browser automation needs Chromium. Run `clawmeets bootstrap browser` once on this runner, then ask me again.

2. **A login exists for this identity?** For login-walled sites you need a
   signed-in identity (`personal` by default; another `--storage <name>` for a
   separate one). A login counts if **either** is true: a daemon is running for
   this agent (see *Fast path*), or the identity has a populated profile /
   `$CLAWMEETS_AGENT_DIR/skill-hub/state/playwright-browser/storage/personal.json`.
   If there's no login yet, hand off:
   > I need a signed-in browser identity for this agent. On the runner, run:
   > ```
   > clawmeets browser start --url https://google.com
   > ```
   > A real Chrome window opens and stays live. Sign in to whatever sites you want me to access (Google, the target app, and any SSO providers) — solve any Cloudflare/Turnstile check yourself. Leave the window running; the session stays live (nothing to export). Reply 'done' and I'll continue.
   >
   > (No display on the runner? Use the one-shot login instead: `clawmeets browser auth --url https://google.com`, sign in, then press Enter in the terminal.)

## Explore loop

Each subcommand runs ONE action and prints `{url, snapshot}` or similar JSON.
Cold-start cost is ~1.5–2 s per call — unless a daemon is running (see *Fast
path* below), where calls are sub-second and routing is automatic. Non-navigate
subcommands re-load `session.meta.json.last_url` automatically — you don't need
to pass `--url` again after the first navigate.

For a multi-step browser task you MAY enable the fast path first with
`clawmeets browser start` (see *Fast path*); it reuses an existing login, and
every action command below routes to it automatically. For **multi-step form or
reward/booking flows, or any flow where a click may open a new tab/window**, you
SHOULD `start` first — only the daemon holds page state and multiple tabs across
commands (see *Tabs* below); one-shot cannot.

`navigate` / `snapshot` / `screenshot` auto-wait for the page to settle (the
`load` event + network-idle) so JS/SPA content has painted before you read it —
no blank/splash captures. If you need a *specific* element, `wait-for 'selector'`
before screenshotting rather than re-navigating and hoping. Tune with
`--settle-ms <n>` (0 disables) for unusually slow or static pages.

Actions run **headed** by default (a Chrome window appears) because that is the
most Cloudflare-resistant. Force the mode per call with `--headless` / `--headed`
if you need to; the default also follows the skill config's `headless` value
(see *Cloudflare & bot detection* below).

```bash
# Step 1 — land
clawmeets browser navigate https://app.provi.com --storage personal

# Step 2 — read the accessibility tree, decide what to do
# (snapshot is in the JSON output; use playwright selector syntax for actions)

# Step 3 — interact
clawmeets browser fill 'input[name="q"]' "Sandhi Chardonnay 2022" --storage personal
clawmeets browser press-key Enter --storage personal

# Step 4 — wait if needed
clawmeets browser wait-for 'text=Search results' --storage personal --timeout-ms 8000

# Step 5 — snapshot for next decision OR screenshot for the user
clawmeets browser screenshot --out results.png --storage personal
```

Inside the runner, `--storage` resolves against the injected `$CLAWMEETS_AGENT_DIR`
automatically. To run an action command **manually** outside the runner (e.g. to
debug), pass `--agent <name>` so `--storage` can resolve — same as `auth`.

Selector syntax is Playwright's: CSS selectors, `text=`, `role=`, plus
`get_by_*` patterns wrapped as `internal:role=button[name="Sign in"]` etc.
Refs from a snapshot in a previous CLI invocation are stale (cold-start);
re-derive from the current snapshot each time, or use stable selectors.

## Tabs (daemon only)

A click can open a **new tab/window** (a `target=_blank` link, a `window.open`
popup, many reward/booking flows). When it does, the click result does NOT
switch to it — it stays on the current tab and adds:

```
"opened_tabs": [{"index": 1, "url": "https://…/reward", "active": false}],
"note": "new tab(s) opened; active tab unchanged. Use `switch-tab <index>` …"
```

You decide what to do with it:

```bash
clawmeets browser tabs             # list this project's tabs (index, url, active)
clawmeets browser switch-tab 1     # make tab 1 active; emits its snapshot
clawmeets browser close-tab 1      # close a tab you don't need
```

If a snapshot looks unchanged after a click that should have advanced the flow,
run `tabs` — the new page is probably a tab you haven't switched to. These
commands need the daemon; one-shot can't carry a tab to the next command.

## Fast path (optional): long-lived browser

`clawmeets browser start` launches one persistent Chrome for the agent (a tab
per project, keyed by sandbox CWD) and serves every subsequent subcommand from
it over a local socket. While it runs:

- **No cold start** — each action returns in well under a second.
- **Login stays fully live** — cookies (including ephemeral session cookies that
  Chrome never persists to disk), localStorage, and IndexedDB live in memory, so
  there's no export/copy/seed and no re-auth between commands.
- **Auth is just sign-in** — `start` (or `auth`) opens the live window; sign in
  to whatever you need and leave it running. No separate export step.

```bash
clawmeets browser start --storage personal        # one live browser (sign in here if first time)
clawmeets browser navigate https://app.example.com  # routed to the daemon, fast
clawmeets browser snapshot                          # same live tab, sub-second
```

The action subcommands auto-route: if a daemon is running they use it, otherwise
they fall back to the one-shot path below — same commands either way. The browser
is launched once via patchright and **never** reconnected over CDP, so stealth is
identical to one-shot.

**You may `start`; do not `stop`.** Running `start` at the top of a browser-heavy
task is fine — it reuses an existing login (only a first-time login needs the
human to sign in in the live window) and is a no-op if one is already up. But
`stop` is **user-managed**: stopping drops the in-memory session and the user's
live window, so never stop a daemon yourself — leave it running for the next task.

## Auth flow (first-time login OR refresh on expiry)

Storage is per-agent + per-identity (`--storage personal`, `--storage work`,
etc.). One headed `clawmeets browser auth` session captures cookies +
localStorage for every domain visited inside that window — apps + SSO
providers. On the first action of a new `--session`, the storage's cookies
seed the session's persistent Chrome profile; from then on the profile itself
carries the logged-in state (and any `cf_clearance`) forward.

The `auth` window is the SAME hardened browser as the actions — real Chrome,
stealth fingerprint, persistent profile (and patchright when the stealth extra
is installed). That's what lets you pass Cloudflare/Turnstile during login; the
human solves any interactive challenge in the window.

Never type credentials yourself. Hand off to the user with the CLI:

> Run `clawmeets browser auth --url https://google.com` on the runner.
> A real Chrome window opens at google.com. Sign in to Google, then visit
> each app site I'll need (e.g. https://app.provi.com); complete the
> OAuth bounce all the way back to the app and solve any Cloudflare/Turnstile
> check. Then return to the terminal and **press Enter** (do NOT close the
> window yourself). The storage lands at
> `skill-hub/state/playwright-browser/storage/personal.json`.

`auth` defaults to `--storage personal`. Use `--storage <name>` for a
separate sign-in (e.g. `work`). On subsequent action subcommands
(`navigate`, `click`, …), `--storage` defaults to empty — pass
`--storage personal` explicitly, or the browser runs anonymously.

## Things to NOT do

- Do not type credentials yourself — always hand off (`clawmeets browser start`,
  or `auth` for the one-shot fallback).
- Do not log out at the end of a task — that invalidates the storage identity
  for every future explore.
- Do not `stop` the browser daemon — it's user-managed and holds the live
  session (same spirit as "don't log out"). You may `start` it; never stop it.
- Do not invoke this skill when WebFetch can do the job.
- Do not pass refs/selectors across CLI invocations in one-shot mode — cold-start
  invalidates a snapshot's refs; re-derive from the current snapshot.
- Do not save the explore as a personal skill yourself — that's `playwright-save-skill`'s job.

## Cloudflare & bot detection

The CLI hardens every action against bot detection automatically — you don't
configure anything for the common case:

- **Headed by default + a stealth fingerprint.** Real Chrome (not bundled
  Chromium), automation flags stripped, a realistic UA / viewport / locale /
  timezone, and a `navigator.webdriver` / WebGL mask. Headless is the single
  biggest bot tell, so prefer the default; only pass `--headless` when you
  accept a higher block rate.
- **Persistent per-session profile.** The session is a real Chrome profile at
  `<session_dir>/profile/` (not a `state.json` dump). Cloudflare's
  `cf_clearance` cookie and a stable fingerprint persist across the
  cold-started invocations, so once a session clears a challenge it keeps
  passing — re-running is also faster.
- **Challenge-aware waiting.** On a Cloudflare interstitial ("Just a moment…")
  the command waits up to ~30 s for the challenge to clear before snapshotting.
  If it never clears, the command exits non-zero with a `ChallengeUnresolvedError`.
  When that happens: retry, make sure you passed a valid `--storage` identity,
  and prefer headed mode. A managed challenge may need an interactive `auth`
  pass first (sign in via `clawmeets browser auth` so cookies seed the profile).

**Real Chrome recommended.** The CLI prefers the installed Google Chrome and
falls back to bundled Chromium only if Chrome is absent — but bundled Chromium
is easier to fingerprint and less likely to pass tough challenges. Install
Google Chrome on the runner for best results.

**Stubborn sites (airlines, Turnstile, "access denied").** A plain stealthed
Playwright browser still leaks that it's automated via the CDP `Runtime.enable`
call — enough for Cloudflare Turnstile to fail the checkbox or for a site to
deny access after login. The **patchright** stealth runtime closes that leak and
**ships by default** with clawmeets (it's a core dependency) — just run:

```
clawmeets bootstrap browser     # fetches real Chrome + reports the active runtime
```

> **Python 3.14 caveat.** patchright has no Python 3.14 build, so on 3.14 it's
> not installed and the skill falls back to stock Playwright (which Cloudflare
> Turnstile / airline sites will likely block). Run clawmeets under Python ≤3.13
> (e.g. `pyenv install 3.13 && pyenv local 3.13.x`, then reinstall) for the
> stealth runtime.

`clawmeets bootstrap browser` prints the active runtime and warns loudly if the
stealth runtime is inactive (e.g. running on Python 3.14). When active, the skill
uses **patchright** (closes the CDP leak; real Chrome with a clean, override-free
config) for both `auth`/`start` and the action commands. Every result JSON
— and the `auth` opening message — reports `"runtime": "patchright"` when active
(`"playwright"` otherwise). This is the first thing to try for China-Airlines
Turnstile or post-login "access denied".

Note: the fingerprint config keys (`user_agent`, `viewport`, `webgl_*`) apply
**only** to the stock-Playwright fallback. Under patchright they're intentionally
ignored — patchright presents a coherent real-Chrome fingerprint, and overriding
it would re-introduce detectable inconsistencies. `headless` and `proxy_*` apply
to both.

**Proxy (hard IP blocks).** If a site returns an immediate "access denied" /
error 1020 with no solvable challenge, it's likely blocking the runner's IP
(datacenter/VPN). Set `proxy_server` (+ optional `proxy_username`/`proxy_password`)
in the skill config to route through a residential proxy. See `starter_config.jsonc`.

**Headless Linux servers (no display).** Headed mode needs a display. Either
set `"headless": true` in the config, or wrap the command in a virtual display
(no extra Python dependency):

```bash
xvfb-run -a clawmeets browser navigate https://app.example.com --storage personal
```

**Optional config.** Fingerprint defaults live in the CLI; override any of
them per agent via `starter_config.jsonc` (Agent Settings → Skills →
playwright-browser → Configure): `headless`, `user_agent`, `locale`,
`timezone_id`, `viewport_width/height`, `webgl_vendor/renderer`. Every key is
optional. Keep UA / locale / timezone mutually consistent.

## Concurrency

**One-shot mode:** each invocation spawns one Chrome process (against the session
profile) and tears it down. Parallel explores on the same agent are safe as long
as they use different `--session` dirs (default `$PWD/.playwright-session` already
partitions by sandbox CWD). Do **not** run two commands against the *same*
`--session` concurrently — they share one persistent profile dir and Chrome will
refuse the second with a "profile in use" error.

**Daemon (fast path) mode:** one Chrome with a tab per project. Different
projects (different `--session`) run on independent tabs and interleave freely;
commands on the *same* project serialize on a per-tab lock instead of failing —
so the same-session restriction above does not apply. Different agents always run
fully separate daemons/Chromes.
