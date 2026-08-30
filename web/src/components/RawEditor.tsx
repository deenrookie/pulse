// Burp-style raw request editor: one monospace buffer holding the request
// line, headers and body — parsed back into an EditableRequest on send.
import { useMemo, useRef, useState } from 'react'
import { bodyToText, copyToClipboard, encodeBody, toCurlRequest } from '../api'
import ContextMenu, { type MenuItem } from './ContextMenu'
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

export default function RawEditor({
  value,
  onChange,
  note,
}: {
  value: string
  onChange: (next: string) => void
  note?: string
}) {
  const [wrap, setWrap] = useState(() => {
    try {
      return localStorage.getItem('pulse.rawwrap') === '1'
    } catch {
      return false
    }
  })
  const mirrorRef = useRef<HTMLPreElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const menuItems = useMemo<MenuItem[]>(() => {
    const parsed = rawToRequest(value, 'https://example.com/')
    const ok = !(parsed instanceof Object && 'error' in parsed)
    const headers = ok ? parsed.headers : []
    const bodyText = ok ? bodyToText(parsed.body) : ''
    return [
      {
        icon: 'send',
        label: 'Send to Repeater',
        hint: '⌃R',
        onClick: () => {
          window.dispatchEvent(new CustomEvent('pulse:send-to-repeater'))
        },
      },
      ...(ok
        ? [
            {
              icon: 'terminal',
              label: 'Copy as cURL',
              separatorAfter: true,
              onClick: async () => {
                await copyToClipboard(toCurlRequest(parsed.method, parsed.url, headers, bodyText))
              },
            },
          ]
        : []),
      { icon: 'copy', label: 'Copy raw request', separatorAfter: true, onClick: async () => void (await copyToClipboard(value)) },
      { icon: 'copy', label: 'Copy headers', onClick: async () => void (await copyToClipboard(headers.map((h) => h.name + ': ' + h.value).join(String.fromCharCode(10)))) },
      { icon: 'copy', label: 'Copy body', onClick: async () => void (await copyToClipboard(bodyText)) },
    ]
  }, [value])
  const toggleWrap = () =>
    setWrap((w) => {
      try {
        localStorage.setItem('pulse.rawwrap', w ? '0' : '1')
      } catch {
        /* ignore */
      }
      return !w
    })

  // highlight mirror: header names colored like the read-only RawView.
  // The textarea above it is transparent-text; both share exact metrics.
  const mirror = useMemo(() => {
    return value.split('\n').map((line, i) => {
      const idx = line.indexOf(':')
      if (i > 0 && idx > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
        return (
          <div key={i}>
            <span className="raw-hname">{line.slice(0, idx)}</span>
            <span className="raw-colon">:</span>
            {line.slice(idx + 1) || '\u00a0'}
          </div>
        )
      }
      return <div key={i}>{line || '\u00a0'}</div>
    })
  }, [value])

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
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          placeholder={'GET /path HTTP/1.1' + String.fromCharCode(10) + 'Host: example.com' + String.fromCharCode(10) + String.fromCharCode(10) + 'body'}
        />
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
      <div className="raw-hint">
        <button className="mini" style={{ marginRight: 8 }} title="Toggle soft wrap of long lines" onClick={toggleWrap}>
          {wrap ? '[x] Wrap' : '[ ] Wrap'}
        </button>
        First line <kbd>METHOD path HTTP/1.1</kbd> · the <kbd>Host</kbd> header (or an absolute URL) sets the target ·
        body after the first blank line · <kbd>Ctrl Enter</kbd> sends{note ? ' · ' + note : ''}
      </div>
    </div>
  )
}
