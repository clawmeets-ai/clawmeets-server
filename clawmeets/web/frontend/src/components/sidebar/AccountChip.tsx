import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Check, LogOut, Settings, UserPlus } from 'lucide-react'
import { isSessionExpired, useAuthStore, type Session } from '../../stores/authStore'
import { useSwitchAccount } from '../../hooks/useSwitchAccount'
import { useLogout } from '../../hooks/useLogout'
import SidebarAvatar from './SidebarAvatar'

/**
 * AC-4.1 — the account chip at the foot of the 68px rail, replacing the avatar
 * that used to be a bare `Link to="/settings"`.
 *
 * WHAT MOVED. The old avatar's ONLY job was to reach Settings, so Settings is
 * the first row of the popover rather than a casualty of the replacement.
 * "Sign out" joins it: it is an account action, the popover is now the account
 * surface, and leaving it findable only on the Settings page would make the one
 * destructive account action the hardest one to find.
 *
 * NO PER-ACCOUNT COLOUR (AC-4.1, and it is a correctness point rather than a
 * taste one). `SidebarAvatar` hashes a name to one of six `--av-*` tokens, which
 * is right for a roster of agents and wrong for a list of YOUR OWN accounts:
 * the colour would be the most salient thing on a row whose real content is
 * "active" vs "expired", and two accounts landing on the same hash bucket would
 * read as a relationship that does not exist. Every tile here is `--accent`,
 * and the states are carried by text and a badge — which is also what makes
 * them legible to a screen reader (AC-4.3) rather than to sighted users only.
 */

/** AC-4.2's three states, computed per row. `active` and `expired` are
 *  independent facts about one session and both are rendered — an expired
 *  ACTIVE session is a real state (the refresh credential ran out under the
 *  account you are looking at) and saying only "active" about it would be a lie
 *  by omission at the exact moment the user is about to be signed out. */
interface Row {
  session: Session
  isActive: boolean
  isExpired: boolean
}

/** What a click on a row does — `null` for the one row that does NOTHING.
 *
 *  B21. `useSwitchAccount()` redirects to `/` UNCONDITIONALLY, per AC-3.6, and
 *  that is not changing: conditioning the redirect on whether the store decided
 *  a switch had happened is exactly the "which URLs are safe to keep" reasoning
 *  AC-3.6 rules out. The fix belongs on THIS side of the call, and the hook's
 *  own comment says so — "a caller that does not want the redirect should not
 *  offer the active account as a switch target". So the active row is not a
 *  button at all. A mis-click on your own name is the single most likely
 *  accidental interaction with this popover, and it now costs nothing.
 *
 *  An expired row is still clickable, because re-authorising is NOT a switch:
 *  it routes to AC-4.4's surface pre-filled, which is a deliberate navigation
 *  the user asked for. */
type RowAction = (() => void) | null

interface Pos {
  left: number
  bottom: number
}

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

