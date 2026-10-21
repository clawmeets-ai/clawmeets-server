/**
 * Plain-language copy for the Google OAuth scopes ClawMeets skills request.
 *
 * Used by the pre-consent modal (G1) and the Connected-accounts panel (G2) so
 * the user sees *what* a scope grants in human terms — never a raw
 * `https://www.googleapis.com/auth/...` URL as the only label.
 *
 * The table is keyed by the scope's trailing path segment (e.g.
 * `gmail.modify`, `calendar`, `drive.readonly`, `spreadsheets`) so it is
 * resilient to the `https://www.googleapis.com/auth/` prefix. When a new
 * Google skill is added, add its scope's row here; unknown scopes fall back to
 * a generic descriptor rather than exposing the raw URL.
 */

export interface ScopeCopy {
  /** Short human title, e.g. "Gmail — read & organize". */
  title: string
  /** One-line, plain-language description of what the agent can do with it. */
  detail: string
}

const SCOPE_TABLE: Record<string, ScopeCopy> = {
  'gmail.modify': {
    title: 'Gmail — read, send & organize your mail',
    detail:
      'Read, search, label, and send email in your Gmail account. Used only for the tasks you ask the agent to do with your mail.',
  },
  calendar: {
    title: 'Google Calendar — view & manage events',
    detail:
      'See, create, edit, and delete events on your calendars so the agent can schedule and update them on your behalf.',
  },
  'drive.readonly': {
    title: 'Google Drive — read-only access',
    detail:
      'View and download the files in your Google Drive. Read-only — the agent cannot change or delete your Drive files.',
  },
  spreadsheets: {
    title: 'Google Sheets — read & edit spreadsheets',
    detail:
      'Read, append to, and update your Google Sheets so the agent can record and revise spreadsheet data you ask it to manage.',
  },
}

/** Trailing path segment of a scope URL: the part after the last `/`. */
function scopeKey(scope: string): string {
  const trimmed = scope.trim()
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/**
 * Map one Google scope to `{ title, detail }`. Falls back to a generic
 * descriptor keyed off the trailing segment so the UI never renders a bare URL
 * as the sole label for an unmapped scope. Pure — safe to call during render.
 */
export function describeScope(scope: string): ScopeCopy {
  const key = scopeKey(scope)
  const known = SCOPE_TABLE[key]
  if (known) return known
  return {
    title: `${key || scope} access`,
    detail: `Access to your ${key || scope} data on Google, used only for the tasks you ask this agent to perform.`,
  }
}

/**
 * Map each requested scope through {@link describeScope}, preserving order so
 * the rendered list matches `skill.auth.scopes` order. Pure.
 */
export function describeScopes(scopes: string[]): ScopeCopy[] {
  return scopes.map(describeScope)
}
