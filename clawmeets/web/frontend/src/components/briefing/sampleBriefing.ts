/**
 * The onboarding sample, as a complete HTML document rather than a React
 * component.
 *
 * AC-1.4 requires the sample to render "like any published one", and under the
 * standalone-HTML model that means going through the same iframe, the same
 * injected bootstrap and the same sizing path as a real briefing — which a JSX
 * subtree cannot do. A constant costs no storage, no seeding, no migration and
 * no route.
 *
 * FULLY SELF-CONTAINED: its own typography, its own inline-SVG chart, no
 * network request of any kind. That matches the worked example in
 * `skills/brief/SKILL.md` (self-contained even though external resources are
 * permitted), and it makes this file the frontend half of the AC-1.2 drift
 * check: if this document and that worked example diverge on what a briefing
 * looks like, it is visible in one diff.
 *
 * TWO THINGS FROM THE OLD `SampleBriefing.tsx` DELIBERATELY DO NOT COME ACROSS:
 *   - the copy-to-clipboard button. The Clipboard API is unavailable to an
 *     opaque-origin frame not granted `allow="clipboard-write"`, and granting
 *     that to EVERY briefing frame is a capability grant to every future
 *     briefing author, bought for one button on one sample. The prompt is a
 *     selectable <pre> instead.
 *   - the PNG screenshot mock. A srcdoc document has no base URL, so a
 *     bundler-relative asset path does not resolve. Replaced by inline SVG,
 *     which is also what the skill teaches authors to draw charts with.
 */

export const SAMPLE_BRIEFING_TITLE = 'Sample Briefing'

/** The reserved slug's document. A complete `<!doctype html>` page — it must
 *  contain a `<head>`, like any published briefing, because that is where the
 *  height bootstrap is inserted. */
export const SAMPLE_BRIEFING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sample briefing</title>
<style>
  :root { --ink:#1b1b1b; --muted:#6f6a64; --rule:#e6e2dc; --accent:#5b3a8e; }
  body { margin:0; padding:26px 30px 32px; background:#fbfaf8; color:var(--ink);
         font:16px/1.55 "Iowan Old Style","Palatino Linotype",Georgia,serif; }
  h1 { margin:0 0 3px; font-size:26px; letter-spacing:-.01em; }
  .dateline { margin:0 0 22px; font-size:12px; letter-spacing:.09em;
              text-transform:uppercase; color:var(--muted); }
  h2 { margin:26px 0 10px; padding-bottom:6px; font-size:12px;
       letter-spacing:.09em; text-transform:uppercase; color:var(--muted);
       border-bottom:1px solid var(--rule); }
  p { margin:0 0 12px; }
  .panel { border:1px solid var(--rule); border-left:3px solid var(--accent);
           border-radius:8px; background:#f4f0fa; padding:18px 20px 16px; }
  .panel p:last-child { margin-bottom:0; }
  pre { margin:14px 0 0; padding:13px 15px; background:#fff;
        border:1px solid var(--rule); border-radius:6px;
        font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;
        white-space:pre-wrap; word-break:break-word; color:var(--ink); }
  .hint { font-size:13px; color:var(--muted); }
  table { width:100%; border-collapse:collapse; font-size:15px; }
  th { padding:0 0 6px; font-size:11px; font-weight:600; text-align:left;
       letter-spacing:.07em; text-transform:uppercase; color:var(--muted); }
  td { padding:7px 0; border-top:1px solid var(--rule); }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  a { color:var(--accent); }
  footer { margin-top:26px; padding-top:11px; border-top:1px solid var(--rule);
           font-size:13px; color:var(--muted); }
</style>
</head>
<body>

  <h1>Your briefing goes here</h1>
  <p class="dateline">Sample &middot; nothing below is real data</p>

  <div class="panel">
    <p><b>A briefing is a dashboard your agents keep up to date on a schedule.</b>
    To create one, tell your assistant what you want to see. For example:</p>
    <pre>please create a project to publish the following to the briefing of my desk,
save it as an SOP, and schedule it to run everyday at 2am PT.
- the top 3 most influential product announcements in the AI industry today,
  summarized in 3 sentences each with a reference link
- a list of emails that need my action today</pre>
    <p class="hint" style="margin-top:12px;">Your assistant scopes the work, runs
    it, and publishes the result here. Saving it as a <b>scheduled SOP</b> keeps
    it fresh automatically.</p>
  </div>

  <h2>What a published one looks like</h2>
  <p class="hint">Everything below is drawn by the briefing itself — its own
  typography, its own chart, its own table. The desk imposes none of it.</p>

  <!-- Bar chart. Baseline y=140, plot height 120px, scale max 40, so each bar
       is height = value / 40 * 120 and y = 140 - height. -->
  <svg viewBox="0 0 420 172" width="420" height="172" role="img"
       aria-label="Sample weekly volume by channel">
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
    <g fill="#5b3a8e">
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
      <text x="68"  y="157">Mon</text>
      <text x="144" y="157">Tue</text>
      <text x="220" y="157">Wed</text>
      <text x="296" y="157">Thu</text>
      <text x="372" y="157">Fri</text>
    </g>
  </svg>

  <h2>Needs your attention</h2>
  <table>
    <thead>
      <tr><th>Item</th><th>Owner</th><th class="num">Waiting</th></tr>
    </thead>
    <tbody>
      <tr><td>Sample row — a thing to decide</td><td>you</td>
          <td class="num">2 days</td></tr>
      <tr><td>Sample row — a thing to read</td><td>your assistant</td>
          <td class="num">4 hours</td></tr>
    </tbody>
  </table>

  <footer>
    A real briefing links its sources, like
    <a href="https://example.com/" target="_blank" rel="noopener noreferrer">this</a>.
    Ask your assistant to publish one and this sample disappears.
  </footer>

</body>
</html>
`
