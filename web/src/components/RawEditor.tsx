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

/** parse the raw buffer back; fallbackUrl supplies the default scheme */
export function rawToRequest(raw: string, fallbackUrl: string): EditableRequest | { error: string } {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  const head = lines[0] ?? ''
  const m = head.match(/^(\S+)\s+(\S+)(?:\s+(HTTP\/[\d.]+))?\s*$/)
  if (!m) {
    return { error: 'First line must be: METHOD /path HTTP/1.1' }
  }
  const [, method, target, version] = m

  let empty = lines.findIndex((l, idx) => idx > 0 && l.trim() === '')
  if (empty < 0) empty = lines.length
  const headers: { name: string; value: string }[] = []
  for (const line of lines.slice(1, empty)) {
    const idx = line.indexOf(':')
    if (idx <= 0) return { error: `Invalid header line: ${line}` }
    headers.push({ name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() })
  }
  const body = lines.slice(empty + 1).join('\n')

  let scheme = /^http:\/\//i.test(fallbackUrl) ? 'http' : 'https'
  let host = ''
  let path = target
  if (/^https?:\/\//i.test(target)) {
    try {
      const u = new URL(target)
      scheme = u.protocol.replace(':', '')
      host = u.host
      path = u.pathname + u.search
    } catch {
      return { error: `Invalid absolute URL in request line: ${target}` }
    }
  }
  const hostHeader = headers.find((h) => h.name.toLowerCase() === 'host')
  if (hostHeader) host = hostHeader.value
  if (!host) {
    return { error: 'Missing Host header — add one, or use an absolute URL in the request line' }
  }
  if (!path.startsWith('/')) path = '/' + path
  return {
    method: method.toUpperCase(),
    url: `${scheme}://${host}${path}`,
    httpVersion: version || 'HTTP/1.1',
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
      ...(ok
        ? [
            {
              icon: 'terminal',
              label: 'Copy as cURL',
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
