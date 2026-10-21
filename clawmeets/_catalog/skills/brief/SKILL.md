---
name: brief
description: >
  Publishing protocol for My Desk's "Scheduled briefings". INVOKE when ANY of:
  (1) a message contains `<!-- clawmeets:brief-tab-trigger:<slug> -->`;
  (2) the user or coordinator asks you to publish, refresh, or update a
  "briefing" / "brief tab" / a tile on My Desk.
  Gather the data, write ONE complete HTML document, and shell
  `clawmeets brief upsert-tab <slug> --html briefing.html` to upload. My Desk
  composes all uploaded tabs into the Scheduled-briefings strip — one tile per
  slug — and each tile tracks its own last-refreshed-at timestamp.
---

# Brief — tab publishing protocol

Any agent the user trusts can populate a briefing tile on My Desk on
its own schedule. This skill is the contract: it tells you what to
write, how it is displayed, and how to upload.

A briefing is **one complete HTML document that you own entirely**. The
desk imposes no typography, no colour, no layout — it puts your document
in an isolated frame and sizes the frame around it. Design it.

You publish ONE tab per invocation. To refresh, re-run with the same
slug — overwrite is the contract (the server keeps no history, the desk
re-renders in place).

## § When invoked

- **Marker**: a message in the current chatroom contains
  `<!-- clawmeets:brief-tab-trigger:<slug> -->` — publish that exact
  slug. This is the path scheduled refreshes take: a per-tab cron
  (typically set up by the user's assistant from their DM) posts the
  marker into your DM, and the skill fires. The message body after
  the marker is the SOP — source, criteria, output shape; follow it.
- **Direct request**: the user / coordinator asks you to publish,
  refresh, or update a briefing. Resolve the briefing key per
  "§ Briefing key" below (prefer a name the user gave; else derive a
  candidate and confirm it before publishing) plus the intent from the
  chat; ask for clarification if the intent is ambiguous. Never invent
  a throwaway slug. If the request includes a recurring refresh and you
  have no way to create schedules, publish the tab now and suggest the
  user ask their assistant to set up the scheduled refresh.

If the request mentions multiple tabs, publish them one at a time —
one `clawmeets brief upsert-tab` invocation per slug. Don't try to
batch.

## § Briefing key

The **slug is the briefing key** — a stable, user-owned identifier that
publish and every later refresh share, so they upsert ONE tile instead
of minting duplicates. Resolve it by this precedence:

1. **Marker wins.** If the invoking message carries
   `<!-- clawmeets:brief-tab-trigger:<slug> -->`, that slug IS the key.
   Use it verbatim — never re-derive it.
2. **User-named.** If the user gave a name ("call it `wine`", "the wine
   briefing"), slugify that name (rule below) → the key.
3. **Derive & confirm.** If neither, derive a candidate from the tile
   title and confirm it with the user before publishing. Never silently
   invent a throwaway slug.

**Deterministic slugify** — the identical rule wherever a briefing key
is made (the `author-brief-tab` skill uses the same one, so a given
name always maps to the same key):

```
lowercase → trim → replace each run of [^a-z0-9] with a single "-"
→ strip leading/trailing "-" → truncate to ≤ 80 chars.
e.g.  "Wine Briefing"  →  wine-briefing   (every time)
```

**Reuse before minting.** Before you publish, run `clawmeets brief
list-tabs`. If an existing tab's slug or title matches the user's name,
reuse THAT slug (upsert in place) instead of coining a new one — this
is what keeps a one-off publish and a later scheduled refresh on the
same tile.

**Echo the key.** State the resolved key in your confirmation line so
it is referenceable next time (see § Publish step 4).

## § The artifact

You write THREE values per tab:

- **slug** — the briefing KEY (see § Briefing key). A user-supplied
  name, slugified deterministically; `[a-z0-9_-]+`, ≤ 80 chars.
  Re-publishing the same key overwrites the previous artifact in place.
- **title** — the tile label shown in the strip. Defaults to slug if
  blank. This is the label the desk uses; your document's own `<title>`
  is ignored, so there is exactly one source of truth for the name.
- **html** — ONE complete HTML document: `<!doctype html>`, `<html>`,
  `<head>`, `<body>`. UTF-8. **≤ 262144 bytes (256 KB).**

The document is stored and served **byte for byte as you wrote it**. The
server never parses it, never sanitizes it, never reformats it and never
injects anything into it. What you write is what renders.

That also means nothing will fix your document for you. It is a whole
page, not a fragment — a fragment is not wrapped, it is rendered as-is.

**The size limit is 262144 bytes (256 KB)**, measured on your document's
own UTF-8 bytes. `clawmeets brief upsert-tab` checks it locally, before
it uploads, and names both the limit and your actual size — so you fix
the file where you wrote it instead of learning the number from a failed
upload.

## § Worked example

Copy this and edit it. It is a complete, valid briefing: self-contained,
no network, its own typography, a hand-written bar chart and a sparkline
in inline SVG, a data table, and two source links.

Charts are just `<rect>` and `<polyline>` elements with coordinates you
compute from your data. That is the whole technique, and it is enough
for most briefings — no charting library, nothing to load, nothing that
can fail to arrive.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Wine inventory</title>
<style>
  :root { --ink:#1b1b1b; --muted:#6f6a64; --rule:#e6e2dc; --accent:#7a2e2e; }
  body { margin:0; padding:26px 30px 32px; background:#fbfaf8; color:var(--ink);
         font:16px/1.55 "Iowan Old Style","Palatino Linotype",Georgia,serif; }
  h1 { margin:0 0 3px; font-size:26px; letter-spacing:-.01em; }
  .dateline { margin:0 0 20px; font-size:12px; letter-spacing:.09em;
              text-transform:uppercase; color:var(--muted); }
  h2 { margin:26px 0 10px; padding-bottom:6px; font-size:12px;
       letter-spacing:.09em; text-transform:uppercase; color:var(--muted);
       border-bottom:1px solid var(--rule); }
  table { width:100%; border-collapse:collapse; font-size:15px; }
  th { padding:0 0 6px; font-size:11px; font-weight:600; text-align:left;
       letter-spacing:.07em; text-transform:uppercase; color:var(--muted); }
  td { padding:7px 0; border-top:1px solid var(--rule); }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .low { color:var(--accent); font-weight:600; }
  a { color:var(--accent); }
  footer { margin-top:26px; padding-top:11px; border-top:1px solid var(--rule);
           font-size:13px; color:var(--muted); }
</style>
</head>
<body>

  <h1>Wine inventory</h1>
  <p class="dateline">Chelsea &middot; week of 8 September</p>

  <h2>Cases on hand</h2>
  <!-- Bar chart. Baseline y=140, plot height 120px, scale max 40 cases,
       so each bar is height = cases / 40 * 120 and y = 140 - height. -->
  <svg viewBox="0 0 420 172" width="420" height="172" role="img"
       aria-label="Cases on hand by varietal">
    <g font-size="10" fill="#9b948c" text-anchor="end">
      <text x="30" y="143">0</text>
      <text x="30" y="83">20</text>
      <text x="30" y="23">40</text>
    </g>
    <g stroke="#e6e2dc">
      <line x1="36" y1="140" x2="412" y2="140"/>
      <line x1="36" y1="80"  x2="412" y2="80"/>
      <line x1="36" y1="20"  x2="412" y2="20"/>
    </g>
    <g fill="#7a2e2e">
      <rect x="44"  y="47"  width="48" height="93"/>
      <rect x="120" y="68"  width="48" height="72"/>
      <rect x="196" y="86"  width="48" height="54"/>
      <rect x="272" y="104" width="48" height="36"/>
      <rect x="348" y="119" width="48" height="21"/>
    </g>
    <g font-size="11" fill="#1b1b1b" text-anchor="middle">
      <text x="68"  y="41">31</text>
      <text x="144" y="62">24</text>
      <text x="220" y="80">18</text>
      <text x="296" y="98">12</text>
      <text x="372" y="113">7</text>
    </g>
    <g font-size="11" fill="#6f6a64" text-anchor="middle">
      <text x="68"  y="157">Riesling</text>
      <text x="144" y="157">Chenin</text>
      <text x="220" y="157">Gamay</text>
      <text x="296" y="157">Nebbiolo</text>
      <text x="372" y="157">Cava</text>
    </g>
  </svg>

  <h2>Below par</h2>
  <table>
    <thead>
      <tr><th>Wine</th><th>Supplier</th>
          <th class="num">On hand</th><th class="num">Par</th></tr>
    </thead>
    <tbody>
      <tr><td>Nebbiolo, Produttori 2021</td><td>Vine Street</td>
          <td class="num low">12</td><td class="num">24</td></tr>
      <tr><td>Cava Brut Nature, Recaredo</td><td>Iberia Imports</td>
          <td class="num low">7</td><td class="num">18</td></tr>
      <tr><td>Gamay, Foillard Morgon</td><td>Vine Street</td>
          <td class="num">18</td><td class="num">20</td></tr>
    </tbody>
  </table>

  <h2>Sell-through, last 12 weeks</h2>
  <!-- Sparkline. 12 points; x = 5 + i * 10, y = 24 - (v - min) / range * 20. -->
  <svg viewBox="0 0 120 28" width="120" height="28" role="img"
       aria-label="Weekly cases sold, trending up">
    <polyline fill="none" stroke="#7a2e2e" stroke-width="1.5"
              points="5,24 15,20 25,22 35,16 45,18 55,14
                      65,16 75,10 85,12 95,8 105,10 115,4"/>
    <circle cx="115" cy="4" r="2.5" fill="#7a2e2e"/>
  </svg>
  <p style="margin:6px 0 0;font-size:14px;">14 cases last week, up from 4.</p>

  <footer>
    Sources:
    <a href="https://www.chus.wine/ics/inventories/chelsea"
       target="_blank" rel="noopener noreferrer">inventory count</a> &middot;
    <a href="https://www.chus.wine/ics/orders"
       target="_blank" rel="noopener noreferrer">order history</a>.
    Counted 8 September.
  </footer>

</body>
</html>
```

**Loading things from the internet is allowed** — a stylesheet, a font,
a script, an image, from any host. Two facts to weigh before you do:

1. A remote asset that fails to arrive **fails soft and invisibly**. The
   desk cannot see inside your frame, so nothing reports the failure
   anywhere: your briefing simply renders wrong, and nobody can tell
   why. Self-contained is the safer default.
2. The 256 KB cap covers only your document's own bytes, so a
   CDN-loaded charting library costs you nothing against it.

## § Sizing

You do nothing. The desk measures your document and sizes the
frame around it. Do not post a height.

Your document must contain a `<head>`. The desk inserts one
`<script>` as its first child — do not assume you are the
first script on the page.

Three things silently break the measurement. Nothing warns you;
the desk cannot see inside your document to diagnose any of them:

1. `html { height: 100% }` — do not set it.
2. `body { overflow: hidden }` — do not set it.
3. Content positioned out of the body's box is NOT measured.
   Height comes from the bottom of `<body>`'s own box, so a
   `position: absolute` child extending past it is not counted
   and its tail is clipped. Keep content in normal flow.

## § Isolation limits

Your document runs in an isolated frame with its own opaque origin.
Everything below is settled — you don't have to reason about it.

| What you want | Works? | What to do instead / know |
| --- | --- | --- |
| `<style>`, `<script>`, inline SVG, fonts | **yes** | This is the whole point. Style it however you like. |
| `fetch()` a public API | **yes** | There is no same-origin to reach, so treat your document as offline-capable-or-broken. |
| `<script src="https://…">` | **yes** | Supported, not merely tolerated. Any host. |
| a link the user clicks | **only with `target`** | Every link MUST carry `target="_blank" rel="noopener noreferrer"`. A link without `target="_blank"` does nothing at all — no navigation, no error, no clue. |
| `localStorage` / `document.cookie` | **NO** | `localStorage` and `document.cookie` **throw `SecurityError`** — they do not return null. An unguarded copy-pasted snippet that touches either one hard-crashes your whole document. |
| reading the desk, the user's session, or another briefing | **NO** | The frame is a separate opaque origin. There is nothing there to reach. Don't try. |
| navigating the whole app away | **NO** | Top-level navigation is off. |

## § Publish

1. Sketch what the briefing should show, then gather the data. Read from
   your sources / data files / chat history — whatever is the
   authoritative place for the kind of data your tab shows.
2. Write the complete document to `briefing.html` in your sandbox
   working directory with the `Write` tool. Keep it ≤ 262144 bytes
   (256 KB).
3. Shell:
   ```bash
   clawmeets brief upsert-tab <slug> \
     --title "<Tile label>" \
     --html briefing.html
   ```
   The CLI resolves your agent id + token + server URL from the env
   variables the runner injects (`CLAWMEETS_AGENT_ID`,
   `CLAWMEETS_AGENT_TOKEN`, `CLAWMEETS_SERVER_URL`). No `--token` flag
   needed.
4. Reply ONE line in `user-communication`:
   `Briefing '<slug>' refreshed.` Don't summarize the data — the tile
   IS the deliverable.

To check what's already on the desk (e.g., to avoid clobbering a peer
agent's slug):

```bash
clawmeets brief list-tabs
```

To remove a tab you own:

```bash
clawmeets brief delete-tab <slug>
```

(Only the publishing agent can delete its own tab; the owning user can
delete any tab through the desk UI.) If a DM from the user or their
assistant asks you to remove a briefing you published, run the delete and
confirm in one line: `Briefing '<slug>' deleted.`

## § What NOT to do

- Don't upload a fragment. `html` is a whole document — `<!doctype html>`
  through `</html>`. Nothing wraps a fragment for you; it renders as-is,
  usually badly.
- Don't touch `localStorage` or `document.cookie`, and don't paste a
  snippet that does. They throw, and the throw takes your whole document
  with it.
- Don't write a link without `target="_blank" rel="noopener noreferrer"`.
  It will look fine and do nothing.
- Don't set `html { height: 100% }` or `body { overflow: hidden }`, and
  don't position your content outside the body's box. All three break
  the frame's height silently (see § Sizing).
- Don't post a height, and don't try to message the desk. Sizing is
  handled for you.
- Don't write multiple tabs per invocation. One slug per
  `upsert-tab` call. To publish N tabs, loop the CLI N times.
- Don't try to fetch your prior tab and merge — overwrite is the
  contract. Each publish is the complete current state of the tab.
- Don't write to chat in addition to publishing. The tile is the
  deliverable; the only chat output is your one-line confirmation in
  `user-communication`.
- Don't include sensitive secrets in the document. It is stored
  server-side and delivered to the user's browser as written. The user
  is the only intended viewer, but the artifact lives in the server's
  data dir.
