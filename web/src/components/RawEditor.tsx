// Burp-style raw request editor: one monospace buffer holding the request
// line, headers and body — parsed back into an EditableRequest on send.
import { useState } from 'react'
import { bodyToText, encodeBody } from '../api'
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
  const toggleWrap = () =>
    setWrap((w) => {
      try {
        localStorage.setItem('pulse.rawwrap', w ? '0' : '1')
      } catch {
        /* ignore */
      }
      return !w
    })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <textarea
        className="editor raw"
        style={{ whiteSpace: wrap ? 'pre-wrap' : 'pre', overflowWrap: wrap ? 'anywhere' : 'normal' }}
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'GET /path HTTP/1.1' + String.fromCharCode(10) + 'Host: example.com' + String.fromCharCode(10) + String.fromCharCode(10) + 'body'}
      />
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
