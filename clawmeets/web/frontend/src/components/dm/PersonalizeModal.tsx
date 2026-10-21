import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Upload,
  MessageSquareText,
  Sparkles,
  Copy,
  Check,
  ChevronLeft,
  ChevronRight,
  X,
} from 'lucide-react'

// How the user wants to hand their profile to the assistant. Each maps to a
// different templated DM body (buildBody) — all carrying the hidden trigger so
// /clawmeets:personalize fires on the assistant's side.
export type PersonalizeMethod = 'upload' | 'export' | 'questions'

export interface PersonalizeResult {
  method: PersonalizeMethod
  // Fully-assembled DM body, incl. the hidden `personalize-trigger` comment.
  // The parent (DMChatView) owns the actual send.
  body: string
}

export interface PersonalizeModalProps {
  agentLabel: string // display name, for "@name" copy
  onConfirm: (r: PersonalizeResult) => void // parent owns the actual send
  onClose: () => void
}

// Every personalize DM is prefixed with this so the assistant's runner fires
// the /clawmeets:personalize skill (assistant variant → USER.md interview).
const TRIGGER = '<!-- clawmeets:personalize-trigger -->\n\n'

// The exact copy-paste prompt from the request, shown read-only in the 'export'
// detail panel with a Copy button. Kept verbatim — do not reword.
const EXPORT_PROMPT = `You've talked with me across many conversations and have memory of who I am. I'm setting up a personal AI assistant and it needs a concise profile of me. Based on everything you know about me — my past questions, projects, tone, and stated goals — write a profile with these exact sections. Be specific and cite concrete examples from our history where you can. If you genuinely don't know something, write "unknown" rather than guessing.

Role & industry — my job/title, the field I work in, and what I actually do day to day.
Geography — where I'm based / what timezone & market I operate in.
Voice & tone — how I write and how I like to be replied to (terse vs. detailed, formal vs. casual, bullets vs. prose). Infer this from how I phrase things, not just what I ask.
Themes I care about — the recurring topics, values, or obsessions that show up again and again across our chats.
Current priorities — the top 1–3 things on my plate right now; what would make me happy if it landed this quarter.
Do-not preferences — things I dislike, avoid, or have pushed back on (formats, assumptions, tools, phrasings).
Reasoning style — how I think and decide: gut vs. data, decisive vs. iterative, optimistic vs. risk-averse, big-picture vs. detail-first.

Keep the whole thing under ~500 words. Use plain markdown with those seven headers. Write it as a factual profile about me (third person or "you"), not as advice to me.`

// The three methods, in display order. Copy is intentionally short — the detail
// panel carries the fuller explanation + CTA.
const METHODS: {
  key: PersonalizeMethod
  icon: typeof Upload
  title: string
  blurb: string
}[] = [
  {
    key: 'upload',
    icon: Upload,
    title: 'Upload your résumé or LinkedIn',
    blurb: 'Attach a résumé or a LinkedIn screenshot — I read it and build your profile.',
  },
  {
    key: 'export',
    icon: MessageSquareText,
    title: 'Export from ChatGPT or Claude',
    blurb: 'Copy a prompt, ask ChatGPT/Claude to describe you, then paste the result back.',
  },
  {
    key: 'questions',
    icon: Sparkles,
    title: 'Answer a few questions',
    blurb: "I ask a short round of questions and build your profile from your answers.",
  },
]

