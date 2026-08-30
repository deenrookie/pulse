// Burp-style raw request editor: one monospace buffer holding the request
// line, headers and body — parsed back into an EditableRequest on send.
import { useEffect, useMemo, useRef, useState } from 'react'
import { bodyToText, copyToClipboard, encodeBody, toCurlRequest } from '../api'
import ContextMenu, { type MenuItem } from './ContextMenu'
import Icon from '../ui/Icon'
import { renderCookieValue, renderJSONKeys } from './rawHighlight'
import type { EditableRequest, HttpRequest } from '../types'

/** serialize a captured request into a raw editable buffer */
export function requestToRaw(req: HttpRequest): string {
  const i = req.url.indexOf('://')
  const rest = i >= 0 ? req.url.slice(i + 3) : req.url
  const slash = rest.indexOf('/')
  const path = slash >= 0 ? rest.slice(slash) : '/'
  const headers = req.headers.map((h) => `${h.name}: ${h.value}`).join('\n')
  const body = bodyToText(req.body)
  return `${req.method} ${path} ${req.httpVersion || 'HTTP/1.1'}\n${headers}\n\n${body}`
}

/** parse the raw buffer back into a request — LENIENT by design: never
 *  rejects. Junk header lines are preserved, a missing Host falls back to
 *  fallbackUrl's host, and an unparseable first line degrades to GET/.
 *  The user asked for no send-time validation ("直接raw发给repeater"). */
