/**
 * The height bootstrap: the one script the desk inserts into a briefing, the
 * string function that inserts it, and the envelope both sides speak.
 *
 * Pure — no React, no DOM. Everything here is either a string or a predicate
 * over a message payload, which is why it carries the cheapest and the most
 * load-bearing tests in this milestone: jsdom does not execute iframe scripts,
 * so the injection point and the envelope validator are the parts of the
 * sizing path a headless suite can actually observe.
 */

/** The envelope literal. NOT 'clawmeets-briefing' — a briefing whose author
 *  guessed the longer name must not be able to resize its own frame, and a
 *  desk that accepted both would have two contracts. */
export const BRIEF_MESSAGE_SOURCE = 'clawmeets-brief'
export const BRIEF_MESSAGE_VERSION = 1

export type BriefMessageType = 'height' | 'ready' | 'error' | 'remeasure'

/** child -> parent for 'height' / 'ready' / 'error'; parent -> child for
 *  'remeasure'. One shape both ways so there is one thing to validate. */
export interface BriefMessage {
  source: typeof BRIEF_MESSAGE_SOURCE
  v: typeof BRIEF_MESSAGE_VERSION
  type: BriefMessageType
  slug: string
  /** integer CSS px; present on 'height' */
  height?: number
  /** present on 'error'; diagnostic only, never rendered as the author's */
  message?: string
}

/** Height bounds. These are not tidiness: an unbounded height is not a
 *  rendering bug, it is a 2,000,000px iframe that hangs the desk. */
export const MIN_FRAME_PX = 120
export const MAX_FRAME_PX = 20_000

/** What the frame stands at before it has been told anything, and what it
 *  keeps if it never is. */
export const FALLBACK_FRAME_PX = 640

/** How long a silent document gets before its frame says so. Long enough that
 *  a heavy document pulling a CDN chart library over a slow connection is not
 *  accused of failing; short enough that a genuinely dead script does not
 *  leave the user staring at a box. */
export const NO_REPORT_TIMEOUT_MS = 4_000

const HEAD_OPEN = /<head(?:\s[^>]*)?>/i
const HTML_OPEN = /<html(?:\s[^>]*)?>/i
const DOCTYPE = /<!doctype[^>]*>/i

/**
 * The script the shell inserts as the first child of `<head>`. Never stored,
 * so it never counts against the author's 256 KB.
 *
 * REGISTERED SYNCHRONOUSLY, at head-parse time, so all three survive an author
 * script that throws on its first line:
 *   - the `error` handler, which reports but deliberately does NOT
 *     preventDefault — the author still sees their own error in the console;
 *   - the parent-message listener, for 'remeasure';
 *   - a readystate hook that attaches the observers once `<body>` exists.
 *
 * The observers cannot attach here. While `<head>` is still parsing
 * `document.body` is null and there is nothing for a ResizeObserver to
 * observe; what head-first actually buys is the REGISTRATION ORDER above, and
 * that is enough for the contract's real purpose — a document whose own script
 * throws still sizes, because a synchronous throw stops neither parsing nor
 * DOMContentLoaded.
 *
 * MEASUREMENT is `body.getBoundingClientRect().bottom` plus the body's own
 * bottom margin, and never `documentElement.scrollHeight`: scrollHeight
 * ratchets to the frame's own viewport and never shrinks below it, so the
 * obvious `Math.max(scrollHeight, …)` pins every 200px briefing at 800px
 * forever. The rectangle is content-driven, shrinks correctly, and needs no
 * CSS injected into the author's document — which is the point. A margin reset
 * to make our measurement easier would be exactly the styling imposition this
 * project exists to remove.
 *
 * COALESCING: every trigger schedules one animation frame, and the frame
 * callback posts only when the integer height actually moved. A MutationObserver
 * on a chatty document otherwise posts hundreds of times a second, and every
 * post is a setState in the parent.
 *
 * The 5s poll is the belt for what the observers miss (an image that finishes
 * decoding without mutating the DOM); the observers are the braces for
 * everything after 5s.
 */
