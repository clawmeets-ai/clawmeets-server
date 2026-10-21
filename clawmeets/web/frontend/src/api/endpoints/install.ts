import { get, post } from '../client'

/** One step of the one-command install, as the machine reported it.
 *
 *  `state` is the MACHINE's claim about what it is doing, and it is a narrative —
 *  it decides nothing. The checklist rows on the welcome page are driven by what
 *  the SERVER observes (a live computer socket, a live agent socket, the
 *  machine's model-CLI report); a script that lied about its progress could not
 *  turn a single row green. Keep the two straight: this is "what is happening
 *  right now", those are "what is true".
 *
 *  `failed` carries the reason in `detail`. That is the only place a user learns
 *  why an install stopped halfway if they closed the terminal, so it is shown,
 *  not swallowed. */
export type InstallStepState = 'started' | 'ok' | 'failed' | 'skipped'

export interface InstallStep {
  key: string
  state: InstallStepState
  detail: string
  at: string
}

/** The declared step list, served with both the token and the progress.
 *
 *  Served rather than hardcoded here so the page can render every row greyed out
 *  BEFORE the machine has said anything — a checklist that grows one row at a
 *  time reads as a stall, not as progress. */
export interface InstallStepLabel {
  key: string
  label: string
}

/** One run of the install command. `null` when the user has never started one. */
export interface InstallRun {
  id: string
  username: string
  created_at: string
  expires_at: string
  claimed_at: string | null
  steps: InstallStep[]
  expired: boolean
  claimed: boolean
}

export interface InstallToken {
  token_id: string
  expires_at: string
  /** The whole command, assembled server-side so this app never builds it and
   *  the two cannot disagree about the verb. Contains the one-time token. */
  command: string
  /** The same install for Windows PowerShell — same token, same steps. */
  windows_command: string
  steps: InstallStepLabel[]
}

export interface InstallProgress {
  run: InstallRun | null
  steps: InstallStepLabel[]
}

/** Mint the one-time install token.
 *
 *  A POST that reads-and-returns, and deliberately never cached: each call mints
 *  a NEW single-use secret with its own one-hour clock. Holding it is equivalent
 *  to holding a magic link for this account, so it must not be replayed by a
 *  retry, refetched on window focus, or kept in a query cache. */
export async function createInstallToken(): Promise<InstallToken> {
  return post<InstallToken>('/me/install-token')
}

export async function getInstallProgress(): Promise<InstallProgress> {
  return get<InstallProgress>('/me/install-progress')
}
