/* SPDX-License-Identifier: BUSL-1.1
 * clawmeets/server/channels/webchat_widget.js
 * The ClawMeets web chat widget, served at /api/channels/widget.js. Plain
 * JavaScript, no dependencies, no build step: it works on any website.
 *
 *   <script src="https://<server>/api/channels/widget.js" data-key="cmw_..." async></script>
 *
 * Attributes:
 *   data-key / data-keys  one agent's key, or several comma-separated. Every
 *                         script tag on a page shares ONE dock, so pasting two
 *                         agents' snippets gives two chat heads.
 *   data-mode             "dock" (default): round chat heads at the bottom right;
 *                         each opens a chat window, several side by side, each
 *                         minimisable back to its head.
 *                         "fullpage": one chat filling the page (the hosted chat).
 *   data-open             open the first key's window at once.
 *   data-color            accent color (any CSS color).
 *
 * Pages that drive it themselves use window.ClawMeetsChat:
 *   add(key)       list an agent in the compose picker (no window)
 *   open(key)      open (or bring forward) its window
 *   minimize(key)  back to a chat head
 *   close(key)     window and head gone; still in the picker
 *   list()         [{key, state, name}]
 * Calls made before the script loads may be queued:
 *   window.ClawMeetsChat = window.ClawMeetsChat || []; ClawMeetsChat.push(['open', key])
 *
 * Everything renders inside a closed shadow root, so the host page's CSS cannot
 * reach it and its CSS cannot reach the page. Every call is a CORS "simple"
 * request (text/plain body, no custom headers, no cookies). Each key's visitor
 * id, token and transcript live in localStorage, so a reload continues the
 * conversation. Agent text is rendered as markdown by building DOM nodes; it is
 * never inserted as HTML, and only http(s)/mailto links become anchors.
 */