export function buildHeightBootstrap(slug: string): string {
  // `<` is escaped so the slug can never close this script element early, and
  // JSON.stringify handles quoting. The server validates slugs to
  // [a-z0-9_-], but this function is also handed the local sample slug and
  // should not depend on a rule enforced in another process.
  const literal = JSON.stringify(slug).replace(/</g, '\\u003c')
  return `(function(){
var SLUG=${literal},SRC=${JSON.stringify(BRIEF_MESSAGE_SOURCE)},V=${BRIEF_MESSAGE_VERSION};
var last=-1,pending=0,started=false;
function post(type,extra){
  var msg={source:SRC,v:V,type:type,slug:SLUG};
  if(extra){for(var k in extra){msg[k]=extra[k];}}
  try{parent.postMessage(msg,'*');}catch(e){}
}
function measure(){
  var b=document.body;
  if(!b)return 0;
  var bottom=b.getBoundingClientRect().bottom,mb=0;
  try{mb=parseFloat(getComputedStyle(b).marginBottom)||0;}catch(e){}
  return Math.ceil(bottom+mb);
}
function report(){
  pending=0;
  var h=measure();
  if(h>0&&h!==last){last=h;post('height',{height:h});}
}
function schedule(){
  if(pending)return;
  pending=window.requestAnimationFrame?requestAnimationFrame(report):setTimeout(report,16);
}
window.addEventListener('error',function(e){
  post('error',{message:e&&e.message?String(e.message):'script error'});
});
window.addEventListener('message',function(e){
  var d=e.data;
  if(d&&d.source===SRC&&d.type==='remeasure'){last=-1;schedule();}
});
function attach(){
  if(started||!document.body)return;
  started=true;
  post('ready');
  schedule();
  try{new ResizeObserver(schedule).observe(document.body);}catch(e){}
  try{new MutationObserver(schedule).observe(document.documentElement,
    {subtree:true,childList:true,attributes:true,characterData:true});}catch(e){}
  window.addEventListener('load',schedule);
  try{if(document.fonts&&document.fonts.ready){document.fonts.ready.then(schedule);}}catch(e){}
  var poll=setInterval(schedule,250);
  setTimeout(function(){clearInterval(poll);},5000);
}
if(document.readyState==='loading'){
  document.addEventListener('readystatechange',attach);
  document.addEventListener('DOMContentLoaded',attach);
}else{attach();}
})();`
}

/**
 * Return `html` with exactly ONE `<script>` inserted. Insertion point, in
 * order:
 *   1. immediately after the first `<head>` / `<head …>`
 *   2. else immediately after the first `<html>` / `<html …>`
 *   3. else immediately after the doctype
 *   4. else at index 0
 *
 * The `(?:\s[^>]*)?` is load-bearing rather than stylistic. The obvious
 * `<head[^>]*>` also matches the literal string `<header>` — `<head`, then
 * `[^>]*` eats `er`, then `>` — so a document with no `<head>` but a
 * `<header>`, an ordinary shape for a hand-written briefing, would take
 * branch 1 and bury the bootstrap inside the header element, silently.
 *
 * NEVER inserts ahead of `<!doctype html>`: that is quirks mode, which is a
 * styling imposition by another name.
 *
 * It is a string edit, not a parse, and that is a deliberate limit rather than
 * an oversight. A `<head>` that only LOOKS like one — inside a comment, inside
 * a script's string literal — takes the bootstrap with it, no height is ever
 * reported, and the frame lands in its labelled fallback. Contained and
 * visible. An HTML parser to beat that case costs more than the case is worth.
 *
 * Head-first also removes the failure end-of-body insertion had: nothing of
 * the author's precedes the insertion point, so an unterminated `<script>` in
 * the author's document can no longer swallow the bootstrap. It can still
 * swallow everything after it — but that is the author's own document
 * breaking, and it shows up as the fallback rather than as a wrong size.
 */
export function injectHeightBootstrap(html: string, slug: string): string {
  const tag = `<script>${buildHeightBootstrap(slug)}</script>`
  for (const pattern of [HEAD_OPEN, HTML_OPEN, DOCTYPE]) {
    const match = pattern.exec(html)
    if (match) {
      const at = match.index + match[0].length
      return html.slice(0, at) + tag + html.slice(at)
    }
  }
  return tag + html
}

/**
 * Validate one `MessageEvent.data`. Returns null unless ALL hold: it is a
 * plain object; `source` is our literal; `v` is 1; `slug` is this frame's
 * slug; `type` is one of the four literals; and for 'height',
 * `Number.isFinite(height)` and the integer height is within bounds.
 *
 * `event.origin` is NOT consulted, here or anywhere. For an opaque frame it is
 * the literal string "null" for EVERY such frame, so an origin check here is
 * not a weak check — it is one that looks like a check and validates nothing.
 * The real authentication is `event.source === iframe.contentWindow`, made by
 * the caller, because contentWindow identity is the one thing a message cannot
 * forge.
 */
export function parseBriefMessage(data: unknown, slug: string): BriefMessage | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  if (d.source !== BRIEF_MESSAGE_SOURCE) return null
  if (d.v !== BRIEF_MESSAGE_VERSION) return null
  if (d.slug !== slug) return null
  const type = d.type
  if (type !== 'height' && type !== 'ready' && type !== 'error' && type !== 'remeasure') {
    return null
  }
  const msg: BriefMessage = {
    source: BRIEF_MESSAGE_SOURCE,
    v: BRIEF_MESSAGE_VERSION,
    type,
    slug,
  }
  if (type === 'height') {
    const height = d.height
    if (typeof height !== 'number' || !Number.isFinite(height)) return null
    const rounded = Math.ceil(height)
    if (rounded < MIN_FRAME_PX || rounded > MAX_FRAME_PX) return null
    msg.height = rounded
  }
  if (typeof d.message === 'string') msg.message = d.message
  return msg
}
