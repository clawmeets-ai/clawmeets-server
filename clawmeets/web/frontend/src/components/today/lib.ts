// Today's render-code library — the public `lib` namespace passed to
// every tab's render body. Mirrors the surface that used to live inline
// in `skills/today/template.html` (window.TodayLib), now hosted in the
// React shell at `TodayPage.tsx`.
//
// Render code shape (per tab, supplied by the publishing agent):
//
//     function(mount, data, lib) {
//       // body — set mount.innerHTML / append children / call lib.* helpers
//     }
//
// Helpers return HTML strings or mutate `mount` in place. Stays vanilla
// (no JSX, no React imports inside the helpers) so the body can be
// `eval`d via `new Function(...)` without a transpile step.
//
// Sync any change here with the `§ Styling contract` section of
// `skills/today/SKILL.md` — that section is the agent-facing source of
// truth and must stay aligned with this implementation.
import * as React from 'react'
import * as ReactDOM from 'react-dom/client'
import { Chart, registerables } from 'chart.js'
import { Diff2HtmlUI } from 'diff2html/lib/ui/js/diff2html-ui'
import 'diff2html/bundles/css/diff2html.min.css'

// Register every chart type (bar, line, doughnut, …) once at module
// load. Without this, `new lib.Chart(canvas, {type: 'bar', …})` throws
// "controller is not a registered controller" the first time a tab
// uses a chart.
Chart.register(...registerables)

export const tokens = {
  accent: '#6b2aa0',
  accentDeep: '#52217b',
  fg: '#111827',
  muted: '#6b7280',
  border: '#ececec',
  warn: '#b45309',
  warnBg: '#fef3c7',
  fontSans:
    'Nunito, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  fontMono: '"JetBrains Mono", ui-monospace, Menlo, monospace',
} as const

