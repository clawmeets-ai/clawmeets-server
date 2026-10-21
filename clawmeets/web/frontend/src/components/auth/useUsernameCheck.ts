import { useEffect, useRef, useState } from 'react'
import { checkUsername } from '../../api/endpoints/auth'
import type { FieldStatus } from './AuthShell'

// Public username rules — MIRROR the backend (User._validate_username +
// MIN_PUBLIC_USERNAME_LENGTH), NOT the design prototype's demo rules: lowercase
// letters / numbers / underscores (no hyphens — the backend rejects them), min 5.
// The 20-char ceiling is a UI nicety. Server-side is still the source of truth;
// this only shapes the live message + gates the Continue button.
const USERNAME_RE = /^[a-z0-9_]+$/
const MIN_LEN = 5
const MAX_LEN = 20
const DEBOUNCE_MS = 550

interface UsernameCheck {
  value: string
  setValue: (v: string) => void
  status: FieldStatus
  msg: string
  clean: string
}

/**
 * Live, debounced username-availability check for the sign-up flow's Step 2.
 * Runs local format validation synchronously, then hits GET
 * /auth/username-available after a debounce. A monotonic request id guards
 * against out-of-order responses so a stale reply can't clobber a newer one.
 */
export function useUsernameCheck(initial = ''): UsernameCheck {
  const [value, setValue] = useState(initial)
  const [status, setStatus] = useState<FieldStatus>('idle')
  const [msg, setMsg] = useState('')
  const reqId = useRef(0)

  const clean = value.trim().toLowerCase()

  useEffect(() => {
    // Bump the request id every keystroke so any in-flight response is ignored.
    const id = ++reqId.current
    const v = clean
    if (!v) {
      setStatus('idle')
      setMsg('')
      return
    }
    if (!USERNAME_RE.test(v)) {
      setStatus('bad')
      setMsg('Only lowercase letters, numbers and underscores.')
      return
    }
    if (v.length < MIN_LEN) {
      setStatus('bad')
      setMsg(`At least ${MIN_LEN} characters.`)
      return
    }
    if (v.length > MAX_LEN) {
      setStatus('bad')
      setMsg(`${MAX_LEN} characters max.`)
      return
    }
    setStatus('checking')
    setMsg('Checking availability…')
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const { available, reason } = await checkUsername(v)
          if (id !== reqId.current) return // superseded by a newer keystroke
          if (available) {
            setStatus('ok')
            setMsg(`@${v} is available!`)
          } else {
            setStatus('bad')
            setMsg(reason || `@${v} is taken.`)
          }
        } catch {
          if (id !== reqId.current) return
          setStatus('bad')
          setMsg("Couldn't check that username. Try again.")
        }
      })()
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [clean])

  return { value, setValue, status, msg, clean }
}