(function () {
  'use strict'

  var script = document.currentScript
  var existing = window.ClawMeetsChat
  if (existing && existing.__manager) {
    existing.__manager.fromScript(script)
    return
  }
  var queued = Array.isArray(existing) ? existing.slice() : []

  // -- small helpers -----------------------------------------------------

  var MAX_KEPT = 200
  var PENDING_MS = 3 * 60 * 1000
  var SEND_ERROR = 'Sorry \u2014 I couldn\u2019t reply just now. Please try again.'
  var GENERIC_STARTERS = [
    'Who are you and what can you do?',
    'What kinds of requests can you help with?',
    'How do I get started?',
  ]
  var AV = ['#e63b8a', '#0fb3a2', '#2fbf5a', '#d48a1c', '#4b58c2', '#6f6f7a']
  var SVG_NS = 'http://www.w3.org/2000/svg'
  var PATHS = {
    reset: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    arrow: 'M5 12h14M13 6l6 6-6 6',
    up: 'M12 19V5M5 12l7-7 7 7',
    min: 'M5 12h14',
    close: 'M6 6l12 12M18 6L6 18',
    compose: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
    back: 'M15 18l-6-6 6-6',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  }

  // Same hash as the app's SidebarAvatar, so an agent keeps its color everywhere.
  function colorFor(seed) {
    var hash = 0
    for (var i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash)
    return AV[Math.abs(hash) % AV.length]
  }

  function h(tag, attrs, children) {
    var el = document.createElement(tag)
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k]
        if (v === null || v === undefined || v === false) return
        if (k === 'class') el.className = v
        else if (k === 'text') el.textContent = v
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v)
        else el.setAttribute(k, v === true ? '' : v)
      })
    }
    ;(children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    })
    return el
  }

  function icon(name, size, stroke) {
    var svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('width', size || 16)
    svg.setAttribute('height', size || 16)
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', stroke || 2)
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.setAttribute('aria-hidden', 'true')
    var path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', PATHS[name])
    svg.appendChild(path)
    return svg
  }

  function avatar(name, seed, cls) {
    return h('div', { class: 'av' + (cls ? ' ' + cls : ''), style: 'background:' + colorFor(seed || name), 'aria-hidden': 'true' },
      [((name || '?').trim()[0] || '?').toUpperCase()])
  }

  function loadJSON(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') } catch (e) { return null }
  }
  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch (e) { /* full or blocked */ }
  }

  function newId() {
    var bytes = new Uint8Array(12)
    ;(window.crypto || window.msCrypto).getRandomValues(bytes)
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2) }).join('')
  }

  // -- markdown, as DOM nodes ----------------------------------------------
  // A CommonMark/GFM subset. Agent text only ever lands in text nodes or in
  // attributes whose values are checked (href) or fixed (style alignments).

  var PUNCT = /[!-\/:-@\[-`{-~]/
  var SPACE = /\s/

  function safeUrl(url) {
    return /^(https?:\/\/|mailto:)/i.test(url)
  }

  function link(href) {
    return h('a', { href: href, target: '_blank', rel: 'noopener noreferrer nofollow' })
  }

  function unescape(s) {
    return s.replace(/\\([!-\/:-@\[-`{-~])/g, '$1')
  }

  function lead(line) {
    return line.match(/^ */)[0].length
  }

  // Where a backtick run exactly `len` long starts, at or after `from`; -1 if none.
  function closingTicks(text, len, from) {
    for (var j = text.indexOf('`', from); j >= 0; j = text.indexOf('`', j)) {
      var k = j
      while (text[k] === '`') k++
      if (k - j === len) return j
      j = k
    }
    return -1
  }

  // [label](url "title") with text[i] === '['. Brackets nest in the label and
  // parentheses must balance in the url, so wiki/Foo_(bar) stays whole.
  function parseLink(text, i) {
    var depth = 0
    var j = i
    for (; j < text.length; j++) {
      if (text[j] === '\\') j++
      else if (text[j] === '[') depth++
      else if (text[j] === ']' && !--depth) break
    }
    if (j >= text.length || text[j + 1] !== '(') return null
    var k = j + 2
    var url
    while (text[k] === ' ') k++
    if (text[k] === '<') {
      var gt = text.indexOf('>', k)
      if (gt < 0) return null
      url = text.slice(k + 1, gt)
      k = gt + 1
    } else {
      var start = k
      var parens = 0
      for (; k < text.length && !SPACE.test(text[k]); k++) {
        if (text[k] === '\\') k++
        else if (text[k] === '(') parens++
        else if (text[k] === ')') { if (!parens) break; parens-- }
      }
      if (parens) return null
      url = text.slice(start, k)
    }
    var tail = text.slice(k).match(/^\s*(?:"[^"]*"|'[^']*'|\([^)]*\))?\s*\)/)
    if (!tail) return null
    return { label: text.slice(i + 1, j), url: unescape(url).trim(), end: k + tail[0].length }
  }

  // A bare URL loses trailing punctuation, and a ')' it never opened (GFM).
  function trimUrl(url) {
    for (;;) {
      var last = url.slice(-1)
      if (/[.,;:!?*_~]/.test(last)) url = url.slice(0, -1)
      else if (last === ')' && url.split(')').length > url.split('(').length) url = url.slice(0, -1)
      else return url
    }
  }

  // CommonMark's emphasis pass (without its openers_bottom speed-up): each
  // closing run pairs with the nearest opener of the same character, and the
  // tokens between them move into <em>, <strong> or <del>.
  function pairDelims(toks) {
    var c = 0
    while (c < toks.length) {
      var cl = toks[c]
      var o = cl.ch && cl.close ? c - 1 : -1
      for (; o >= 0; o--) {
        var op = toks[o]
        if (op.ch !== cl.ch || !op.open) continue
        // the rule of three: in *a**b* the ** pairs with nothing
        if ((op.close || cl.open) && (op.run + cl.run) % 3 === 0 && (op.run % 3 || cl.run % 3)) continue
        break
      }
      if (o < 0) { c++; continue }
      op = toks[o]
      var use = cl.ch === '~' ? 2 : Math.min(op.len, cl.len, 2)
      var el = h(cl.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em')
      emit(el, toks.splice(o + 1, c - o - 1, { node: el }))
      op.len -= use
      cl.len -= use
      c = o + 2
      if (!op.len) toks.splice(o, 1), c--
      if (!cl.len) toks.splice(c, 1)
    }
  }

  function emit(parent, toks) {
    toks.forEach(function (t) {
      parent.appendChild(t.node || document.createTextNode(t.ch ? Array(t.len + 1).join(t.ch) : t.text))
    })
  }

  // Inline markdown: escapes, code spans, links, autolinks, then emphasis.
  // Inside a link label (inLink) nothing becomes a further link.
  function inline(parent, text, inLink) {
    var toks = []
    var buf = ''
    var push = function (tok) {
      if (buf) toks.push({ text: buf })
      buf = ''
      toks.push(tok)
    }
    var i = 0
    var m
    while (i < text.length) {
      var c = text[i]
      var prev = text[i - 1] || ' '
      if (c === '\\' && PUNCT.test(text[i + 1] || '')) {
        buf += text[i + 1]
        i += 2
      } else if (c === '\n') {
        push({ node: h('br') })
        i++
      } else if (c === '`') {
        var run = text.slice(i).match(/^`+/)[0].length
        var end = closingTicks(text, run, i + run)
        if (end < 0) {
          buf += text.substr(i, run)
          i += run
        } else {
          var code = text.slice(i + run, end).replace(/\n/g, ' ')
          if (/^ [\s\S]*\S[\s\S]* $/.test(code)) code = code.slice(1, -1)
          push({ node: h('code', { text: code }) })
          i = end + run
        }
      } else if (!inLink && (c === '[' || (c === '!' && text[i + 1] === '[')) &&
                 (m = parseLink(text, c === '!' ? i + 1 : i))) {
        var safe = safeUrl(m.url)
        var a = safe ? link(m.url) : document.createDocumentFragment()
        // an image is only ever a link labelled with its alt text, never an <img>
        if (c === '!') a.appendChild(document.createTextNode(unescape(m.label) || (safe ? m.url : '')))
        else inline(a, m.label, true)
        push({ node: a })
        i = m.end
      } else if (!inLink && c === '<' && (m = text.slice(i).match(/^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i))) {
        push({ node: link(m[1]) })
        toks[toks.length - 1].node.textContent = m[1]
        i += m[0].length
      } else if (!inLink && (c === 'h' || c === 'H') && !/[A-Za-z0-9]/.test(prev) &&
                 (m = text.slice(i).match(/^https?:\/\/[^\s<>"'\]]+/i))) {
        var url = trimUrl(m[0])
        push({ node: link(url) })
        toks[toks.length - 1].node.textContent = url
        i += url.length
      } else if (c === '*' || c === '_' || c === '~') {
        var len = 1
        while (text[i + len] === c) len++
        var next = text[i + len] || ' '
        var left = !SPACE.test(next) && (!PUNCT.test(next) || SPACE.test(prev) || PUNCT.test(prev))
        var right = !SPACE.test(prev) && (!PUNCT.test(prev) || SPACE.test(next) || PUNCT.test(next))
        if (c === '~' && len !== 2) buf += text.substr(i, len)
        else push({ ch: c, len: len, run: len,
          open: c === '_' ? left && (!right || PUNCT.test(prev)) : left,
          close: c === '_' ? right && (!left || PUNCT.test(next)) : right })
        i += len
      } else {
        buf += c
        i++
      }
    }
    if (buf) toks.push({ text: buf })
    pairDelims(toks)
    emit(parent, toks)
  }

  var FENCE_RE = /^( {0,3})(`{3,}(?=[^`]*$)|~{3,})(.*)$/
  var HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
  var HEAD_RE = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
  var QUOTE_RE = /^ {0,3}> ?/
  var LIST_RE = /^( *)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/
  var SEP_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

  // A table row's cells; an escaped \| is a literal pipe, not a separator.
  function cells(line) {
    var t = line.trim()
    if (t[0] === '|') t = t.slice(1)
    if (t.slice(-1) === '|' && t.slice(-2, -1) !== '\\') t = t.slice(0, -1)
    var out = []
    var cur = ''
    for (var k = 0; k < t.length; k++) {
      if (t[k] === '\\' && k + 1 < t.length) cur += t[k + 1] === '|' ? '|' : t[k] + t[k + 1], k++
      else if (t[k] === '|') out.push(cur.trim()), cur = ''
      else cur += t[k]
    }
    out.push(cur.trim())
    return out
  }

  // A GFM table: a header row, then a |---|:--:| row with as many cells.
  function isTable(lines, i) {
    return i + 1 < lines.length && lines[i].indexOf('|') >= 0 && lines[i + 1].indexOf('|') >= 0 &&
      SEP_RE.test(lines[i + 1]) && cells(lines[i]).length === cells(lines[i + 1]).length
  }

  function startsBlock(lines, i) {
    var l = lines[i]
    return FENCE_RE.test(l) || HR_RE.test(l) || HEAD_RE.test(l) || QUOTE_RE.test(l) || LIST_RE.test(l) || isTable(lines, i)
  }

  function table(parent, lines, i) {
    var head = cells(lines[i])
    var align = cells(lines[i + 1]).map(function (c) {
      return /^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : /^:/.test(c) ? 'left' : ''
    })
    var row = function (tag, values) {
      return h('tr', null, head.map(function (_, k) {
        var cell = h(tag, { style: align[k] ? 'text-align:' + align[k] : null })
        inline(cell, values[k] || '')
        return cell
      }))
    }
    var rows = []
    for (i += 2; i < lines.length && lines[i].indexOf('|') >= 0 && !startsBlock(lines, i); i++) rows.push(row('td', cells(lines[i])))
    parent.appendChild(h('div', { class: 'tbl' }, [
      h('table', null, [h('thead', null, [row('th', head)]), h('tbody', null, rows)]),
    ]))
    return i
  }

  // One list from lines[i]. A line indented past an item's marker belongs to
  // the item (continuation paragraphs, nested lists, code), so a list survives
  // them and keeps its numbering; each item's lines are parsed as blocks.
  function list(parent, lines, i) {
    var first = lines[i].match(LIST_RE)
    var ordered = /\d/.test(first[2])
    var el = parent.appendChild(h(ordered ? 'ol' : 'ul'))
    if (ordered && parseInt(first[2], 10) !== 1) el.setAttribute('start', parseInt(first[2], 10))
    var m
    while (i < lines.length && (m = lines[i].match(LIST_RE)) && /\d/.test(m[2]) === ordered && !HR_RE.test(lines[i])) {
      var indent = m[1].length
      var width = indent + m[2].length + (m[3].length > 4 ? 1 : m[3].length)
      var body = [m[4]]
      for (i++; i < lines.length; i++) {
        var l = lines[i]
        if (!l.trim()) body.push('')
        else if (lead(l) > indent) body.push(l.slice(Math.min(lead(l), width)))
        else if (body[body.length - 1] && !startsBlock(lines, i)) body.push(l.trim())  // lazy continuation
        else break
      }
      while (body.length > 1 && !body[body.length - 1]) body.pop()
      // a blank line inside the item makes it loose: its paragraphs get <p>s
      blocks(el.appendChild(h('li')), body, body.indexOf('') < 0)
    }
    return i
  }

  // Block markdown into `parent`. `tight` (list items) writes paragraph text
  // straight into the parent instead of wrapping it in <p>.
  function blocks(parent, lines, tight) {
    var para = []
    var flush = function () {
      if (!para.length) return
      inline(tight ? parent : parent.appendChild(h('p')), para.join('\n'))
      para = []
    }
    var i = 0
    var m
    while (i < lines.length) {
      var line = lines[i]
      if ((m = line.match(FENCE_RE))) {
        // closed only by the same character, at least as long, then nothing but spaces
        flush()
        var fence = m[2]
        var dedent = new RegExp('^ {0,' + m[1].length + '}')
        var body = []
        for (i++; i < lines.length; i++) {
          var close = lines[i].match(/^ {0,3}(`+|~+)[ \t]*$/)
          if (close && close[1][0] === fence[0] && close[1].length >= fence.length) break
          body.push(lines[i].replace(dedent, ''))
        }
        i++
        parent.appendChild(h('pre', null, [h('code', { text: body.join('\n') })]))
      } else if (HR_RE.test(line)) {
        flush()
        parent.appendChild(h('hr'))
        i++
      } else if (LIST_RE.test(line)) {
        flush()
        i = list(parent, lines, i)
      } else if ((m = line.match(HEAD_RE))) {
        flush()
        inline(parent.appendChild(h('p')).appendChild(h('strong')), m[1] || '')
        i++
      } else if (QUOTE_RE.test(line)) {
        flush()
        var quoted = []
        while (i < lines.length && QUOTE_RE.test(lines[i])) quoted.push(lines[i++].replace(QUOTE_RE, ''))
        blocks(parent.appendChild(h('blockquote')), quoted)
      } else if (isTable(lines, i)) {
        flush()
        i = table(parent, lines, i)
      } else {
        if (line.trim()) para.push(line.trim())
        else flush()
        i++
      }
    }
    flush()
  }

  function markdown(text) {
    var frag = document.createDocumentFragment()
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').map(function (l) {
      return l.replace(/^[ \t]+/, function (ws) { return ws.replace(/\t/g, '    ') })
    })
    blocks(frag, lines)
    return frag
  }

  // -- styles -------------------------------------------------------------

  var CSS = [
    ':host{all:initial}',
    '.root{--accent:#6b2aa0;--accent-deep:#52217b;--accent-soft:#e4d6ef;--accent-softer:#f1e6fa;',
    '--ink-1:#1f1826;--ink-2:#433859;--ink-3:#7a6e8c;--ink-4:#a79bb7;--line-1:#ece5f1;--line-2:#dfd4e6;',
    '--line-strong:#c9bcd3;--pill:#f1edf5;--proposal:#f6f0fc;--go-fg:#0d6d57;--go-bg:#d9efe5;--online:#2fbf5a;',
    'font-family:"Nunito",system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;',
    'line-height:1.45;font-weight:500;color:var(--ink-1);-webkit-font-smoothing:antialiased}',
    '.root.custom{--accent-deep:var(--accent);--accent-soft:color-mix(in srgb,var(--accent) 20%,#fff);',
    '--accent-softer:color-mix(in srgb,var(--accent) 9%,#fff);--proposal:color-mix(in srgb,var(--accent) 6%,#fff)}',
    '*{box-sizing:border-box}button{font-family:inherit}',
    'a{color:var(--accent-deep)}a:hover{color:var(--accent)}',
    ':focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
    '.av{width:36px;height:36px;border-radius:11px;color:#fff;font-weight:800;font-size:15px;display:flex;',
    'align-items:center;justify-content:center;flex:none}',
    '.av.xl{width:72px;height:72px;border-radius:20px;font-size:28px}.av.sm{width:28px;height:28px;border-radius:8px;font-size:12px}',
    '.av.lg{width:56px;height:56px;border-radius:16px;font-size:23px}',
    '.mono{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--ink-3)}',
    '.badge{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:700;border-radius:999px;',
    'padding:2px 9px;background:var(--pill);color:var(--ink-2);white-space:nowrap}',
    '.badge.go{background:var(--go-bg);color:var(--go-fg)}.badge i{width:7px;height:7px;border-radius:50%;background:currentColor}',
    // one chat
    '.chat{display:flex;flex-direction:column;background:#fff;min-height:0;overflow:hidden}',
    '.head{display:flex;gap:12px;align-items:center;padding:12px 18px;border-bottom:1px solid var(--line-1)}',
    '.who{flex:1;min-width:0}.who .n{font-size:15.5px;font-weight:800;display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    '.who .s{font-size:12.5px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.who .s a{color:var(--ink-2);font-weight:700;text-decoration:none}.who .s a:hover{color:var(--accent-deep)}',
    '.ib{border:0;background:transparent;color:var(--ink-3);width:34px;height:34px;border-radius:9px;display:flex;',
    'align-items:center;justify-content:center;cursor:pointer;flex:none}.ib:hover{background:var(--pill);color:var(--ink-1)}',
    '.scroll{flex:1;overflow:auto;padding:26px 22px 10px;min-height:0}',
    '.intro{display:flex;flex-direction:column;align-items:center;text-align:center;padding:30px 10px 10px;gap:10px}',
    '.intro h1{font-size:22px;font-weight:800;margin:6px 0 0;letter-spacing:-.01em;color:var(--ink-1)}',
    '.intro p{margin:0;font-size:14.5px;color:var(--ink-2);line-height:1.55;max-width:500px}',
    '.note{font-size:13px;color:var(--ink-2);background:var(--proposal);border:1px solid var(--line-1);border-radius:10px;',
    'padding:10px 14px;max-width:500px;text-align:left;line-height:1.5}.note b{color:var(--ink-1)}',
    '.starters{display:flex;flex-direction:column;gap:8px;width:100%;max-width:440px;margin-top:10px}',
    '.starters button{border:1px solid var(--line-2);background:#fff;border-radius:12px;padding:10px 14px;font-size:14px;',
    'font-weight:600;color:var(--ink-1);text-align:left;cursor:pointer;display:flex;justify-content:space-between;',
    'align-items:center;gap:10px}.starters button:hover{border-color:var(--accent-soft);background:var(--accent-softer)}',
    '.starters button svg{color:var(--ink-4);flex:none}.starters button:disabled{cursor:default;opacity:.6}',
    '.msgs{display:flex;flex-direction:column;gap:22px}',
    '.me{align-self:flex-end;max-width:78%;background:var(--accent);color:#fff;font-size:14.5px;line-height:1.5;',
    'padding:9px 14px;border-radius:18px 18px 5px 18px;white-space:pre-wrap;overflow-wrap:anywhere}',
    '.bot{display:flex;gap:12px;align-items:flex-start;max-width:100%}',
    '.md{flex:1;min-width:0;font-size:14.5px;line-height:1.6;color:var(--ink-1);padding-top:4px;overflow-wrap:anywhere}',
    '.md p{margin:0 0 10px}.md>:last-child,.md>.acts{margin-bottom:0}',
    '.md ul,.md ol{margin:0 0 10px;padding-left:20px;display:flex;flex-direction:column;gap:3px}',
    '.md strong{font-weight:800}.md code{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12.5px;',
    'background:var(--pill);border-radius:4px;padding:1px 5px}',
    '.md pre{background:var(--pill);border-radius:8px;padding:10px 12px;overflow:auto;margin:0 0 10px}.md pre code{padding:0;background:none}',
    '.md blockquote{margin:0 0 10px;padding-left:12px;border-left:3px solid var(--line-2);color:var(--ink-2)}',
    '.md li>ul,.md li>ol{margin:3px 0 0}.md li>p{margin:0 0 6px}.md li>:last-child,.md blockquote>:last-child{margin-bottom:0}',
    '.md hr{border:0;border-top:1px solid var(--line-2);margin:14px 0}.md del{color:var(--ink-3)}',
    '.md .tbl{overflow-x:auto;margin:0 0 10px}.md table{border-collapse:collapse;font-size:13.5px;line-height:1.45}',
    '.md th,.md td{border:1px solid var(--line-2);padding:5px 10px;text-align:left;vertical-align:top;overflow-wrap:normal}',
    '.md th{background:var(--pill);font-weight:800}',
    '.md.err{color:var(--ink-2)}',
    '.acts{display:flex;gap:2px;margin-top:6px;opacity:0;transition:opacity .15s}.bot:hover .acts,.acts:focus-within{opacity:1}',
    '.acts button{border:0;background:transparent;color:var(--ink-3);font-size:12px;font-weight:700;padding:4px 8px;',
    'border-radius:6px;cursor:pointer;display:inline-flex;gap:5px;align-items:center}.acts button:hover{background:var(--pill);color:var(--ink-1)}',
    '.typing{display:flex;gap:4px;padding:12px 0}.typing i{width:7px;height:7px;border-radius:50%;background:var(--ink-4);',
    'animation:cmb 1.1s infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}',
    '@keyframes cmb{30%{transform:translateY(-4px);background:var(--accent)}}',
    '.off{padding:40px 20px;text-align:center;color:var(--ink-2);font-size:14px}',
    '.comp{padding:8px 18px 0}',
    '.box{display:flex;align-items:flex-end;gap:8px;border:1.5px solid var(--line-2);border-radius:16px;padding:6px 6px 6px 14px;',
    'background:#fff;transition:border-color .15s}.box:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-softer)}',
    '.box textarea{flex:1;border:0;outline:0;resize:none;font:inherit;font-size:15px;line-height:1.45;padding:7px 0;',
    'max-height:160px;background:transparent;color:var(--ink-1);min-width:0}.box textarea::placeholder{color:var(--ink-4)}',
    '.send{width:38px;height:38px;border-radius:11px;border:0;background:var(--accent);color:#fff;display:flex;',
    'align-items:center;justify-content:center;cursor:pointer;flex:none}.send:disabled{background:var(--line-2);cursor:default}',
    '.send:not(:disabled):hover{background:var(--accent-deep)}',
    '.hint{font-size:11.5px;color:var(--ink-3);padding:6px 4px 0;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}',
    '.hint kbd{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:11px;background:#fff;border:1px solid var(--line-2);',
    'border-bottom-width:2px;border-radius:4px;padding:1px 5px;color:var(--ink-2);line-height:1}',
    '.foot{text-align:center;font-size:11.5px;color:var(--ink-3);padding:6px 0 12px}.foot a{color:var(--ink-2);font-weight:700;text-decoration:none}',
    // full page
    '.full{position:fixed;inset:0;display:flex;justify-content:center;background:#fff}',
    '.full .chat{width:100%;max-width:780px;height:100%;border-left:1px solid var(--line-1);border-right:1px solid var(--line-1)}',
    // dock
    '.dock .chat{position:relative;width:340px;height:min(520px,calc(100vh - 32px));border-radius:14px 14px 0 0;',
    'box-shadow:0 12px 40px rgba(31,24,38,.18);border:1px solid var(--line-2);border-bottom:0;pointer-events:auto}',
    '.dock .head{padding:9px 8px 9px 12px;gap:10px}.dock .who .n{font-size:14.5px;gap:6px}.dock .who .s{font-size:12px}',
    '.dock .ib{width:30px;height:30px}.dock .scroll{padding:16px 14px 8px}.dock .intro{padding:14px 4px 4px;gap:8px}',
    '.dock .intro h1{font-size:18px}.dock .intro p{font-size:13.5px}.dock .note{font-size:12.5px;padding:8px 12px}',
    '.dock .starters button{font-size:13px;padding:8px 12px}.dock .msgs{gap:16px}.dock .me,.dock .md{font-size:14px}',
    '.dock .me{max-width:85%}.dock .comp{padding:6px 10px 0}.dock .box textarea{font-size:14px;padding:6px 0}',
    '.dock .send{width:34px;height:34px;border-radius:10px}.dock .hint{display:none}.dock .foot{padding:5px 0 7px;font-size:11px}',
    '.dock .badge.slow{display:none}',
    '.wins{position:fixed;right:84px;bottom:0;display:flex;flex-direction:row-reverse;align-items:flex-end;gap:12px;',
    'z-index:2147483000;pointer-events:none}',
    '.heads{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;align-items:center;gap:10px;z-index:2147483001}',
    '.hd{position:relative;width:52px;height:52px;border-radius:50%;border:0;padding:0;cursor:pointer;background:none;',
    'box-shadow:0 4px 14px rgba(31,24,38,.22);transition:transform .12s}.hd:hover{transform:scale(1.05)}',
    '.hd .av{width:52px;height:52px;border-radius:50%;font-size:21px}',
    '.hw{position:relative;width:52px;height:52px}.hw.active .hd{outline:3px solid var(--accent-soft);outline-offset:2px}',
    '.hw .dot{position:absolute;right:1px;bottom:1px;width:13px;height:13px;border-radius:50%;background:var(--online);border:2.5px solid #fff}',
    '.hw .un{position:absolute;top:-3px;right:-3px;min-width:19px;height:19px;border-radius:10px;background:#dc2626;color:#fff;',
    'font-size:11px;font-weight:800;line-height:19px;text-align:center;padding:0 5px;border:2px solid #fff}',
    '.hw .x{position:absolute;top:-4px;left:-4px;width:20px;height:20px;border-radius:50%;background:#fff;color:var(--ink-2);',
    'display:none;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.25);border:0;padding:0;cursor:pointer}',
    '.hw:hover .x,.hw:focus-within .x{display:flex}',
    '.hd.more{background:#4b4453;color:#fff;font-weight:800;font-size:15px}',
    '.hd.compose{background:#fff;color:var(--ink-1)}.hd.compose svg{display:block;margin:auto}',
    '.hd.active{outline:3px solid var(--accent-soft);outline-offset:2px}',
    '.picker{position:fixed;right:80px;bottom:16px;width:300px;max-height:min(440px,calc(100vh - 32px));background:#fff;',
    'border:1px solid var(--line-2);border-radius:14px;box-shadow:0 12px 40px rgba(31,24,38,.18);display:flex;',
    'flex-direction:column;overflow:hidden;z-index:2147483002}',
    '.picker .ph{padding:12px 14px 8px;font-size:14px;font-weight:800}',
    '.picker .ps{margin:0 10px 6px;display:flex;align-items:center;gap:6px;border:1px solid var(--line-2);border-radius:9px;',
    'padding:0 10px;color:var(--ink-3)}.picker .ps input{flex:1;border:0;outline:0;font:inherit;font-size:13px;padding:7px 0;min-width:0}',
    '.picker .pl{overflow:auto;padding:0 6px 8px}',
    '.picker .row{display:flex;gap:10px;align-items:center;width:100%;border:0;background:none;padding:8px;border-radius:10px;',
    'cursor:pointer;text-align:left;color:inherit}.picker .row:hover{background:var(--accent-softer)}',
    '.picker .row .t{flex:1;min-width:0}.picker .row b{display:flex;align-items:center;gap:6px;font-size:13.5px;font-weight:800}',
    '.picker .row b i{width:7px;height:7px;border-radius:50%;background:var(--online)}',
    '.picker .row span{display:block;font-size:12px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.picker .empty{padding:12px 14px;color:var(--ink-3);font-size:13px}',
    '@media (max-width:600px){',
    '.scroll{padding:18px 14px 8px}.me{max-width:88%}.acts{opacity:1}.head{padding:12px 14px}.comp{padding:8px 14px 0}',
    '.wins{inset:0;right:0;display:block}.dock .chat{position:fixed;inset:0;width:auto;height:auto;border-radius:0;border:0}',
    '.dock.has-open .heads,.dock.has-open .picker{display:none}.picker{right:16px;bottom:84px;width:calc(100vw - 32px)}}',
    '@media (hover:none){.acts{opacity:1}}',
  ].join('')

  // -- one chat (one key) --------------------------------------------------

  function Chat(manager, key, base) {
    this.m = manager
    this.key = key
    this.base = base
    this.storeKey = 'clawmeets-webchat:' + key
    var saved = loadJSON(this.storeKey)
    this.state = saved && typeof saved === 'object' ? saved : {}
    this.state.transcript = Array.isArray(this.state.transcript) ? this.state.transcript : []
    this.state.after = this.state.after || 0
    this.profile = this.state.profile || null
    this.maxChars = 4000
    this.busy = false
    this.unavailable = false
    this.view = null
    this.source = null
    this.pollTimer = null
    this.pollEvery = 0
    this.noStream = false
    this.ready = null
    this.profileLoad = null
    this.pendingTimer = null
  }

  Chat.prototype.save = function () {
    this.state.transcript = this.state.transcript.slice(-MAX_KEPT)
    this.state.profile = this.profile
    saveJSON(this.storeKey, this.state)
  }

  Chat.prototype.call = function (method, path, body) {
    var init = { method: method, credentials: 'omit', mode: 'cors' }
    if (body) {
      init.headers = { 'Content-Type': 'text/plain;charset=UTF-8' }
      init.body = JSON.stringify(body)
    }
    return fetch(this.base + path, init).then(function (r) {
      return r.json().catch(function () { return {} }).then(function (data) {
        if (!r.ok) {
          var err = new Error(data.error || 'http_' + r.status)
          err.status = r.status
          throw err
        }
        return data
      })
    })
  }

  Chat.prototype.qs = function () {
    return '?key=' + encodeURIComponent(this.key) + '&visitor=' + encodeURIComponent(this.state.visitor) +
      '&token=' + encodeURIComponent(this.state.token) + '&after=' + this.state.after
  }

  Chat.prototype.name = function () {
    return (this.profile && this.profile.display_name) || 'Chat'
  }

  Chat.prototype.isOpen = function () {
    return this.m.mode === 'fullpage' || this.m.state[this.key] === 'open'
  }

  Chat.prototype.setProfile = function (profile, maxChars) {
    if (profile) this.profile = profile
    if (maxChars) this.maxChars = maxChars
    this.save()
    if (this.view) this.renderHeader()
    if (this.view) this.renderBody()
    this.m.render()
  }

  Chat.prototype.loadProfile = function () {
    var self = this
    if (this.profileLoad) return this.profileLoad
    this.profileLoad = this.call('GET', '/api/channels/webchat/profile?key=' + encodeURIComponent(this.key))
      .then(function (data) {
        self.unavailable = false
        self.setProfile(data.profile, data.max_chars)
      })
      .catch(function (err) {
        self.profileLoad = null
        if (err.status === 403 || err.status === 404) {
          self.unavailable = true
          self.m.render()
          if (self.view) self.renderBody()
        }
      })
    return this.profileLoad
  }

  Chat.prototype.start = function () {
    var self = this
    if (this.ready) return this.ready
    this.ready = this.call('POST', '/api/channels/webchat/session', {
      key: this.key, visitor: this.state.visitor || '', token: this.state.token || '',
    }).then(function (data) {
      // A stored visitor the server replaced: that old thread is gone. (No
      // stored visitor: keep the message being sent.)
      if (self.state.visitor && data.visitor !== self.state.visitor) {
        self.state.after = 0
        self.state.transcript = []
      }
      self.state.visitor = data.visitor
      self.state.token = data.token
      self.unavailable = false
      self.setProfile(data.profile, data.max_chars)
      self.sync()
    }).catch(function (err) {
      self.ready = null
      if (err.status === 403 || err.status === 404) {
        self.unavailable = true
        if (self.view) self.renderBody()
        self.m.render()
      }
      throw err
    })
    return this.ready
  }

  // An open window (or a reply on its way) streams; a minimised chat with a
  // history polls slowly, so its head can show unread replies without holding
  // a connection per agent.
  Chat.prototype.sync = function () {
    if (!this.state.visitor || this.unavailable) return this.stop()
    var live = this.isOpen() || this.busy
    if (live && !this.noStream && window.EventSource) {
      this.stopPoll()
      if (!this.source) this.stream()
    } else {
      this.closeStream()
      this.poll(live ? 5000 : 20000)
    }
  }

  Chat.prototype.stop = function () {
    this.closeStream()
    this.stopPoll()
  }

  Chat.prototype.closeStream = function () {
    if (this.source) {
      this.source.close()
      this.source = null
    }
  }

  Chat.prototype.stopPoll = function () {
    clearInterval(this.pollTimer)
    this.pollTimer = null
    this.pollEvery = 0
  }

  Chat.prototype.stream = function () {
    var self = this
    var failures = 0
    var source = new EventSource(this.base + '/api/channels/webchat/stream' + this.qs())
    this.source = source
    source.onmessage = function (event) {
      failures = 0
      try { self.receive(JSON.parse(event.data)) } catch (e) { /* a bad frame */ }
    }
    source.onerror = function () {
      failures += 1
      // The browser retries by itself; after repeated failures (a proxy that
      // buffers event streams, say) fall back to polling.
      if (source.readyState === 2 || failures >= 3) {
        self.noStream = true
        self.closeStream()
        self.sync()
      }
    }
  }

  Chat.prototype.poll = function (every) {
    var self = this
    if (this.pollTimer && this.pollEvery === every) return
    this.stopPoll()
    var tick = function () {
      self.call('GET', '/api/channels/webchat/messages' + self.qs()).then(function (data) {
        (data.messages || []).forEach(function (m) { self.receive(m) })
      }).catch(function () { /* next tick */ })
    }
    tick()
    this.pollTimer = setInterval(tick, every)
    this.pollEvery = every
  }

  Chat.prototype.receive = function (message) {
    if (!message || message.seq <= this.state.after) return
    this.state.after = message.seq
    this.state.transcript.push({ from: 'agent', text: message.text, at: message.at })
    if (!this.isOpen()) this.state.unread = (this.state.unread || 0) + 1
    this.settle()
    this.save()
    if (this.view) this.renderBody()
    this.m.render()
  }

  Chat.prototype.settle = function () {
    clearTimeout(this.pendingTimer)
    if (!this.busy) return
    this.busy = false
    this.sync()
    if (this.view) this.renderComposer()
  }

  Chat.prototype.send = function (raw) {
    var self = this
    var text = (raw || '').trim()
    if (!text || this.busy) return
    if (text.length > this.maxChars) text = text.slice(0, this.maxChars)
    this.state.transcript.push({ from: 'me', text: text, at: Date.now() / 1000 })
    this.busy = true
    this.save()
    this.renderBody()
    this.renderComposer()
    var id = newId()
    this.start().then(function () {
      return self.call('POST', '/api/channels/webchat/messages', {
        key: self.key, visitor: self.state.visitor, token: self.state.token, id: id, text: text,
      })
    }).then(function () {
      self.sync()
      clearTimeout(self.pendingTimer)
      self.pendingTimer = setTimeout(function () { self.settle() }, PENDING_MS)
    }).catch(function () {
      self.state.transcript.push({ from: 'error', text: SEND_ERROR })
      self.save()
      self.settle()
      self.renderBody()
    })
  }

  Chat.prototype.reset = function () {
    this.stop()
    this.ready = null
    clearTimeout(this.pendingTimer)
    this.busy = false
    this.state = { transcript: [], after: 0 }
    this.save()
    if (this.view) {
      this.renderBody()
      this.renderComposer()
      this.view.ta.focus()
    }
    this.m.render()
  }

  // -- one chat's view -----------------------------------------------------

  Chat.prototype.buildView = function () {
    var self = this
    var docked = this.m.mode !== 'fullpage'
    var ta = h('textarea', { rows: 1 })
    var sendBtn = h('button', { type: 'button', class: 'send', 'aria-label': 'Send', disabled: true }, [icon('up', 18, 2.2)])
    var grow = function () {
      ta.style.height = 'auto'
      ta.style.height = ta.scrollHeight + 'px'
      self.renderComposer()
    }
    ta.addEventListener('input', grow)
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        self.submit()
      }
    })
    sendBtn.addEventListener('click', function () { self.submit() })
    var buttons = [
      h('button', { type: 'button', class: 'ib', title: 'New conversation', 'aria-label': 'New conversation',
        onclick: function () { self.reset() } }, [icon('reset', 17)]),
    ]
    if (docked) {
      buttons.push(
        h('button', { type: 'button', class: 'ib', title: 'Minimize', 'aria-label': 'Minimize chat',
          onclick: function () { self.m.minimize(self.key) } }, [icon('min', 17)]),
        h('button', { type: 'button', class: 'ib', title: 'Close', 'aria-label': 'Close chat',
          onclick: function () { self.m.close(self.key) } }, [icon('close', 17)])
      )
    }
    var header = h('header', { class: 'head' })
    var scroll = h('div', { class: 'scroll' })
    var root = h('section', { class: 'chat', role: docked ? 'dialog' : 'main', 'data-key': this.key }, [
      header, scroll,
      h('div', { class: 'comp' }, [
        h('div', { class: 'box' }, [ta, sendBtn]),
        h('div', { class: 'hint' }, [
          h('span', { text: 'AI agent \u2014 replies can be wrong. Don\u2019t share passwords or payment details.' }),
          h('span', null, [h('kbd', { text: 'Enter' }), ' to send']),
        ]),
      ]),
      h('div', { class: 'foot' }, ['Powered by ', h('a', { href: this.base + '/', target: '_blank', rel: 'noopener', text: 'ClawMeets' })]),
    ])
    this.view = { root: root, header: header, buttons: buttons, scroll: scroll, ta: ta, sendBtn: sendBtn }
    this.renderHeader()
    this.renderBody()
    return root
  }

  Chat.prototype.submit = function (text) {
    var value = text === undefined ? this.view.ta.value : text
    if (this.busy || !value.trim()) return
    if (text === undefined) {
      this.view.ta.value = ''
      this.view.ta.style.height = 'auto'
    }
    this.send(value)
  }

  Chat.prototype.renderHeader = function () {
    var v = this.view
    var p = this.profile || {}
    var name = this.name()
    var docked = this.m.mode !== 'fullpage'
    var badge = p.online
      ? h('span', { class: 'badge go' }, [h('i'), 'Online'])
      : (p.display_name ? h('span', { class: 'badge slow' }, [h('i'), 'Offline \u2014 replies may be slow']) : null)
    var sub = []
    if (p.account) {
      var acct = p.account.url
        ? h('a', { href: p.account.url, target: docked ? '_blank' : null, rel: docked ? 'noopener' : null, text: p.account.display_name })
        : document.createTextNode(p.account.display_name)
      sub.push('by ', acct, ' \u00b7 ', h('span', { class: 'mono', text: p.handle || '' }))
    }
    v.header.textContent = ''
    v.header.appendChild(avatar(name, p.handle || this.key, docked ? 'sm' : ''))
    v.header.appendChild(h('div', { class: 'who' }, [h('div', { class: 'n' }, [name, badge]), h('div', { class: 's' }, sub)]))
    v.buttons.forEach(function (b) { v.header.appendChild(b) })
    v.ta.placeholder = 'Message ' + name
    v.ta.setAttribute('aria-label', 'Message ' + name)
    if (!docked && p.display_name && p.account) document.title = name + ' \u00b7 ' + p.account.display_name
  }

  Chat.prototype.renderIntro = function () {
    var self = this
    var p = this.profile || {}
    var name = this.name()
    var docked = this.m.mode !== 'fullpage'
    var starters = (p.starter_questions && p.starter_questions.length) ? p.starter_questions : GENERIC_STARTERS
    if (docked) starters = starters.slice(0, 3)
    var note = null
    if (p.display_name && p.takes_direct_requests === false) {
      var t = p.request_taker
      note = h('div', { class: 'note' }, [h('b', { text: 'Answers questions only.' })].concat(t ? [
        ' To start a request, talk to the ',
        h('a', { href: t.chat_url, target: docked ? '_blank' : null, rel: docked ? 'noopener' : null, text: t.display_name }),
        '.',
      ] : []))
    }
    return h('div', { class: 'intro' }, [
      avatar(name, p.handle || this.key, docked ? 'lg' : 'xl'),
      h('h1', { text: name }),
      p.description ? h('p', { text: p.description }) : null,
      note,
      h('div', { class: 'starters' }, starters.map(function (s) {
        return h('button', { type: 'button', disabled: self.busy, onclick: function () { self.submit(s) } }, [s, icon('arrow')])
      })),
    ])
  }

  Chat.prototype.renderEntry = function (entry, name, seed) {
    if (entry.from === 'me') return h('div', { class: 'me', text: entry.text })
    var body = h('div', { class: 'md' + (entry.from === 'error' ? ' err' : '') })
    body.appendChild(markdown(entry.text))
    if (entry.from === 'agent') {
      var label = document.createTextNode('Copy')
      body.appendChild(h('div', { class: 'acts' }, [
        h('button', { type: 'button', onclick: function () {
          if (navigator.clipboard) navigator.clipboard.writeText(entry.text).then(function () { label.textContent = 'Copied' }, function () {})
        } }, [icon('copy', 13), label]),
      ]))
    }
    return h('div', { class: 'bot' }, [avatar(name, seed, 'sm'), body])
  }

  Chat.prototype.renderBody = function () {
    var self = this
    var v = this.view
    if (!v) return
    v.scroll.textContent = ''
    if (this.unavailable) {
      v.scroll.appendChild(h('div', { class: 'off', text: 'This chat is not available right now.' }))
      this.renderComposer()
      return
    }
    var name = this.name()
    var seed = (this.profile && this.profile.handle) || this.key
    if (!this.state.transcript.length) v.scroll.appendChild(this.renderIntro())
    var msgs = h('div', { class: 'msgs', 'aria-live': 'polite' })
    this.state.transcript.forEach(function (entry) { msgs.appendChild(self.renderEntry(entry, name, seed)) })
    if (this.busy) {
      msgs.appendChild(h('div', { class: 'bot' }, [
        avatar(name, seed, 'sm'),
        h('div', { class: 'typing', role: 'status', 'aria-label': name + ' is typing' }, [h('i'), h('i'), h('i')]),
      ]))
    }
    v.scroll.appendChild(msgs)
    v.scroll.scrollTop = v.scroll.scrollHeight
  }

  Chat.prototype.renderComposer = function () {
    var v = this.view
    if (!v) return
    v.sendBtn.disabled = this.busy || this.unavailable || !v.ta.value.trim()
    v.ta.disabled = this.unavailable
  }

  // -- the page's one manager ----------------------------------------------

  function Manager(base) {
    this.base = base
    this.mode = null
    this.chats = {}
    this.order = []          // keys, in the order they were added (the picker)
    this.state = {}          // key -> 'listed' | 'min' | 'open'
    this.openOrder = []      // open windows, oldest first
    this.headOrder = []      // heads, most recent first
    this.color = null
    this.pickerOpen = false
    this.query = ''
    this.dockKey = 'clawmeets-webchat-dock:' + location.pathname
    this.saved = loadJSON(this.dockKey) || {}
    this.rootEl = null
  }

  Manager.prototype.narrow = function () {
    return window.innerWidth <= 600
  }

  Manager.prototype.limit = function () {
    if (this.narrow()) return 1
    return Math.max(1, Math.min(3, Math.floor((window.innerWidth - 100) / 352)))
  }

  Manager.prototype.fromScript = function (el) {
    if (!el) return
    var base = el.src ? new URL(el.src, location.href).origin : this.base
    var keys = [el.getAttribute('data-key')].concat((el.getAttribute('data-keys') || '').split(','))
      .map(function (k) { return (k || '').trim() })
      .filter(Boolean)
    if (el.getAttribute('data-color')) this.color = el.getAttribute('data-color')
    if (el.getAttribute('data-mode') === 'fullpage') {
      if (keys[0]) this.mountFullpage(keys[0], base)
      return
    }
    if (!this.mode) this.mode = 'dock'
    var self = this
    keys.forEach(function (k) { self.add(k, { head: true, base: base }) })
    if (el.hasAttribute('data-open') && keys[0]) this.open(keys[0])
    this.render()
  }

  Manager.prototype.chat = function (key, base) {
    if (!this.chats[key]) {
      this.chats[key] = new Chat(this, key, base || this.base)
      this.order.push(key)
    }
    return this.chats[key]
  }

  Manager.prototype.mountFullpage = function (key, base) {
    this.mode = 'fullpage'
    var chat = this.chat(key, base)
    this.ensureRoot()
    this.rootEl.className = 'root full' + (this.color ? ' custom' : '')
    this.rootEl.textContent = ''
    this.rootEl.appendChild(chat.buildView())
    chat.loadProfile()
    chat.start().catch(function () {})
    setTimeout(function () { chat.view.ta.focus() }, 0)
  }

  Manager.prototype.add = function (key, opts) {
    if (!key || this.mode === 'fullpage') return
    if (!this.mode) this.mode = 'dock'
    opts = opts || {}
    var chat = this.chat(key, opts.base)
    if (!(key in this.state)) {
      var saved = this.saved[key]
      this.state[key] = 'listed'
      if (saved === 'open' && !this.narrow()) this.setOpen(key)
      else if (saved === 'open' || saved === 'min' || opts.head) this.setHead(key, 'min')
    } else if (opts.head && this.state[key] === 'listed') {
      this.setHead(key, 'min')
    }
    chat.loadProfile()
    if (chat.state.visitor) chat.start().catch(function () {})
    this.render()
  }

  Manager.prototype.setHead = function (key, state) {
    this.state[key] = state
    this.headOrder = [key].concat(this.headOrder.filter(function (k) { return k !== key }))
  }

  Manager.prototype.setOpen = function (key) {
    this.setHead(key, 'open')
    this.openOrder = this.openOrder.filter(function (k) { return k !== key }).concat([key])
    while (this.openOrder.length > this.limit()) {
      var oldest = this.openOrder.shift()
      this.state[oldest] = 'min'
      this.chats[oldest].sync()
    }
  }

  Manager.prototype.open = function (key) {
    if (!key) return
    if (this.mode === 'fullpage') return
    if (!(key in this.state)) this.add(key)
    var chat = this.chats[key]
    this.setOpen(key)
    chat.state.unread = 0
    chat.save()
    this.pickerOpen = false
    this.persist()
    this.render()
    if (chat.state.visitor) chat.sync()
    if (chat.view) setTimeout(function () { chat.view.ta.focus() }, 0)
  }

  Manager.prototype.minimize = function (key) {
    if (this.state[key] !== 'open') return
    this.state[key] = 'min'
    this.openOrder = this.openOrder.filter(function (k) { return k !== key })
    this.chats[key].sync()
    this.persist()
    this.render()
  }

  Manager.prototype.close = function (key) {
    if (!(key in this.state)) return
    this.state[key] = 'listed'
    this.openOrder = this.openOrder.filter(function (k) { return k !== key })
    this.headOrder = this.headOrder.filter(function (k) { return k !== key })
    this.chats[key].sync()
    this.persist()
    this.render()
  }

  Manager.prototype.persist = function () {
    var out = {}
    var self = this
    Object.keys(this.state).forEach(function (k) {
      if (self.state[k] !== 'listed') out[k] = self.state[k]
    })
    this.saved = out
    saveJSON(this.dockKey, out)
  }

  Manager.prototype.list = function () {
    var self = this
    return this.order.map(function (k) {
      return { key: k, state: self.state[k] || 'listed', name: self.chats[k].name() }
    })
  }

  Manager.prototype.ensureRoot = function () {
    if (this.rootEl) return
    var host = document.createElement('div')
    host.setAttribute('data-clawmeets-webchat', '')
    var testing = script && script.hasAttribute('data-test-open-shadow')
    var shadow = host.attachShadow({ mode: testing ? 'open' : 'closed' })
    shadow.appendChild(h('style', { text: CSS }))
    this.rootEl = h('div', { class: 'root' })
    if (this.color) this.rootEl.style.setProperty('--accent', this.color)
    shadow.appendChild(this.rootEl)
    var self = this
    var mount = function () { document.body.appendChild(host) }
    if (document.body) mount()
    else document.addEventListener('DOMContentLoaded', mount)
    window.addEventListener('resize', function () {
      if (self.mode !== 'dock') return
      while (self.openOrder.length > self.limit()) self.minimize(self.openOrder[0])
      self.render()
    })
    // A click anywhere outside the widget closes the picker (clicks inside the
    // shadow root reach the document retargeted to the host).
    document.addEventListener('click', function (e) {
      if (self.pickerOpen && e.target !== host) {
        self.pickerOpen = false
        self.render()
      }
    })
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && self.pickerOpen) {
        self.pickerOpen = false
        self.render()
      }
    })
    this.shadow = shadow
  }

  Manager.prototype.render = function () {
    if (this.mode !== 'dock') return
    this.ensureRoot()
    var self = this
    var root = this.rootEl
    if (this.color) root.style.setProperty('--accent', this.color)
    root.className = 'root dock' + (this.color ? ' custom' : '') + (this.openOrder.length ? ' has-open' : '')

    // windows: newest at the right, next to the heads
    var wins = this.winsEl || (this.winsEl = h('div', { class: 'wins' }))
    var wanted = this.openOrder.slice().reverse().map(function (k) {
      var chat = self.chats[k]
      if (!chat.view) chat.buildView()
      return chat.view.root
    })
    Array.prototype.slice.call(wins.children).forEach(function (el) {
      if (wanted.indexOf(el) < 0) wins.removeChild(el)
    })
    wanted.forEach(function (el, i) {
      if (wins.children[i] !== el) wins.insertBefore(el, wins.children[i] || null)
    })

    // heads: the compose button at the bottom, then the most recent upwards
    var heads = h('div', { class: 'heads', role: 'toolbar', 'aria-label': 'Chats' })
    var visible = this.headOrder.filter(function (k) { return !self.chats[k].unavailable })
    var maxHeads = this.narrow() ? 4 : 6
    var overflow = visible.length > maxHeads ? visible.slice(maxHeads - 1) : []
    var shown = overflow.length ? visible.slice(0, maxHeads - 1) : visible
    var available = this.order.filter(function (k) { return !self.chats[k].unavailable })
    var showCompose = available.length > 1 || available.length > visible.length
    var col = []
    if (overflow.length) {
      col.push(h('button', { type: 'button', class: 'hd more', title: overflow.length + ' more chats',
        'aria-label': overflow.length + ' more chats', onclick: function () { self.togglePicker() } }, ['+' + overflow.length]))
    }
    shown.slice().reverse().forEach(function (k) { col.push(self.headButton(k)) })
    if (showCompose) {
      col.push(h('button', { type: 'button', class: 'hd compose' + (this.pickerOpen ? ' active' : ''), title: 'New message',
        'aria-label': 'Start a chat', 'aria-expanded': this.pickerOpen ? 'true' : 'false',
        onclick: function () { self.togglePicker() } }, [icon('compose', 20)]))
    }
    col.forEach(function (el) { heads.appendChild(el) })

    root.textContent = ''
    root.appendChild(wins)
    if (col.length) root.appendChild(heads)
    if (this.pickerOpen) root.appendChild(this.pickerEl(available))
  }

  Manager.prototype.headButton = function (key) {
    var self = this
    var chat = this.chats[key]
    var p = chat.profile || {}
    var name = chat.name()
    var unread = chat.state.unread || 0
    var open = this.state[key] === 'open'
    var label = name + (unread ? ', ' + unread + ' unread' : '') + (open ? ' (open)' : '')
    return h('div', { class: 'hw' + (open ? ' active' : ''), title: name }, [
      h('button', { type: 'button', class: 'hd', 'aria-label': label,
        onclick: function () { if (open) self.minimize(key); else self.open(key) } }, [avatar(name, p.handle || key)]),
      p.online ? h('span', { class: 'dot', 'aria-hidden': 'true' }) : null,
      unread ? h('span', { class: 'un', 'aria-hidden': 'true', text: unread > 9 ? '9+' : String(unread) }) : null,
      h('button', { type: 'button', class: 'x', 'aria-label': 'Close chat with ' + name, title: 'Close',
        onclick: function (e) { e.stopPropagation(); self.close(key) } }, [icon('close', 11, 3)]),
    ])
  }

  Manager.prototype.togglePicker = function () {
    this.pickerOpen = !this.pickerOpen
    this.query = ''
    this.render()
    if (this.pickerOpen && this.searchEl) this.searchEl.focus()
  }

  Manager.prototype.pickerEl = function (keys) {
    var self = this
    var list = h('div', { class: 'pl', role: 'list' })
    var draw = function () {
      var q = self.query.trim().toLowerCase()
      list.textContent = ''
      var hits = keys.filter(function (k) {
        var p = self.chats[k].profile || {}
        return !q || [p.display_name, p.handle, p.description].join(' ').toLowerCase().indexOf(q) >= 0
      })
      if (!hits.length) list.appendChild(h('div', { class: 'empty', text: 'No agents match.' }))
      hits.forEach(function (k) {
        var chat = self.chats[k]
        var p = chat.profile || {}
        list.appendChild(h('button', { type: 'button', class: 'row', role: 'listitem', onclick: function () { self.open(k) } }, [
          avatar(chat.name(), p.handle || k),
          h('div', { class: 't' }, [
            h('b', null, [chat.name(), p.online ? h('i', { 'aria-label': 'online' }) : null]),
            h('span', { text: p.description || (p.account ? 'by ' + p.account.display_name : '') }),
          ]),
        ]))
      })
    }
    var children = [h('div', { class: 'ph', text: 'Chat with an agent' })]
    if (keys.length > 6) {
      this.searchEl = h('input', { placeholder: 'Search agents', 'aria-label': 'Search agents', value: this.query,
        oninput: function (e) { self.query = e.target.value; draw() } })
      children.push(h('label', { class: 'ps' }, [icon('search', 14), this.searchEl]))
    } else {
      this.searchEl = null
    }
    children.push(list)
    draw()
    return h('div', { class: 'picker', role: 'dialog', 'aria-label': 'Start a chat' }, children)
  }

  // -- boot ----------------------------------------------------------------

  var base = script && script.src ? new URL(script.src, location.href).origin : location.origin
  var manager = new Manager(base)
  var run = function (cmd) {
    if (!Array.isArray(cmd) || typeof api[cmd[0]] !== 'function' || cmd[0] === 'push') return
    api[cmd[0]].apply(null, cmd.slice(1))
  }
  var api = {
    add: function (key) { manager.add(key) },
    open: function (key) { manager.open(key) },
    minimize: function (key) { manager.minimize(key) },
    close: function (key) { manager.close(key) },
    list: function () { return manager.list() },
    push: function (cmd) { run(cmd) },
    __manager: manager,
    __markdown: markdown,
  }
  window.ClawMeetsChat = api
  manager.fromScript(script)
  queued.forEach(run)
})()