export function esc(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Chatroom-file hrefs are frozen into stored report / brief payloads, so they
// can't pick up the runtime prefix `api/client.ts` chooses (`/api` under the
// Vite dev proxy, '' in production). Whichever one the publishing agent baked
// in is wrong in the other environment. Normalize on render instead: strip a
// baked-in `/api`, re-add it only in dev.
//
// Deliberately narrow — it matches ONLY the file-download route. SPA routes
// like `/projects/<id>/chatrooms/<room>` (no `/files/` segment) and external
// URLs must pass through untouched.
const FILE_HREF_RE = /^\/(?:api\/)?projects\/[^/]+\/chatrooms\/[^/]+\/(?:user-)?files\//

export function fileHref(href: string): string {
  if (!FILE_HREF_RE.test(href)) return href
  return (import.meta.env.DEV ? '/api' : '') + href.replace(/^\/api/, '')
}

export function linkOrText(href: string | null | undefined, label?: string | null): string {
  if (!href) return esc(label || '')
  return (
    '<a class="today-link" href="' +
    esc(fileHref(href)) +
    '" target="_blank" rel="noopener">' +
    esc(label || href) +
    '</a>'
  )
}

export function row(title: string, meta?: string, right?: string): string {
  return (
    '<div class="today-row">' +
    '<div>' +
    '<div class="today-row__title">' + title + '</div>' +
    (meta ? '<div class="today-row__meta">' + meta + '</div>' : '') +
    '</div>' +
    (right ? '<div class="today-row__right">' + right + '</div>' : '') +
    '</div>'
  )
}

export function rowWithTime(
  time: string,
  duration: string | undefined,
  title: string,
  meta?: string,
  right?: string,
): string {
  let timeHtml = esc(time)
  if (duration) {
    timeHtml += '<span class="today-row__duration">' + esc(duration) + '</span>'
  }
  return (
    '<div class="today-row today-row--timed">' +
    '<div class="today-row__time">' + timeHtml + '</div>' +
    '<div style="flex:1;">' +
    '<div class="today-row__title">' + title + '</div>' +
    (meta ? '<div class="today-row__meta">' + meta + '</div>' : '') +
    '</div>' +
    (right ? '<div class="today-row__right">' + right + '</div>' : '') +
    '</div>'
  )
}

function htmlOf<T>(render: (data: T) => string) {
  return function (mount: HTMLElement, data: T) {
    mount.innerHTML = render(data ?? ({} as T))
  }
}

// Canonical reference shapes — one helper per established widget pattern.
// Render bodies prefer these one-liners when the data matches the shape;
// custom layouts fall back to lib.row / lib.rowWithTime + inline HTML.

interface ActionItemsData {
  items?: Array<{ title?: string; why?: string; source_link?: string }>
}
const renderActionItemsHtml = (d: ActionItemsData): string => {
  const items = d?.items ?? []
  if (!items.length) return '<div class="today-empty">No action items.</div>'
  return items
    .map((it) =>
      row(
        esc(it.title || ''),
        esc(it.why || ''),
        it.source_link ? linkOrText(it.source_link, 'open') : '',
      ),
    )
    .join('')
}

interface CalendarData {
  events?: Array<{
    title?: string
    time?: string
    duration?: string
    participants?: string[]
  }>
}
const renderCalendarHtml = (d: CalendarData): string => {
  const evs = d?.events ?? []
  if (!evs.length) return '<div class="today-empty">Nothing on the calendar today.</div>'
  return evs
    .map((ev) => {
      const who = ev.participants && ev.participants.length ? esc(ev.participants.join(', ')) : ''
      if (ev.time) {
        return rowWithTime(ev.time, ev.duration || '', esc(ev.title || ''), who, '')
      }
      return row(esc(ev.title || ''), who, '')
    })
    .join('')
}

interface DerivedViewsData {
  rules?: Array<{
    name?: string
    output?: string
    last_run_at?: string
    row_count?: number | null
    new_in_24h?: boolean
  }>
}
const renderDerivedViewsHtml = (d: DerivedViewsData): string => {
  const rules = d?.rules ?? []
  if (!rules.length) {
    return '<div class="today-empty">No derivation rules configured.</div>'
  }
  return rules
    .map((r) => {
      let title = esc(r.name || '')
      if (r.output) {
        title +=
          ' <span style="color:#9ca3af;font-size:12px;font-weight:400;">' +
          esc(r.output) +
          '</span>'
      }
      const meta = r.last_run_at ? 'last run ' + esc(r.last_run_at) : 'never run'
      let right = ''
      if (r.row_count != null) right += esc(String(r.row_count)) + ' rows'
      if (r.new_in_24h) right += (right ? ' ' : '') + '<span style="color:#6b2aa0;">• fresh</span>'
      return row(title, meta, right)
    })
    .join('')
}

interface DealsData {
  items?: Array<{
    title?: string
    subtitle?: string
    meta?: string
    price?: string
    link?: string
  }>
}
const renderDealsHtml = (d: DealsData): string => {
  const items = d?.items ?? []
  if (!items.length) return '<div class="today-empty">No deals flagged.</div>'
  return items
    .map((it) => {
      let titleHtml = esc(it.title || '')
      if (it.subtitle) {
        titleHtml += ' <span style="color:#9ca3af;font-weight:400;">' + esc(it.subtitle) + '</span>'
      }
      let right = ''
      if (it.price) right += esc(it.price)
      if (it.link) right += (right ? ' ' : '') + linkOrText(it.link, '↗')
      return row(titleHtml, esc(it.meta || ''), right)
    })
    .join('')
}

export const renderActionItems = htmlOf(renderActionItemsHtml)
export const renderCalendar = htmlOf(renderCalendarHtml)
export const renderDerivedViews = htmlOf(renderDerivedViewsHtml)
export const renderDeals = htmlOf(renderDealsHtml)

export function renderTimedList(
  mount: HTMLElement,
  items?: Array<{ time?: string; duration?: string; title?: string; meta?: string; right?: string }>,
): void {
  const list = items ?? []
  if (!list.length) {
    mount.innerHTML = '<div class="today-empty">Nothing scheduled.</div>'
    return
  }
  mount.innerHTML = list
    .map((it) => {
      if (it.time) {
        return rowWithTime(
          it.time,
          it.duration || '',
          esc(it.title || ''),
          esc(it.meta || ''),
          esc(it.right || ''),
        )
      }
      return row(esc(it.title || ''), esc(it.meta || ''), esc(it.right || ''))
    })
    .join('')
}

export function renderEmpty(mount: HTMLElement, message?: string): void {
  mount.innerHTML = '<div class="today-empty">' + esc(message || '') + '</div>'
}

export interface TodayLib {
  tokens: typeof tokens
  React: typeof React
  ReactDOM: typeof ReactDOM
  Chart: typeof Chart
  // diff2html UI class. Usage:
  //   const ui = new lib.Diff2HtmlUI(container, unifiedDiffText, {
  //     outputFormat: 'line-by-line', drawFileList: true, matching: 'lines',
  //   });
  //   ui.draw();
  // CSS is auto-loaded by lib.ts's side-effect import.
  Diff2HtmlUI: typeof Diff2HtmlUI
  esc: typeof esc
  linkOrText: typeof linkOrText
  row: typeof row
  rowWithTime: typeof rowWithTime
  renderActionItems: typeof renderActionItems
  renderCalendar: typeof renderCalendar
  renderDeals: typeof renderDeals
  renderDerivedViews: typeof renderDerivedViews
  renderTimedList: typeof renderTimedList
  renderEmpty: typeof renderEmpty
}

export const lib: TodayLib = {
  tokens,
  React,
  ReactDOM,
  Chart,
  Diff2HtmlUI,
  esc,
  linkOrText,
  row,
  rowWithTime,
  renderActionItems,
  renderCalendar,
  renderDeals,
  renderDerivedViews,
  renderTimedList,
  renderEmpty,
}
