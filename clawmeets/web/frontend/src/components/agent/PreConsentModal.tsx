import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ShieldCheck, Lock, ExternalLink } from 'lucide-react'
import { describeScopes } from '../../utils/oauthScopeCopy'

export interface PreConsentModalProps {
  open: boolean
  /** Integration being connected, e.g. `skill.name` / `mcp.name`. */
  integrationName: string
  /** The EXACT scope(s) Google will request — no more, no less. */
  scopes: string[]
  /** `pending.auth_url` — opened only by the caller's `onContinue`. */
  authUrl: string
  privacyPolicyUrl: string
  termsUrl: string
  /** Caller opens `authUrl` (within this user gesture) and closes the modal. */
  onContinue: () => void
  onCancel: () => void
}

/**
 * Reusable, just-in-time pre-consent interstitial (gap G1). Gates the
 * "Continue with Google" affordance in both SkillCatalog and McpCatalog: the
 * user sees the integration name, the exact scope(s), a plain-language
 * data-use disclosure, and Privacy/ToS links BEFORE the browser ever leaves
 * for Google.
 *
 * Presentation-only: it never opens `authUrl` itself — the caller's
 * `onContinue` does, so navigation stays inside the user's click gesture
 * (no popup-blocker surprises) and this component stays contract-agnostic.
 * Renders nothing when `!open`.
 */
export function PreConsentModal({
  open,
  integrationName,
  scopes,
  authUrl,
  privacyPolicyUrl,
  termsUrl,
  onContinue,
  onCancel,
}: PreConsentModalProps): JSX.Element | null {
  const titleId = useId()
  const continueRef = useRef<HTMLButtonElement>(null)

  // Esc closes without navigating; autofocus the primary action on open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    continueRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  const rows = describeScopes(scopes)

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-purple-600 flex-shrink-0" />
          <h2 id={titleId} className="text-lg font-bold text-gray-900">
            Connect{' '}
            <span className="font-mono text-purple-700">{integrationName}</span>{' '}
            to Google
          </h2>
        </div>

        <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1">
          <p className="text-sm text-gray-600 leading-relaxed">
            On the next screen, Google will ask you to grant{' '}
            <span className="font-semibold text-gray-800">{integrationName}</span>{' '}
            the following access. This is the exact access it will request —
            nothing more:
          </p>

          {rows.length > 0 ? (
            <ul className="space-y-2">
              {rows.map((row, i) => (
                <li
                  key={`${row.title}-${i}`}
                  className="flex gap-2.5 rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2.5"
                >
                  <Lock className="w-3.5 h-3.5 text-gray-400 flex-shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-800">{row.title}</p>
                    <p className="text-xs text-gray-500 leading-relaxed mt-0.5">{row.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gray-500">
              Google will show the exact permissions requested on the next screen.
            </p>
          )}

          <div className="rounded-lg border border-purple-100 bg-purple-50/70 px-3 py-3 space-y-1.5">
            <p className="text-xs text-purple-900 leading-relaxed">
              <span className="font-semibold">This agent acts only on your explicit instruction.</span>{' '}
              It uses this access to carry out the tasks you ask it to do — it
              does not act on its own.
            </p>
            <p className="text-xs text-purple-900 leading-relaxed">
              Your Google data stays on your computer and is never used to train
              models or shared with third parties. You can disconnect this access
              at any time from your agent&rsquo;s settings.
            </p>
          </div>

          <p className="text-xs text-gray-500">
            By continuing you agree to our{' '}
            <a
              href={privacyPolicyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-purple-700 hover:text-purple-800 underline underline-offset-2"
            >
              Privacy Policy
            </a>{' '}
            and{' '}
            <a
              href={termsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-purple-700 hover:text-purple-800 underline underline-offset-2"
            >
              Terms of Service
            </a>
            .
          </p>
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3.5 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 text-gray-700 bg-white hover:border-gray-300"
          >
            Cancel
          </button>
          <button
            ref={continueRef}
            type="button"
            onClick={onContinue}
            disabled={!authUrl}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-accent text-white border border-accent hover:bg-accent-deep disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Continue with Google
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default PreConsentModal