// Assemble the DM body for each method. `profile` is used only by 'export'
// (the text the user pasted back from ChatGPT/Claude). Every body is prefixed
// with TRIGGER so the assistant runs /clawmeets:personalize.
function buildBody(method: PersonalizeMethod, profile?: string): string {
  if (method === 'upload') {
    return (
      TRIGGER +
      "Let's set up my profile. I'm attaching my résumé (or a screenshot of my " +
      "LinkedIn) — read it, ask me the couple of things it can't tell you, then " +
      'build a picture of who I am and how I like to work.'
    )
  }
  if (method === 'export') {
    return (
      TRIGGER +
      "Here's a profile of me I generated with ChatGPT/Claude. Use it to set up " +
      'my profile, and ask me about anything important that looks missing:\n\n' +
      (profile ?? '').trim()
    )
  }
  // questions
  return (
    TRIGGER +
    "Let's set up my profile by talking it through. Ask me a short round of " +
    'questions about my role, how I work, and what I care about — then build a ' +
    'picture of who I am and how I like to work.'
  )
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Two-phase personalize modal (styled after DmComposeModal): 'choose' shows the
// three method cards; picking one advances to a per-method detail panel with a
// sensible CTA. On confirm it hands a fully-assembled DM body up to the parent,
// which owns the send (create-thread-if-draft, else send-into-thread). Reuses
// DmComposeModal's shell conventions: portal to <body>, fixed backdrop,
// role="dialog"/aria-modal, Esc-to-close + Tab focus-trap, restore focus on
// unmount, click-outside close.
export default function PersonalizeModal({
  agentLabel,
  onConfirm,
  onClose,
}: PersonalizeModalProps) {
  // phase: 'choose' → the picker; otherwise the selected method's detail panel.
  const [phase, setPhase] = useState<'choose' | PersonalizeMethod>('choose')
  // 'export'-only local state.
  const [copied, setCopied] = useState(false)
  const [profile, setProfile] = useState('')

  const dialogRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const titleId = 'personalize-title'

  const back = useCallback(() => {
    setPhase('choose')
    setCopied(false)
  }, [])

  const submitMethod = (method: PersonalizeMethod) => {
    onConfirm({ method, body: buildBody(method, method === 'export' ? profile : undefined) })
  }

  const handleCopy = () => {
    navigator.clipboard?.writeText(EXPORT_PROMPT).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }

  // Esc dismiss (Back from a detail panel, else close) + Tab focus-trap, scoped
  // to the dialog — mirrors DmComposeModal.handleDialogKeyDown.
  const handleDialogKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault()
      if (phase === 'choose') onClose()
      else back()
      return
    }
    if (e.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (nodes.length === 0) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    const active = document.activeElement as HTMLElement | null
    if (e.shiftKey && active === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  // Remember the trigger element and restore focus to it when the modal unmounts.
  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null
    return () => restoreFocusRef.current?.focus?.()
  }, [])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/50" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
        className="relative bg-white rounded-xl shadow-xl w-full max-w-lg flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-start gap-2 min-w-0">
            {phase !== 'choose' && (
              <button
                type="button"
                onClick={back}
                aria-label="Back"
                className="mt-0.5 p-1 -ml-1 rounded-md text-gray-500 hover:bg-gray-100"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
            )}
            <div className="min-w-0">
              <h3 id={titleId} className="text-lg font-semibold text-gray-900">
                Personalize your assistant
              </h3>
              <p className="mt-0.5 text-sm text-gray-500">
                Set up <span className="font-mono text-gray-700">@{agentLabel}</span> so it knows you from day one.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md text-gray-500 hover:bg-gray-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 overflow-y-auto">
          {phase === 'choose' && (
            <div className="space-y-2.5">
              {METHODS.map(({ key, icon: Icon, title, blurb }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setPhase(key)}
                  className="group w-full text-left flex items-center gap-3.5 rounded-xl px-4 py-3.5 bg-white border border-gray-200 hover:border-accent-deep hover:bg-purple-50/40 hover:shadow-sm transition-all"
                >
                  <span className="shrink-0 w-10 h-10 rounded-xl bg-accent-deep text-white flex items-center justify-center">
                    <Icon className="w-5 h-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-bold text-gray-900">{title}</span>
                    <span className="block text-[12.5px] text-gray-500 leading-relaxed mt-0.5">
                      {blurb}
                    </span>
                  </span>
                  <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-accent-deep shrink-0" />
                </button>
              ))}
            </div>
          )}

          {phase === 'upload' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-600 leading-relaxed">
                On <strong>Attach &amp; continue</strong> I'll drop a note into the composer and open your
                file picker. Pick your résumé (PDF/DOC) or a screenshot of your LinkedIn, then hit
                <strong> send</strong> — @{agentLabel} reads it and builds your profile.
              </p>
            </div>
          )}

          {phase === 'export' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-600 leading-relaxed">
                Copy this prompt, paste it into ChatGPT or Claude, and paste whatever profile it writes
                back into the box below.
              </p>
              <div className="relative">
                <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-gray-700">
                  {EXPORT_PROMPT}
                </pre>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] font-medium text-gray-600 shadow-sm hover:bg-gray-50"
                >
                  {copied ? (
                    <>
                      <Check className="w-3 h-3 text-green-600" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" /> Copy prompt
                    </>
                  )}
                </button>
              </div>
              <div>
                <label
                  htmlFor="personalize-profile"
                  className="mb-1 block text-sm font-medium text-gray-700"
                >
                  Paste the profile you got back
                </label>
                <textarea
                  id="personalize-profile"
                  value={profile}
                  onChange={(e) => setProfile(e.target.value)}
                  rows={5}
                  placeholder="Paste the profile ChatGPT or Claude wrote about you…"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-purple-500/30 focus:border-purple-400"
                />
              </div>
            </div>
          )}

          {phase === 'questions' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-600 leading-relaxed">
                Nothing to prepare — on <strong>Start Q&amp;A</strong>, @{agentLabel} asks you a short round
                of questions about your role, how you work, and what you care about, then builds your
                profile from your answers.
              </p>
            </div>
          )}
        </div>

        {/* Actions — only in a detail phase; the picker advances on card click. */}
        {phase !== 'choose' && (
          <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200">
            <button
              type="button"
              onClick={back}
              className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg"
            >
              Back
            </button>
            {phase === 'upload' && (
              <button
                type="button"
                onClick={() => submitMethod('upload')}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-accent rounded-lg hover:bg-accent-deep transition-colors"
              >
                <Upload className="w-4 h-4" />
                Attach &amp; continue
              </button>
            )}
            {phase === 'export' && (
              <button
                type="button"
                onClick={() => submitMethod('export')}
                disabled={profile.trim().length === 0}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-accent rounded-lg hover:bg-accent-deep disabled:bg-accent-soft disabled:cursor-not-allowed transition-colors"
              >
                <Sparkles className="w-4 h-4" />
                Send to @{agentLabel}
              </button>
            )}
            {phase === 'questions' && (
              <button
                type="button"
                onClick={() => submitMethod('questions')}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-accent rounded-lg hover:bg-accent-deep transition-colors"
              >
                <Sparkles className="w-4 h-4" />
                Start Q&amp;A
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
