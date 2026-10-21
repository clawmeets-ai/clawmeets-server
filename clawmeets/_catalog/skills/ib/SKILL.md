---
name: ib
description: >
  Interactive Brokers — STRICTLY READ-ONLY fetch of positions, cost basis, PnL,
  current prices, historic prices, and news for US equities and bonds. Invoked
  via `clawmeets ib {positions,cost-basis,pnl,price,history,news-providers,news,
  news-article,doctor}`. There is NO order/buy/sell/cancel path — this skill can
  never trade. Requires a human-operated TWS / IB Gateway logged in out-of-band;
  connection coordinates (host/port/clientId/account) resolve from
  `$CLAWMEETS_AGENT_DIR/skill-hub/configs/ib.json`. Market data is LIVE by
  default — delayed data is only served under `--allow-delayed` and is tagged.
---

# /clawmeets:ib

Read-only Interactive Brokers access via the `clawmeets ib` CLI. Use it to
answer questions about the account's holdings and market data for **US equities
and bonds**. It cannot place, modify, or cancel orders — by design.

## Step 0 — Preflight

A human operator must be running **IB Gateway** (recommended, headless) or TWS,
logged in, with the **API enabled** and, for defence in depth, **Read-Only API**
turned on (Gateway/TWS → Global Config → API → Settings). Our code never sees
IBKR credentials — only the socket. Config resolves from
`$CLAWMEETS_AGENT_DIR/skill-hub/configs/ib.json` (host/port/clientId/account);
if it's missing, defaults to a localhost Gateway on port 4001.

Run `clawmeets ib doctor` first when unsure — it reports connectivity, the
connected account id, **paper vs live**, read-only status, and which news
providers are subscribed, **without returning any market data**. A wrong port
(paper vs live) yields real-looking but wrong data, so verify `account_kind`.

## Step 1 — Pick the subcommand

| Intent | Command |
|---|---|
| "what do I hold?" | `clawmeets ib positions` |
| Cost basis of holdings | `clawmeets ib cost-basis` |
| Profit/loss | `clawmeets ib pnl [--conid 265598 ...]` |
| Current price (equity) | `clawmeets ib price AAPL` |
| Current price (bond) | `clawmeets ib price 037833100 --sec-type BOND` |
| Price history | `clawmeets ib history AAPL --duration "6 M" --bar-size "1 day"` |
| Bond price history | `clawmeets ib history 912828YK0 --sec-type BOND --what YIELD` |
| Which news providers? | `clawmeets ib news-providers` |
| Headlines for a name | `clawmeets ib news AAPL --lookback-days 14 [--provider BRFG]` |
| Full article body | `clawmeets ib news-article BRFG <articleId>` |
| Setup self-check | `clawmeets ib doctor` |

`--config` self-resolves; you rarely pass it.

## Step 2 — Equities vs bonds

- **Equity**: pass the ticker symbol, `--sec-type STK` (the default).
- **Bond**: pass the **CUSIP** and `--sec-type BOND`. The bond is resolved
  CUSIP → conId and must match exactly one instrument (an ambiguous CUSIP is an
  error, not a guess). Bond prices are quoted **clean (percent of par)**; the
  payload reports `accrued_interest` as a **separate field**, never folded into
  the price, plus a `bond` block with `clean_price` / `dirty_price` /
  `market_value_clean` / `market_value_dirty`.

## Step 3 — Live vs delayed data

Prices and history are **LIVE by default**. If the account lacks a live
subscription, the command **errors** (`{"error":"not_subscribed", ...}`) rather
than quietly returning delayed or empty data. Only add `--allow-delayed` when
the user explicitly accepts delayed data; the returned payload is then tagged
`"data_type": "delayed"` so you can flag it to the user. Never present delayed
data as live.

## Step 4 — Errors are structured, act on them

Failures print JSON to stderr and exit non-zero — never a silent empty success:

| `error` | Meaning | What to tell the user |
|---|---|---|
| `not_subscribed` | Missing paid market-data / news subscription | Name the instrument + missing entitlement; suggest `clawmeets ib doctor`. |
| `contract_resolution` | Symbol/CUSIP didn't resolve to one instrument | Ask for a correct symbol/CUSIP. |
| `pacing` | IB rate limit; carries `retry_after` seconds | Wait `retry_after`s and retry (pacing is persisted on disk across calls). |
| `connection` | Gateway down / logged out / wrong port | Ask the operator to (re)start + log into IB Gateway. |

## Guardrails

- **Read-only, always.** There is no trading subcommand and the code carries no
  order symbol (CI-enforced by `tests/test_ib_readonly_guard.py`). Do not ask
  this skill to buy, sell, or cancel — it cannot, and won't be extended to.
- **Single account** this milestone. If the login manages several accounts,
  pass `--account`; otherwise the command errors rather than guessing.
- Treat the account id as sensitive — don't echo it into shared chat files.
