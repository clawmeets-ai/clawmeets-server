import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import Loading from '../common/Loading'
import { useUIStore } from '../../stores/uiStore'
import { useBriefTabDocument } from '../../hooks/useBriefTabs'
import { ApiError } from '../../api/client'
import { SAMPLE_BRIEF_SLUG } from '../../api/endpoints/briefTabs'
import BriefingFrame from './BriefingFrame'
import { SAMPLE_BRIEFING_HTML, SAMPLE_BRIEFING_TITLE } from './sampleBriefing'
import { FALLBACK_FRAME_PX } from './heightBootstrap'
import './briefing.css'

/**
 * Route `/desk/briefings/:slug`, under `AppLayout`.
 *
 * The URL IS the state, which is why `deskStore.openBriefSlug` / `openBrief` /
 * `closeBrief` are deleted rather than adapted. On Back this FIXES a live bug
 * rather than preserving behaviour: the overlay was store state with no
 * history entry, so pressing Back with a briefing open did not close it — it
 * navigated the user off the desk entirely (AC-3.2).
 *
 * TWO GOTCHAS, both arriving from files nobody would open to debug a briefing:
 *
 * 1. OWN SCROLL CONTAINER. `AppLayout`'s `VIEW_ROUTE` regex matches
 *    "/desk/briefings/x", so `<main>` is `h-full overflow-hidden`. Without the
 *    `overflow-y-auto` wrapper below, a tall briefing is clipped by the
 *    LAYOUT, and it reads as an AC-3.3 sizing bug in a component that sized
 *    perfectly.
 *
 * 2. `setRailContext('desk')` ON MOUNT. `Sidebar` syncs rail context from the
 *    path in a `useLayoutEffect` with `[]` deps — mount only, by design, so
 *    in-app rail clicks stay decoupled from the URL. That covers a reload of
 *    this URL and misses every in-app arrival from another context (opening a
 *    briefing while sitting in a DM), which would leave the rail showing DMs
 *    beside a briefing.
 */
export default function BriefingPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const setRailContext = useUIStore((s) => s.setRailContext)

  useEffect(() => {
    setRailContext('desk')
  }, [setRailContext])

  const isSample = slug === SAMPLE_BRIEF_SLUG
  // null disables the query outright — the sample is a local constant and must
  // never reach the network.
  const { data, isLoading, isError, error, refetch } = useBriefTabDocument(
    isSample ? null : slug
  )

  // **A 404 IS THE ONLY ANSWER THAT MEANS "UNPUBLISHED".** Everything else —
  // a 405 from a server older than this bundle, a 500, a dropped connection —
  // is a failure to LOAD, and the page must not claim to know whether the
  // briefing exists. It said so anyway once: a stale server with no
  // `GET /me/brief/tabs/{slug}` answered 405, every briefing read as
  // "no longer published", and the owner asked their agent to republish —
  // which, against that same stale server, overwrote the stored briefing with
  // an empty record. The wrong sentence is what chose the wrong repair.
  //
  // `status === 0` is the non-HTTP case (network/CORS), where `ApiError` is
  // not what was thrown at all.
  //
  // Tested ahead of the gone branch rather than folded into it, so that branch
  // keeps its exact original condition and meaning: everything that is not a
  // load failure is still "the server answered, and the briefing is not there".
  const status = error instanceof ApiError ? error.status : 0
  const failedToLoad = isError && status !== 404

  const title = isSample ? SAMPLE_BRIEFING_TITLE : data?.title || data?.slug || 'Briefing'

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="md-brief">
        <div className="md-brief-head">
          <Link to="/desk" className="md-brief-back">
            <ArrowLeft size={14} />
            My Desk
          </Link>
          <div className="md-brief-eyebrow">
            {isSample ? 'Getting started' : 'Scheduled briefing'}
          </div>
          <h1 className="md-brief-title">{title}</h1>
          {/* Provenance is app chrome and stays app chrome. Putting it inside
              the document would hand the author the app's own chrome to
              restyle; leaving it out would lose what the overlay showed. */}
          {!isSample && data && (
            <div className="md-brief-meta">
              Refreshed {new Date(data.generated_at).toLocaleString()} · by{' '}
              <span className="mono">@{data.owner_agent_name}</span>
            </div>
          )}
        </div>

        {isSample ? (
          <BriefingFrame
            html={SAMPLE_BRIEFING_HTML}
            slug={SAMPLE_BRIEF_SLUG}
            // The sample never changes, so its remount key is constant.
            generatedAt="sample"
            title={SAMPLE_BRIEFING_TITLE}
          />
        ) : isLoading ? (
          // At frame size, so the page does not jump when it resolves.
          <div
            className="md-brief-loading"
            style={{ height: FALLBACK_FRAME_PX }}
            role="status"
            aria-label="Loading briefing"
          >
            <Loading />
          </div>
        ) : failedToLoad ? (
          // Not a 404: we could not load it, and we do not know whether it is
          // still published. Say only that, and show the status — it is the
          // one detail that separates "the server is older than this page"
          // from "the server is down", and neither is something an owner fixes
          // by asking their agent to republish.
          <div className="md-brief-gone">
            <p>This briefing couldn’t be loaded.</p>
            <p className="md-brief-status">
              {status
                ? `The server answered ${status}.`
                : 'The request did not reach the server.'}
            </p>
            <button type="button" className="md-brief-retry" onClick={() => refetch()}>
              Try again
            </button>
            <Link to="/desk" className="md-brief-back">
              <ArrowLeft size={14} />
              Back to My Desk
            </Link>
          </div>
        ) : isError || !data ? (
          // A slug deleted between the list render and the click is ordinary,
          // not exceptional; a legacy artifact the server now skips arrives
          // here too, and both are the same 404 by design.
          <div className="md-brief-gone">
            <p>This briefing is no longer published.</p>
            <Link to="/desk" className="md-brief-back">
              <ArrowLeft size={14} />
              Back to My Desk
            </Link>
          </div>
        ) : (
          <BriefingFrame
            html={data.html}
            slug={data.slug}
            generatedAt={data.generated_at}
            title={title}
          />
        )}
      </div>
    </div>
  )
}
