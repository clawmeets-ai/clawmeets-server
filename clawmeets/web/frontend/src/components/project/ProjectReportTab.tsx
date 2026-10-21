import { useCallback, useMemo, useRef } from 'react'
import { Download } from 'lucide-react'
import { useProjectReport } from '../../hooks/useProjectReport'
import { RenderBody } from '../shared/RenderBody'
import Loading from '../common/Loading'
import '../today/today.css'
import IsolationUnavailablePanel from '../common/IsolationUnavailablePanel'
import { isIsolationUnavailable } from '../../utils/agentAccessCopy'

// Renders the coordinator-authored interactive report for a project,
// using the same compile-and-mount substrate as /today tabs (shared
// <RenderBody>, shared `lib` namespace, shared CSS). The coordinator
// publishes via `clawmeets project upsert-report`; this component
// refetches on PROJECT_REPORT_SYNC and re-runs the render body in
// place.

export function ProjectReportTab({
  projectId,
  active,
}: {
  projectId: string
  active: boolean
}) {
  const { data: report, isLoading, error } = useProjectReport(projectId)
  const printRootRef = useRef<HTMLDivElement | null>(null)

  const refreshed = useMemo(() => {
    if (!report) return ''
    const dt = new Date(report.generated_at)
    return Number.isNaN(dt.getTime()) ? report.generated_at : dt.toLocaleString()
  }, [report])

  // Export to PDF via the browser's native print pipeline. The report is
  // already rendered live in the DOM (Chart.js canvases included). To get clean
  // multi-page pagination we reparent the live report node to <body> for the
  // duration of printing: nested overflow/height scroll containers in the app
  // shell otherwise clip it to one page. Moving (not cloning) the node keeps the
  // rendered canvas bitmaps and the same stylesheets; `body.printing-report`
  // (today.css) hides everything else. A placeholder marks the restore spot, and
  // `afterprint` puts the node back exactly where it was. document.title is
  // briefly swapped so the saved PDF defaults to the report name.
  const handleExport = useCallback(() => {
    const root = printRootRef.current
    if (!root) {
      window.print()
      return
    }
    const parent = root.parentNode
    const placeholder = document.createElement('div')
    placeholder.style.display = 'none'
    parent?.insertBefore(placeholder, root)
    document.body.appendChild(root)
    document.body.classList.add('printing-report')

    const prevTitle = document.title
    if (report?.title) document.title = report.title

    const restore = () => {
      window.removeEventListener('afterprint', restore)
      document.body.classList.remove('printing-report')
      if (placeholder.parentNode) {
        placeholder.parentNode.replaceChild(root, placeholder)
      }
      document.title = prevTitle
    }
    window.addEventListener('afterprint', restore)
    window.print()
  }, [report?.title])

  if (!active) return null

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loading size="md" />
      </div>
    )
  }

  if (isIsolationUnavailable(error)) return <IsolationUnavailablePanel />
  if (error) {
    return (
      <div className="px-6 py-10 text-center text-sm text-channel">
        Couldn&rsquo;t load the report.
      </div>
    )
  }

  if (!report) {
    return (
      <div className="px-6 py-16 text-center max-w-md mx-auto">
        <h3 className="text-base font-semibold text-channel-active mb-2">
          No report yet
        </h3>
        <p className="text-sm text-channel leading-relaxed">
          When the coordinator wraps up the project, they&rsquo;ll publish
          an interactive report here &mdash; charts, conclusions, and the
          supporting rationale &mdash; so you can absorb the findings
          without scrolling chat history.
        </p>
      </div>
    )
  }

  return (
    <div
      ref={printRootRef}
      className="report-print-root w-full max-w-3xl mx-auto px-6 lg:px-8 py-8"
    >
      <div className="flex items-start justify-between gap-4 mb-1">
        {report.title ? (
          <h2 className="text-2xl font-extrabold tracking-tight text-channel-active">
            {report.title}
          </h2>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={handleExport}
          className="report-print-hide shrink-0 inline-flex items-center gap-1.5 rounded-md border border-channel/30 px-2.5 py-1.5 text-[13px] font-medium text-channel hover:text-channel-active hover:bg-channel/10 transition-colors"
          title="Export this report as a PDF"
        >
          <Download size={14} />
          Export PDF
        </button>
      </div>
      <div className="text-[12px] uppercase tracking-[0.12em] text-channel mb-6">
        Refreshed {refreshed} · by @{report.generated_by_agent_name}
      </div>
      <RenderBody
        renderCodeJs={report.render_code_js}
        data={report.data}
        runKey={`${projectId}::${report.generated_at}`}
        active={active}
      />
    </div>
  )
}
