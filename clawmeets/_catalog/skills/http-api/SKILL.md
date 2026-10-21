---
name: http-api
description: >
  Generic HTTP client — `clawmeets http-api get|post|put|patch|delete <url>`
  with `-H`, `--query`, `--data`/`--json`, and a curl-style session jar
  (`--save-session`/`--session`) so login is just a POST that writes cookies,
  with `--expect-location`/`--expect-status` to declare what success looks
  like (a wrong password is an ordinary 3xx, not an error status). `$VAR` /
  `${VAR}` in header values expand from the environment, so auth secrets stay
  out of argv. No config.
---

# /clawmeets:http-api

Drive any HTTP/REST API via the `clawmeets http-api` CLI.

Fetching data on a schedule: these commands only fetch (and write). Where the
results are stored, how they are deduplicated, and how incremental fetches are
tracked (a `since` / cursor / page parameter passed via `--query`) is up to
your agent's SOP.

## Commands

A general-purpose curl-shaped client for driving a live API — log in, hold the
session, then read/write.

```
clawmeets http-api get    <url> [options]
clawmeets http-api post   <url> [options]     # + --data / --json
clawmeets http-api put    <url> [options]     # + --data / --json
clawmeets http-api patch  <url> [options]     # + --data / --json
clawmeets http-api delete <url> [options]     # + --data / --json (body optional)
```

### Options

| Option | Meaning |
|--------|---------|
| `-H, --header "Name: value"` | Repeatable. `$VAR` / `${VAR}` in the value is expanded from the **environment** (unset → empty string) — so `-H "Authorization: Bearer $ICS_TOKEN"` keeps the secret out of argv/logs/jar. |
| `--query "k=v"` | Repeatable query-string param. |
| `--data "k=v"` | Repeatable form field → `application/x-www-form-urlencoded`. |
| `--json '<raw>'` | Raw JSON body, curl semantics: repeatable + concatenated, `@file` and `@-` (stdin) supported; sets `Content-Type` **and** `Accept: application/json` (an explicit `-H` wins). Mutually exclusive with `--data`. |
| `--session <jar>` | Load cookies from a jar (curl `-b`). |
| `--save-session <jar>` | Write captured cookies to a `0600` JSON jar (curl `-c`). |
| `--follow` / `--no-follow` | **Default `--no-follow`.** A login's `3xx` *is* the auth signal — `302` or `303` (Rails and most POST-redirect-GET frameworks emit `303`) with `Location: /` = ok, `/login` = fail; auto-following would mask a failed login as a final `200`. |
| `--expect-location <glob>` | **Declare where a successful request lands.** The `Location` header is resolved against the request URL first (so `/`, `https://host/` and `../x` all normalize), then glob-matched. A pattern starting with `/` matches the URL **path** — `'/'` is exact, `'/dashboard*'` is a prefix; any other pattern matches the whole absolute URL. Under `--follow` (no `Location` on the final response) it matches the final URL instead, so the flag reads as "where did I end up" either way. Unmet → exit `23` **and the `--save-session` jar is not written**. Note `/dashboard` and `/dashboard/` are different paths — write `'/dashboard*'` if the app may add the slash. |
| `--expect-status <spec>` | **Declare the acceptable status(es)** — `'200'`, `'2xx'`, `'200,303'`; `x` is a wildcard digit. Covers the two shapes `--expect-location` cannot see: a login form re-rendered at `200`, and an API returning JSON `401`. Unmet → exit `23`, jar not written. A malformed spec exits `2` **before any request is sent**. |
| `--output body\|json\|full` | `body` (default) = raw text; `json` = pretty-printed (errors if the body isn't JSON); `full` = envelope `{status, reason, url, location, history, headers, body}` — read this to inspect a login's status + `Location`. |
| `--timeout <s>` | Per-request timeout (default 30). |
| `--fail` | Opt into curl-style non-zero exit on HTTP status ≥ 400. |

### Session jar

The jar is **cookies-only**: `{"cookies": {name: value}}` written `0600`.
Cookies are captured from *every* response — **including a 302's own
`Set-Cookie`** — so `--save-session` works even with `--no-follow`. Login is
therefore just a `post` that writes a jar; there is no auth subcommand, which
keeps it general across cookie / token / OTP APIs. (Legacy
`{"cookies", "headers"}` jars still load; the `headers` half is ignored.)

**The jar is written only when the command exits `0`.** An unmet `--expect-*`,
a `--fail` status, or a render error all suppress the write, so a failed login
can never replace a working session with the login page's anonymous cookie.
Without `--expect-*` there is nothing to fail against — a bad password still
looks like success — which is why a login that writes a jar should always
declare an expectation.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Response received — **any** HTTP status (incl. 4xx/5xx); body on stdout. |
| `2` | Usage error (bad `-H`/`--query`/`--data`, `--json`+`--data` together, bad `--output`, body on a GET). |
| `6` | Session/jar I/O error (missing/unreadable/unwritable jar). |
| `7` | Network error (DNS, connect, timeout, TLS, bad URL). |
| `22` | HTTP status ≥ 400 **and** `--fail` was passed. Jar not written. |
| `23` | A declared `--expect-location` / `--expect-status` did not match. Body still printed, one-line reason on stderr, jar not written. Wins over `22` when both fire — the more specific declaration reports. |

4xx/5xx return `0` by default so structured error payloads (e.g. a JSON
`400`) stay readable.

### Worked example — login, then authed GET

```bash
export ICS_TOKEN=...              # if the API is token-based instead of cookie

# 1) Log in. POST the form, DON'T follow the redirect, save the cookie jar,
#    and DECLARE where a successful login lands. Without --expect-location a
#    wrong password returns 3xx + Set-Cookie + exit 0, exactly like success.
clawmeets http-api post https://ics.example/login \
  --data "username=alice" --data "password=$ICS_PW" \
  --no-follow --save-session /tmp/ics.jar --expect-location '/' --output full
# exit 0  => landed at "/": authenticated, cookie captured off the 3xx
# exit 23 => landed elsewhere (e.g. "/login"): jar NOT written, any previous
#            session left intact; stderr says where it actually landed.

# API-style login (JSON 200 on success, 401 on failure)? Declare the status
# instead of the destination:
clawmeets http-api post https://api.example/session \
  --json "{\"user\":\"alice\",\"pw\":\"$ICS_PW\"}" \
  --save-session /tmp/api.jar --expect-status 200 --output json

# 2) Reuse the session on subsequent calls.
clawmeets http-api get https://ics.example/reports --session /tmp/ics.jar --output json

# 3) Token APIs need no jar — pass the header, read the secret from env:
clawmeets http-api get https://api.example/v1/me \
  -H "Authorization: Bearer $ICS_TOKEN" --output json

# 4) Writes work the same way (PUT/PATCH/DELETE take --data or --json):
clawmeets http-api patch https://api.example/v1/items/42 \
  --session /tmp/ics.jar --json '{"status":"archived"}' --output full
clawmeets http-api delete https://api.example/v1/items/42 --session /tmp/ics.jar --fail
```

Credentials are never echoed: request headers/cookies/body are not logged, and
only the response you asked for is printed.
