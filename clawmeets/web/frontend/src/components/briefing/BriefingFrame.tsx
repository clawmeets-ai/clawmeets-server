import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import {
  BRIEF_MESSAGE_SOURCE,
  BRIEF_MESSAGE_VERSION,
  FALLBACK_FRAME_PX,
  NO_REPORT_TIMEOUT_MS,
  injectHeightBootstrap,
  parseBriefMessage,
} from './heightBootstrap'

/**
 * The sandbox flags, exported so the test asserts the SHIPPED string rather
 * than a copy of it.
 *
 * Deliberately no `allow-same-origin`: that flag is what makes the frame's
 * origin opaque, and the opacity is the whole boundary. The popup flags are
 * not decoration either — without them every link in every briefing silently
 * stops working, and an escaped popup runs on the third-party site's own
 * origin, so it gains nothing of ours. `allow-top-navigation` is absent on
 * purpose: it would let a briefing navigate the whole app away.
 */
export const BRIEF_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox'

interface BriefingFrameProps {
  /** the stored document, byte-verbatim */
  html: string
  /** envelope identity, and half the remount key */
  slug: string
  /** the other half: a republish mounts a new frame */
  generatedAt: string
  /** the iframe's accessible name */
  title: string
}

/**
 * One stored document in one opaque-origin frame.
 *
 * This replaces `RenderBody`'s `new Function('mount','data','lib','root', code)`
 * for briefings, which ran a briefing's script in the app's own realm with the
 * Bearer token, `fetch` as the user, and every other briefing's DOM in reach.
 * Rendering user HTML this way is not a new precedent here —
 * `components/files/FileViewerModal.tsx` already does it, with a comment
 * spelling out the same opaque-origin reasoning.
 *
 * KEYED on `${slug}::${generatedAt}`, which is why this wrapper exists at all:
 * a republish while the briefing is open must mount a NEW frame with fresh
 * height state rather than mutate `srcdoc` under a live document, or the old
 * measurement stays attached to new content.
 *
 * AC-2.3 containment is structural rather than coded. A malformed document or
 * a thrown script cannot leave the frame, so there is no try/catch here to get
 * wrong; what this component owes AC-2.3 is only that it never itself throws
 * on a document it cannot measure — which is what the 'failed' state is.
 */
export default function BriefingFrame(props: BriefingFrameProps) {
  return <BriefingFrameInstance key={`${props.slug}::${props.generatedAt}`} {...props} />
}

/**
 * SIZING STATE MACHINE — three states, one timer, and `height`/`failed`
 * between them:
 *   waiting : height null, failed false. FALLBACK_FRAME_PX, NO notice. A
 *             document that is merely slow must not be accused of failing.
 *   sized   : height set. The frame is exactly its content, so the page
 *             scrolls and the frame does not (AC-3.3).
 *   failed  : NO_REPORT_TIMEOUT_MS elapsed with nothing accepted. Fixed
 *             height — so the frame keeps its own scrollbar — PLUS a visible
 *             notice. This is the blessed AC-3.3 exception: a labelled
 *             failure, not a clipped tail.
 *
 * failed -> sized is allowed and deliberate. A late height clears the notice,
 * because a document that was slow past 4s is not broken and leaving a false
 * accusation on screen is worse than the wait was.
 */
function BriefingFrameInstance({ html, slug, generatedAt, title }: BriefingFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)

  const srcDoc = useMemo(() => injectHeightBootstrap(html, slug), [html, slug])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // A message is accepted only when BOTH hold, in this order: WHICH frame
      // sent it, then WHAT it means. Neither alone is sufficient and neither
      // is redundant — contentWindow identity cannot be forged but says
      // nothing about the payload, and the payload can claim anything.
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const message = parseBriefMessage(event.data, slug)
      if (!message || message.type !== 'height' || message.height === undefined) return
      setHeight(message.height)
      setFailed(false)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [slug])

  // The timer runs only while nothing has been accepted; the first height
  // cancels it through this effect's own cleanup rather than through a ref
  // the handler has to remember to clear.
  useEffect(() => {
    if (height !== null) return
    const timer = window.setTimeout(() => setFailed(true), NO_REPORT_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [height])

  // The frame measures its own content, but it cannot see the page's width
  // change around it — a sidebar resize reflows the document without the
  // document mutating. One 'remeasure' on the same envelope covers it.
  useEffect(() => {
    const onResize = () => {
      frameRef.current?.contentWindow?.postMessage(
        {
          source: BRIEF_MESSAGE_SOURCE,
          v: BRIEF_MESSAGE_VERSION,
          type: 'remeasure',
          slug,
        },
        '*',
      )
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [slug])

  return (
    <div className="md-brief-frame-wrap">
      {failed && (
        <div className="md-brief-notice" role="status">
          <AlertTriangle size={14} />
          <span>
            This briefing failed to load properly — it never reported its size, so what
            you see below may be incomplete. Its next scheduled refresh may fix it.
          </span>
        </div>
      )}
      <iframe
        ref={frameRef}
        className="md-brief-frame"
        title={title}
        srcDoc={srcDoc}
        sandbox={BRIEF_SANDBOX}
        style={{ height: height ?? FALLBACK_FRAME_PX }}
        data-slug={slug}
        data-generated-at={generatedAt}
      />
    </div>
  )
}
