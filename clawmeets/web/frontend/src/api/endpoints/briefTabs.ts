import { del, get } from '../client'

/** One briefing's metadata — the shape `GET /me/brief/tabs` returns, and
 *  exactly the six fields the server puts on the wire there.
 *
 *  There is NO `html` key on this shape, and that is the read path rather than
 *  an omission: the list is metadata only, and the document is fetched per
 *  slug when a briefing is opened. That is what pays for the 256 KB cap — a
 *  desk with twenty briefings would otherwise load up to 5 MB to render a
 *  sidebar of titles.
 *
 *  (`html_bytes` exists in the on-disk sidecar and is stripped before
 *  serialization, so there is deliberately no field for it here.) */
export interface BriefTab {
  slug: string
  title: string
  owner_user_id: string
  owner_agent_id: string
  owner_agent_name: string
  generated_at: string
}

/** The stored document plus its metadata, from `GET /me/brief/tabs/{slug}`.
 *
 *  `html` is one complete `<!doctype html>` document, UTF-8, stored and
 *  returned byte-verbatim — the author owns it entirely and the server never
 *  parses, sanitizes or re-serializes it. It replaced the old `data` +
 *  `render_code_js` pair. */
export interface BriefTabDocument extends BriefTab {
  html: string
}

export async function getBriefTabs(): Promise<BriefTab[]> {
  return get<BriefTab[]>('/me/brief/tabs')
}

/** One briefing's document.
 *
 *  The response carries `ETag: "<generated_at>"` and
 *  `Cache-Control: private, no-cache`, and there is deliberately no ETag code
 *  here: `get()` goes through the plain fetch wrapper with no cache mode set,
 *  so the browser issues `If-None-Match` and serves the 304 transparently.
 *  Handling the tag by hand would duplicate the browser and leave us a second
 *  cache to keep coherent. The `no-cache` directive is what makes that
 *  revalidation specified rather than heuristic.
 *
 *  An unknown slug and another user's slug are the SAME 404, so existence does
 *  not leak; the caller treats both as "no longer published". */
export async function getBriefTab(slug: string): Promise<BriefTabDocument> {
  return get<BriefTabDocument>(`/me/brief/tabs/${encodeURIComponent(slug)}`)
}

/** Delete one of the owner's own briefings.
 *
 *  Goes out on the owner's user JWT with NO `X-Agent-ID` — the route reads
 *  that absence as "the owner is doing this themselves" and takes the user
 *  path, which is the same door `clawmeets brief delete-tab` deliberately does
 *  not use (the CLI sends the agent header and is checked against the
 *  publishing agent instead).
 *
 *  A 404 here is ordinary, not exceptional: the briefing was already deleted
 *  from another tab, or by the agent that published it, between the rail's
 *  last list read and this click. The caller reports it and leaves the rail to
 *  the refetch rather than treating it as a broken delete.
 *
 *  Never call this with `SAMPLE_BRIEF_SLUG`: that document is a local constant
 *  the server has never heard of, and its leading underscore does not even
 *  survive `validate_slug`, so the request could only ever come back 400. The
 *  rail omits the control on that row rather than relying on this note. */
export async function deleteBriefTab(slug: string): Promise<void> {
  await del<{ status: string; slug: string }>(
    `/me/brief/tabs/${encodeURIComponent(slug)}`,
  )
}

/** Reserved slug for the onboarding sample shown when the user owns no real
 *  briefings. Never issued by the server: it addresses a local constant
 *  document, so `/desk/briefings/__sample__` renders through the same frame as
 *  a published one without a request. The double-underscore convention keeps
 *  it from colliding with a real server-issued slug. */
export const SAMPLE_BRIEF_SLUG = '__sample__'