export function rawToRequest(raw: string, fallbackUrl: string): EditableRequest {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  let empty = lines.findIndex((l, i) => i > 0 && l.trim() === '')
  if (empty < 0) empty = lines.length

  const head = lines[0] ?? ''
  const m = head.match(/^(\S+)\s+(\S+)(?:\s+(HTTP\/[\d.]+))?\s*$/)
  const method = (m ? m[1] : 'GET').toUpperCase()
  const target = m ? m[2] : '/'
  const version = m?.[3] || 'HTTP/1.1'

  const headers: { name: string; value: string }[] = []
  for (const line of lines.slice(1, empty)) {
    const idx = line.indexOf(':')
    if (idx > 0) headers.push({ name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() })
    else if (line.trim()) headers.push({ name: line.trim(), value: '' }) // keep junk verbatim
  }
  const body = lines.slice(empty + 1).join('\n')

  const fbScheme = fallbackUrl.slice(0, 7).toLowerCase() === 'http://' ? 'http' : 'https'
  const fbHost = (() => {
    const i = fallbackUrl.indexOf('://')
    const rest = i >= 0 ? fallbackUrl.slice(i + 3) : fallbackUrl
    const j = rest.search(/[/?#]/)
    return j >= 0 ? rest.slice(0, j) : rest
  })()

  let scheme = fbScheme
  let host = ''
  let path = target
  if (target.slice(0, 7).toLowerCase() === 'http://' || target.slice(0, 8).toLowerCase() === 'https://') {
    try {
      const u = new URL(target)
      scheme = u.protocol.replace(':', '')
      host = u.host
      path = u.pathname + u.search
    } catch {
      /* keep fallbacks */
    }
  }
  const hostHeader = headers.find((h) => h.name.toLowerCase() === 'host')
  if (hostHeader && hostHeader.value) host = hostHeader.value
  if (!host) host = fbHost || 'example.com'
  if (!path.startsWith('/')) path = '/' + path
  return {
    method,
    url: `${scheme}://${host}${path}`,
    httpVersion: version,
    headers,
    body: encodeBody(new TextEncoder().encode(body)),
  }
}


/** shared wrap state: persisted + synced across all raw views via event */
function useRawWrap(): [boolean, () => void] {
  const [wrap, setWrap] = useState(() => {
    try {
      return localStorage.getItem('pulse.rawwrap') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    const onSync = (e: Event) => setWrap((e as CustomEvent<string>).detail === '1')
    window.addEventListener('pulse:rawwrap', onSync)
    return () => window.removeEventListener('pulse:rawwrap', onSync)
  }, [])
  const toggle = () =>
    setWrap((w) => {
      const next = w ? '0' : '1'
      try {
        localStorage.setItem('pulse.rawwrap', next)
      } catch {
        /* ignore */
      }
      window.dispatchEvent(new CustomEvent('pulse:rawwrap', { detail: next }))
      return !w
    })
  return [wrap, toggle]
}

export default function RawEditor({
  value,
  onChange,
}: {
  value: string
  onChange: (next: string) => void
}) {
  const [wrap, toggleWrap] = useRawWrap()
  const mirrorRef = useRef<HTMLPreElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // active selection at context-menu time (drives the Cut/Copy/Paste group)
  const [sel, setSel] = useState<{ start: number; end: number; text: string } | null>(null)
  // Chrome collapses the textarea selection on right-button mousedown before
  // contextmenu fires — snapshot it in mousedown so the menu can still act on
  // it (Burp-style: selection survives a right-click anywhere in the editor)
  const lastSelRef = useRef<{ start: number; end: number; text: string } | null>(null)

  const readSel = () => {
    const ta = textareaRef.current
    if (!ta || ta.selectionStart === ta.selectionEnd) return null
    return { start: ta.selectionStart, end: ta.selectionEnd, text: ta.value.slice(ta.selectionStart, ta.selectionEnd) }
  }

  // ---- find in raw (mirror highlights + native selection over the match) ----
  // find-on-enter: q is the input, needle is APPLIED — typing alone never
  // highlights; Enter (or the step buttons) commits, further Enters walk.
  const [q, setQ] = useState('')
  const [hit, setHit] = useState(0)
  const [needle, setNeedle] = useState('')
  const offsets = useMemo<[number, number][]>(() => {
    if (!needle) return []
    const hay = value.toLowerCase()
    const out: [number, number][] = []
    let i = hay.indexOf(needle)
    while (i >= 0) {
      out.push([i, i + needle.length])
      i = hay.indexOf(needle, i + needle.length)
    }
    return out
  }, [value, needle])
  const matches = offsets.length
  const clampHit = (n: number) => (matches > 0 ? ((n % matches) + matches) % matches : 0)

  const applyCur = (idx: number, scroll: boolean) => {
    const mirrorEl = mirrorRef.current
    if (!mirrorEl) return
    mirrorEl.querySelectorAll('mark.cur').forEach((m) => m.classList.remove('cur'))
    const el = mirrorEl.querySelectorAll('mark')[idx]
    const ta = textareaRef.current
    if (!el || !ta) return
    el.classList.add('cur')
    if (scroll) el.scrollIntoView({ block: 'center' })
    // keep the textarea viewport glued to the mirror (it normally drives it)
    ta.scrollTop = mirrorEl.scrollTop
    ta.scrollLeft = mirrorEl.scrollLeft
    // native selection overlay on the match — caret lands there for editing
    ta.focus({ preventScroll: true })
    const m = offsets[idx]
    if (m) ta.setSelectionRange(m[0], m[1])
  }

  const commit = () => {
    setNeedle(q.trim().toLowerCase())
    setHit(0)
  }

  const step = (dir: 1 | -1) => {
    if (matches === 0) return
    const next = clampHit(hit + dir)
    setHit(next)
    requestAnimationFrame(() => applyCur(next, true))
  }

  // a fresh needle lands on the first match once the mirror re-rendered
  useEffect(() => {
    if (!needle) return
    requestAnimationFrame(() => applyCur(0, true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle])

  // buffer edited under the same needle: repaint the marker, keep scroll
  useEffect(() => {
    if (!needle) return
    requestAnimationFrame(() => applyCur(clampHit(hit), false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  // replace the buffer and land the caret where the edit happened
  const applyEdit = (next: string, caret: number) => {
    onChange(next)
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(caret, caret)
    })
  }

  const menuItems = (): MenuItem[] => {
    const parsed = rawToRequest(value, 'https://example.com/')
    const ok = !(parsed instanceof Object && 'error' in parsed)
    const headers = ok ? parsed.headers : []
    const bodyText = ok ? bodyToText(parsed.body) : ''
    return [
      // selection group (Burp-style): edit ops on the selected range
      ...(sel
        ? ([
            {
              label: 'Cut',
              hint: '⌃X',
              onClick: async () => {
                await copyToClipboard(sel.text)
                applyEdit(value.slice(0, sel.start) + value.slice(sel.end), sel.start)
              },
            },
            {
              label: 'Copy',
              hint: '⌃C',
              onClick: async () => {
                await copyToClipboard(sel.text)
              },
            },
            {
              label: 'Paste',
              hint: '⌃V',
              onClick: async () => {
                try {
                  const clip = await navigator.clipboard.readText()
                  applyEdit(value.slice(0, sel.start) + clip + value.slice(sel.end), sel.start + clip.length)
                } catch {
                  window.dispatchEvent(
                    new CustomEvent('pulse:notify', { detail: { text: 'Clipboard read was blocked — press Ctrl+V instead', kind: 'err' } }),
                  )
                }
              },
            },
            {
              label: 'Delete',
              hint: '⌫',
              onClick: () => applyEdit(value.slice(0, sel.start) + value.slice(sel.end), sel.start),
            },
            {
              icon: 'terminal' as const,
              label: 'Send to Decoder',
              hint: '⌃⇧D',
              separatorAfter: true,
              onClick: () => {
                window.dispatchEvent(new CustomEvent('pulse:send-to-decoder', { detail: sel.text }))
              },
            },
          ] as MenuItem[])
        : []),
      {
        icon: 'send',
        label: 'Send to Repeater',
        hint: '⌃R',
        separatorAfter: true,
        onClick: () => {
          window.dispatchEvent(new CustomEvent('pulse:send-to-repeater'))
        },
      },
      {
        icon: 'copy',
        label: 'Copy URL',
        onClick: async () => {
          await copyToClipboard(parsed.url, { label: 'URL' })
        },
      },
      ...(ok
        ? [
            {
              icon: 'terminal',
              label: 'Copy as cURL',
              separatorAfter: true,
              onClick: async () => {
                await copyToClipboard(toCurlRequest(parsed.method, parsed.url, headers, bodyText), { label: 'cURL' })
              },
            },
          ]
        : []),
      { icon: 'copy', label: 'Copy raw request', separatorAfter: true, onClick: async () => void (await copyToClipboard(value, { label: 'raw request' })) },
      { icon: 'copy', label: 'Copy headers', onClick: async () => void (await copyToClipboard(headers.map((h) => h.name + ': ' + h.value).join(String.fromCharCode(10)), { label: 'headers' })) },
      { icon: 'copy', label: 'Copy body', onClick: async () => void (await copyToClipboard(bodyText, { label: 'body' })) },
    ]
  }

  // highlight mirror: header names colored like the read-only RawView, plus a
  // line-number gutter (absolute spans inside each line; the textarea gets
  // matching left padding so text stays aligned in both wrap modes).
  // When a search needle is active, matching text gets <mark> spans instead —
  // the marks carry no padding so the mirror keeps exact textarea metrics.
  // The textarea above it is transparent-text; both share exact metrics.
  const mirror = useMemo(() => {
    const lines = value.split('\n')
    // header coloring is scoped to the block between the request line and the
    // first blank line — body lines containing ':' (JSON, URLs) stay plain
    const empty = lines.findIndex((l, i) => i > 0 && l.trim() === '')
    const headEnd = empty < 0 ? lines.length : empty
    return lines.map((line, i) => {
      const ln = <span className="ln">{i + 1}</span>
      if (needle && line.toLowerCase().includes(needle)) {
        const parts: React.ReactNode[] = []
        let rest = line
        let idx = 0
        while (rest) {
          const at = rest.toLowerCase().indexOf(needle)
          if (at < 0) {
            parts.push(rest)
            break
          }
          parts.push(rest.slice(0, at))
          parts.push(<mark key={`${i}-${idx++}`}>{rest.slice(at, at + needle.length)}</mark>)
          rest = rest.slice(at + needle.length)
        }
        return (
          <div key={i}>
            {ln}
            {parts}
          </div>
        )
      }
      const idx = line.indexOf(':')
      if (i > 0 && i < headEnd && idx > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
        const name = line.slice(0, idx)
        const value = line.slice(idx + 1)
        const isCookie = name.toLowerCase() === 'cookie' || name.toLowerCase() === 'set-cookie'
        return (
          <div key={i}>
            {ln}
            <span className="raw-hname">{name}</span>
            <span className="raw-colon">:</span>
            {isCookie ? renderCookieValue(value.trim()) : value || '\u00a0'}
          </div>
        )
      }
      // body lines get JSON property-key tinting (never the request line)
      return (
        <div key={i}>
          {ln}
          {i > 0 && i > headEnd ? renderJSONKeys(line || '\u00a0') : line || '\u00a0'}
        </div>
      )
    })
  }, [value, needle])

  const syncScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    if (mirrorRef.current) {
      mirrorRef.current.scrollTop = e.currentTarget.scrollTop
      mirrorRef.current.scrollLeft = e.currentTarget.scrollLeft
    }
  }

  const sharedText: React.CSSProperties = {
    whiteSpace: wrap ? 'pre-wrap' : 'pre',
    overflowWrap: wrap ? 'anywhere' : 'normal',
    wordBreak: wrap ? 'break-all' : 'normal',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div
        className="raw-edit-stack"
        style={sharedText}
        onContextMenu={(e) => {
          e.preventDefault()
          const live = readSel()
          const snap = live ?? lastSelRef.current
          setSel(snap && snap.end <= value.length ? snap : null)
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        <pre className="raw-mirror" ref={mirrorRef} aria-hidden="true">
          {mirror}
        </pre>
        <textarea
          className="editor raw over-mirror"
          style={sharedText}
          value={value}
          spellCheck={false}
          ref={textareaRef}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          onMouseDown={(e) => {
            // right button: grab the selection before the browser collapses it
            if (e.button === 2) lastSelRef.current = readSel()
          }}
          onMouseUp={(e) => {
            if (e.button === 2) return
            lastSelRef.current = readSel() // null when collapsed → clears stale
          }}
          onKeyUp={() => {
            lastSelRef.current = readSel()
          }}
          placeholder={'GET /path HTTP/1.1' + String.fromCharCode(10) + 'Host: example.com' + String.fromCharCode(10) + String.fromCharCode(10) + 'body'}
        />
        {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}
        <button className="wrap-btn" title="Toggle soft wrap of long lines" onClick={toggleWrap}>
          {wrap ? '⏳ Wrap' : '⏩ Wrap'}
        </button>
      </div>
      <div className="raw-search">
        <Icon name="search" size={11} />
        <input
          value={q}
          spellCheck={false}
          placeholder="Find in raw… (Enter to search)"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key !== 'Enter') return
            e.preventDefault()
            if (q.trim().toLowerCase() !== needle) {
              commit()
              return
            }
            step(e.shiftKey ? -1 : 1)
          }}
        />
        {q.trim() && q.trim().toLowerCase() !== needle && (
          <button className="mini" title="Search (Enter)" onClick={commit}>
            ↵
          </button>
        )}
        {needle && (          <>
            <span className="count">{matches > 0 ? `${clampHit(hit) + 1}/${matches}` : '0'}</span>
            <button
              className="mini"
              title="Previous match (Shift+Enter)"
              disabled={matches < 2}
              onClick={() => (q.trim().toLowerCase() !== needle ? commit() : step(-1))}
            >
              ▲
            </button>
            <button
              className="mini"
              title="Next match (Enter)"
              disabled={matches < 2}
              onClick={() => (q.trim().toLowerCase() !== needle ? commit() : step(1))}
            >
              ▼
            </button>
          </>
        )}
      </div>
    </div>
  )
}
