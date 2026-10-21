import { useMemo } from 'react'
import { html as diffToHtml } from 'diff2html'
import 'diff2html/bundles/css/diff2html.min.css'

/**
 * Does every changed run in this diff replace N lines with exactly N?
 *
 * A "run" is a maximal stretch of `-` then `+` lines between context lines, and
 * it is exactly the grouping diff2html itself does before it pairs lines up.
 * `true` means positional pairing is the true pairing everywhere in this diff,
 * and the word-level marks can be trusted; `false` means at least one run is a
 * rewrite, where they cannot.
 *
 * Header lines are tested BEFORE the markers, because `---` and `+++` start
 * with one. `\` opens jsdiff's `\ No newline at end of file`, which belongs to
 * the line above and counts as neither side.
 */
export function linesPairUp(unified: string): boolean {
  let del = 0
  let ins = 0
  let paired = true
  const closeRun = () => {
    if (del !== ins) paired = false
    del = 0
    ins = 0
  }
  for (const line of unified.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) closeRun()
    else if (line.startsWith('\\')) continue
    else if (line.startsWith('-')) del += 1
    else if (line.startsWith('+')) ins += 1
    else closeRun()
  }
  closeRun()
  return paired
}

/**
 * Render a proposal's diff. THE ONE RENDERER, and it is now the one renderer of
 * TWO generators.
 *
 * `text` is a unified diff generated for DISPLAY — the server's `display_diff`,
 * or one of `planDiffSeries`'s steps. It is never an input: no surface anywhere
 * accepts a diff, and the write path sends the proposal's replacement TEXT.
 *
 * THIS COMMENT USED TO SAY this component "is the reason a diff-printing client
 * does not become a second one", and that sentence is retired rather than
 * quietly falsified. `planDiffSeries.ts` generates diffs in the browser, because
 * two of the three comparisons a note needs have a left-hand side the server has
 * never seen: the text the TRAY is holding, and text the user typed a moment
 * ago. What the rule was protecting is intact — `models/plan_markdown.py` keeps
 * the repository's only `difflib` import, there is exactly one generator on
 * each side, and every diff on this surface still arrives here to be drawn.
 * `planDiffSeries.test.ts` asserts the two generators print the same bytes for
 * the same pair, so "two generators" cannot quietly become two answers.
 *
 * `matching: 'none'` IS THE POINT OF THIS COMPONENT'S ONLY REAL CHOICE, and it
 * is the opposite of what reads like the richer setting. With `'lines'` or
 * `'words'`, diff2html runs its `Rematch` pass over a removal block and an
 * addition block and emits the PAIRS it finds, one after another — so a
 * rewritten paragraph draws as `-+++++++-+++-++`, red and green alternating
 * down the panel. A reader cannot see what the section said before, because
 * "before" is in four pieces with the after-text wedged between them. With
 * `'none'` the same change draws as `---+++++++++++++`: everything removed,
 * then everything added, which is what every diff a reader has ever seen does
 * and what `git diff` itself prints. The pairing was never information — for
 * prose it is a similarity score on two sentences that happen to share
 * `NOTE_STATUS`.
 *
 * THE WORD MARKS ARE THEN ONLY HONEST WHEN THE LINE COUNTS MATCH. Once the
 * blocks are contiguous, diff2html word-highlights `old[i]` against `new[i]`
 * positionally. Where a change replaces N lines with N, that pairing is the
 * real one and the marks show the actual edit. Where three bullets become
 * fourteen lines of prose, every pair after the first is two unrelated
 * sentences, and the marks are confetti painted over a rewrite — which is the
 * same "nearly every line is *edited*" problem `plan.css` already answers for
 * the amber `.d2h-change` fill. `linesPairUp` decides which one a given diff
 * is, and `maxLineLengthHighlight: 0` is how diff2html is told to skip the
 * word pass (`diffHighlight` returns the escaped line unmarked).
 *
 * The fallback is not defensive padding: `diff2html` extracts filenames from
 * the `---`/`+++` headers, and a section heading is not a path. If it ever
 * declines a well-formed diff, a classified `<pre>` still shows the change
 * rather than an empty panel.
 */
export function PlanDiff({ text }: { text: string }) {
  const rendered = useMemo(() => {
    if (!text.trim()) return null
    try {
      const out = diffToHtml(text, {
        drawFileList: false,
        matching: 'none',
        maxLineLengthHighlight: linesPairUp(text) ? 10000 : 0,
        outputFormat: 'line-by-line',
      })
      return out && out.includes('d2h-') ? out : null
    } catch {
      return null
    }
  }, [text])

  if (!text.trim()) return null
  if (rendered) {
    return (
      <div
        className="plan-diff text-xs overflow-x-auto"
        // The input is a server-generated unified diff and diff2html escapes
        // the content it renders.
        dangerouslySetInnerHTML={{ __html: rendered }}
      />
    )
  }
  return (
    <pre className="plan-diff-raw text-xs font-mono overflow-x-auto rounded bg-sidebar p-2">
      {text.split('\n').map((line, i) => (
        <div
          key={i}
          className={
            line.startsWith('+') && !line.startsWith('+++')
              ? 'text-emerald-600 dark:text-emerald-400'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'text-rose-600 dark:text-rose-400'
                : 'text-channel'
          }
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  )
}