export default function AccountChip({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate()
  const switchAccount = useSwitchAccount()
  const logout = useLogout()
  // `listSessions()` returns the store's own array by reference, so this
  // selector is referentially stable and re-runs only when the bag changes —
  // the same read `VerifyEmailPage` does.
  const sessions = useAuthStore((s) => s.listSessions())
  const activeUserId = useAuthStore((s) => s.activeUserId)

  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<Pos>({ left: 76, bottom: 12 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  /**
   * AC-4.3 — FOCUS IS RESTORED, not merely released. Closing has exactly one
   * implementation so no path (Escape, backdrop, a row, Settings, Sign out) can
   * forget to hand focus back to the chip and strand a keyboard user at the top
   * of the document.
   *
   * `restore` is false for the paths that navigate away: focusing a trigger
   * that is about to unmount, or that now sits under a different page, moves
   * the user backwards.
   */
  const close = useCallback((restore = true) => {
    setOpen(false)
    if (restore) triggerRef.current?.focus()
  }, [])

  const toggle = () => {
    if (open) {
      close()
      return
    }
    // Measured at OPEN time, not on every render: the rail does not move while
    // the popover is up, and reading layout on each paint to find that out
    // would be the expensive way to learn nothing.
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) {
      setPos({
        left: rect.right + 8,
        // Bottom-anchored to the chip, then clamped into the viewport so a
        // short window cannot push the list off the top edge.
        bottom: Math.min(Math.max(8, window.innerHeight - rect.bottom), window.innerHeight - 8),
      })
    }
    setOpen(true)
  }

  /**
   * AC-4.3 — THE FOCUS TRAP. A DELIBERATE FIFTH COPY, and the plan says so in
   * the criterion itself: `CommandPalette`, `PhPopover`, `LabelFilter` and
   * `DeskAgentPicker` each roll their own, and extracting a shared primitive is
   * on the AC-6.4 backlog (B1) rather than smuggled in here under the
   * no-while-we're-in-there guardrail. It is copied, not skimped: those four
   * only FOCUS something on open, and a popover that can be tabbed out of while
   * still painted over the page is the accessibility failure this criterion
   * exists to close.
   *
   * Capture phase, on `document`. The popover is portalled to `document.body`,
   * so a bubbling listener on the popover node would never see a Tab pressed
   * from wherever focus escaped to.
   */
  useEffect(() => {
    if (!open) return
    const node = popRef.current
    if (!node) return

    const focusables = () => Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE))
    focusables()[0]?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return
      }
      const list = focusables()
      if (list.length === 0) return
      const at = list.indexOf(document.activeElement as HTMLElement)

      // Arrows walk the list, matching every other keyboard surface in this app
      // (the palette, the agent picker). Tab still works; this is the shortcut,
      // not the requirement.
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        const next = at === -1 ? 0 : (at + step + list.length) % list.length
        list[next]?.focus()
        return
      }
      if (e.key !== 'Tab') return

      // Wrap at both ends, and pull focus back in if it has already escaped
      // (a click on the backdrop leaves `document.body` focused).
      const first = list[0]
      const last = list[list.length - 1]
      if (at === -1) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && at === 0) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && at === list.length - 1) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, close, sessions])

  const active = sessions.find((s) => s.userId === activeUserId)
  if (!active) return null

  const now = Date.now()
  const rows: Row[] = sessions.map((session) => ({
    session,
    isActive: session.userId === activeUserId,
    isExpired: isSessionExpired(session, now),
  }))
  const expiredCount = rows.filter((r) => r.isExpired).length

  const goAddAccount = (username?: string) => {
    close(false)
    onNavigate?.()
    navigate(username ? `/account/add?username=${encodeURIComponent(username)}` : '/account/add')
  }

  const actionFor = (row: Row): RowAction => {
    // Order matters: an expired row re-authorises whether or not it is the
    // active one. Switching TO a dead session would land on an account whose
    // very next request 401s the user straight back out.
    if (row.isExpired) return () => goAddAccount(row.session.user.username)
    if (row.isActive) return null
    return () => {
      close(false)
      onNavigate?.()
      switchAccount(row.session.userId)
    }
  }

  /** The one place a row's state is spelled for a screen reader (AC-4.3).
   *  "active" and "expired" are DISTINCT words in distinct clauses, and the
   *  clause also says what the click will do — the visual badge and the
   *  accessible name cannot drift because they are built from the same two
   *  booleans, here. */
  const labelFor = (row: Row): string => {
    const name = row.session.user.username
    if (row.isExpired) {
      return row.isActive
        ? `${name}, active, session expired — sign in again`
        : `${name}, session expired — sign in again`
    }
    return row.isActive ? `${name}, active account` : `Switch to ${name}`
  }

  const chipLabel =
    sessions.length > 1
      ? `Accounts — signed in as ${active.user.username}, ${sessions.length} accounts`
      : `Account — signed in as ${active.user.username}`

  return (
    <>
      <button
        ref={triggerRef}
        onClick={toggle}
        className="relative flex items-center justify-center mt-1"
        style={{ width: 34, height: 34, borderRadius: 11 }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={chipLabel}
        title={chipLabel}
      >
        {/* Fixed `--accent` fill: AC-4.1's "no per-account colour". */}
        <SidebarAvatar name={active.user.username} size={30} color="var(--accent)" />
        {sessions.length > 1 && (
          <span
            className="absolute flex items-center justify-center font-extrabold text-white"
            style={{
              right: -1,
              bottom: -1,
              minWidth: 15,
              height: 15,
              padding: '0 3px',
              borderRadius: 8,
              fontSize: 9.5,
              lineHeight: 1,
              background: expiredCount > 0 ? 'var(--prio-urgent-fg)' : 'var(--ink-2)',
              boxShadow: '0 0 0 2px var(--bg-sidebar-section)',
            }}
            aria-hidden="true"
          >
            {sessions.length}
          </span>
        )}
      </button>

      {/* AC-4.1's PORTAL. The rail is a 68px column; a popover positioned inside
          it is clipped by every ancestor that scrolls or hides overflow, and the
          list has to be wider than its own trigger by construction. */}
      {open &&
        createPortal(
          <div className="fixed inset-0 z-50" onClick={() => close()}>
            <div
              ref={popRef}
              role="dialog"
              aria-modal="true"
              aria-label="Accounts"
              className="fixed flex flex-col bg-white overflow-hidden"
              style={{
                left: pos.left,
                bottom: pos.bottom,
                width: 260,
                borderRadius: 12,
                border: '1px solid var(--line-2)',
                boxShadow: 'var(--shadow-pop)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                className="px-3 pt-2.5 pb-1 font-extrabold uppercase"
                style={{ fontSize: 10.5, letterSpacing: '0.08em', color: 'var(--ink-4)' }}
              >
                Accounts
              </div>

              <div className="flex flex-col px-1.5 pb-1.5 gap-0.5">
                {rows.map((row) => (
                  <AccountRow key={row.session.userId} row={row} label={labelFor(row)} onPick={actionFor(row)} />
                ))}
              </div>

              <div style={{ borderTop: '1px solid var(--line-1)' }} className="flex flex-col p-1.5 gap-0.5">
                <MenuButton icon={UserPlus} label="Add another account" onClick={() => goAddAccount()} />
                <MenuButton
                  icon={Settings}
                  label="Account settings"
                  onClick={() => {
                    close(false)
                    onNavigate?.()
                    navigate('/settings')
                  }}
                />
                <MenuButton
                  icon={LogOut}
                  label={sessions.length > 1 ? `Sign out of ${active.user.username}` : 'Sign out'}
                  onClick={() => {
                    // `useLogout()` owns (end session + navigate) and ends only
                    // the ACTIVE session (AC-3.2) — with two accounts in the bag
                    // this signs out of one, which is why the label names it.
                    close(false)
                    logout()
                  }}
                />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

/**
 * One account. Rendered as a BUTTON when it does something and as a plain row
 * when it does not (B21) — the element type is the affordance, so the active
 * row is not merely inert but visibly and audibly not a control.
 */
function AccountRow({ row, label, onPick }: { row: Row; label: string; onPick: RowAction }) {
  const name = row.session.user.username
  const body = (
    <>
      <SidebarAvatar name={name} size={22} color="var(--accent)" ringColor="#ffffff" />
      <span className="flex flex-col min-w-0 flex-1 text-left">
        <span className="truncate font-semibold" style={{ fontSize: 13, color: 'var(--ink-1)' }}>
          {name}
        </span>
        {/* AC-4.2's state line, and AC-4.3's "labels distinguish active from
            expired" in the visual half. A signed-in background account gets no
            second line at all: "nothing is wrong and you are not on it" is the
            default, and captioning it would drown the two states that matter. */}
        {row.isExpired ? (
          <span className="truncate font-semibold" style={{ fontSize: 11, color: 'var(--prio-urgent-fg)' }}>
            Session expired — sign in again
          </span>
        ) : row.isActive ? (
          <span className="truncate" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
            Active
          </span>
        ) : null}
      </span>
      {row.isActive && <Check className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--accent)' }} />}
    </>
  )

  if (!onPick) {
    return (
      <div
        className="flex items-center gap-2 px-2 py-1.5 rounded-lg"
        style={{ background: 'var(--accent-softer)' }}
        aria-current="true"
        aria-label={label}
      >
        {body}
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={onPick}
      aria-current={row.isActive ? 'true' : undefined}
      aria-label={label}
      className="flex items-center gap-2 w-full px-2 py-1.5 rounded-lg hover:bg-[var(--bg-card-hover)]"
    >
      {body}
    </button>
  )
}

function MenuButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof UserPlus
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 w-full px-2 py-1.5 rounded-lg text-left hover:bg-[var(--bg-card-hover)]"
      style={{ fontSize: 13, color: 'var(--ink-2)' }}
    >
      <Icon className="w-4 h-4 flex-shrink-0" />
      <span className="truncate font-semibold">{label}</span>
    </button>
  )
}
