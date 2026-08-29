// Structured inspector for one side (request or response) of an HTTP message.
// Sub-tabs: Headers / Params / Pretty (JSON, text or image) / Hex / Raw.
import { useEffect, useMemo, useState } from 'react'
import { bodyToHex, bodyToText, bodyToTextDecoded, copyToClipboard, formatSize, looksBinary, prettyJsonIfPossible } from '../api'
import type { Header, WSMessage } from '../types'
import Icon from '../ui/Icon'

interface RequestLike {
  method: string
  url: string
  httpVersion: string
  headers: Header[]
  body: string | null
  truncated: boolean
  timestamp: string
}

interface ResponseLike {
  statusCode: number
  reason: string
  httpVersion: string
  headers: Header[]
  body: string | null
  truncated: boolean
  timestamp: string
  durationMs: number
}

type Tab = 'headers' | 'params' | 'pretty' | 'hex' | 'raw' | 'ws'

export function RequestInspector({ req }: { req: RequestLike }) {
  const [tab, setTab] = useState<Tab>('headers')
  const params = useMemo(() => collectParams(req.url, req.headers, req.body), [req.url, req.headers, req.body])
  const hasBody = (req.body?.length ?? 0) > 0
  const text = useMemo(() => bodyToText(req.body), [req.body])
  return (
    <div className="panel" style={{ flex: 1 }}>
      <div className="panel-head">
        <span className="title">Request</span>
        <span className="meta" title={req.url}>
          {req.method} {pathOf(req.url)}
        </span>
        <div className="spacer" />
        <CopyBody b64={req.body} />
        {/* Raw (request line + headers + body) is always available — GET and
            other body-less requests still have a raw form */}
        <SubTabs tab={tab} setTab={setTab} hasBody={hasBody} hasParams={params.length > 0} alwaysRaw />
      </div>
      <div className="summary-strip">
        <span>
          <b>{req.httpVersion || 'HTTP/1.1'}</b>
        </span>
        <span>
          host <b>{hostOf(req.url)}</b>
        </span>
        {hasBody && (
          <span>
            body <b>{formatSize(Math.floor(((req.body?.length ?? 0) * 3) / 4))}</b>
          </span>
        )}
        {req.truncated && <span className="warn-inline">⚠ truncated</span>}
      </div>
      <div className="panel-body">
        <TabBody tab={tab} headers={req.headers} params={params} text={text} b64={req.body} kind="request" req={req} />
      </div>
    </div>
  )
}

export function ResponseInspector({
  resp,
  error,
  flowId,
  ws,
}: {
  resp?: ResponseLike
  error?: string
  flowId?: string
  ws?: WSMessage[]
}) {
  const [tab, setTab] = useState<Tab>('headers')
  // transparently decompress gzip/deflate/br response bodies for display
  const contentEncoding = (resp?.headers ?? []).find((h) => h.name.toLowerCase() === 'content-encoding')?.value ?? ''
  const [decoded, setDecoded] = useState<{ text: string; encoding: string; decodedBytes: number } | null>(null)
  useEffect(() => {
    let alive = true
    setDecoded(null)
    if (resp?.body) {
      void bodyToTextDecoded(resp.body, contentEncoding).then((d) => alive && setDecoded(d))
    }
    return () => {
      alive = false
    }
  }, [resp?.body, contentEncoding, resp])
  const text = decoded?.text ?? ''
  const wasDecompressed = !!decoded && decoded.decodedBytes > 0 && !!contentEncoding
  if (!resp) {
    return (
      <div className="panel" style={{ flex: 1 }}>
        <div className="panel-head">
          <span className="title">Response</span>
        </div>
        {error ? (
          <div className="empty" style={{ color: 'var(--danger)' }}>
            <div className="glyph" style={{ borderColor: 'rgb(var(--danger-rgb) / .35)', color: 'var(--danger)' }}>
              <Icon name="alert" size={22} />
            </div>
            <div style={{ wordBreak: 'break-all', color: 'var(--danger)' }}>{error}</div>
          </div>
        ) : (
          <div className="waiting">
            <div className="glyph">
              <Icon name="pulse" size={22} />
            </div>
            <b>Waiting for response</b>
            <span className="hint">
              The response appears here the moment it arrives.
              <br />
              Status line, headers and body render live.
            </span>
          </div>
        )}
      </div>
    )
  }
  const hasBody = (resp.body?.length ?? 0) > 0
  const params: [string, string, string][] = []
  return (
    <div className="panel" style={{ flex: 1 }}>
      <div className="panel-head">
        <span className="title">Response</span>
        <span className={`status${Math.floor(resp.statusCode / 100)} mono`} style={{ fontWeight: 700 }}>
          {resp.statusCode} {resp.reason}
        </span>
        <div className="spacer" />
        <CopyBody b64={resp.body} />
        {flowId && resp.statusCode > 0 && (
          <button
            className="btn ghost sm icon-btn"
            title="Open this response in a browser tab"
            onClick={() => window.open(`/api/flows/${flowId}/render`, '_blank')}
          >
            <Icon name="external" size={13} />
          </button>
        )}
        <SubTabs tab={tab} setTab={setTab} hasBody={hasBody} hasParams={false} alwaysRaw wsCount={ws?.length ?? 0} />
      </div>
      <div className="summary-strip">
        <span>
          <b>{resp.httpVersion || 'HTTP/1.1'}</b>
        </span>
        <span>
          received <b>{new Date(resp.timestamp).toLocaleTimeString([], { hour12: false })}</b>
        </span>
        <span>
          time <b>{resp.durationMs}ms</b>
        </span>
        <span>
          size <b>{formatSize(Math.floor(((resp.body?.length ?? 0) * 3) / 4))}</b>
        </span>
        {resp.truncated && <span className="warn-inline">⚠ truncated</span>}
        {wasDecompressed && (
          <span className="warn-inline" title="Body was compressed in transit; shown decompressed">
            ⇄ {decoded.encoding} → {formatSize(decoded.decodedBytes)}
          </span>
        )}
      </div>
      <div className="panel-body">
        {tab === 'ws' ? (
          <WSPanel ws={ws ?? []} />
        ) : (
          <TabBody tab={tab} headers={resp.headers} params={params} text={text} b64={resp.body} kind="response" />
        )}
      </div>
    </div>
  )
}

/** WebSocket message list + one selected message's content */
function WSPanel({ ws }: { ws: WSMessage[] }) {
  const [sel, setSel] = useState<number | null>(null)
  const current = sel !== null ? ws[sel] : null
  if (ws.length === 0) {
    return (
      <div className="empty">
        <div className="glyph">
          <Icon name="bolt" size={22} />
        </div>
        <b>No WebSocket messages</b>
        <div>The upgrade handshake was captured, but no frames have passed yet.</div>
      </div>
    )
  }
  return (
    <div className="ws-pane">
      <div className="ws-list">
        {ws.map((m, i) => (
          <div
            key={i}
            className={`ws-row ${sel === i ? 'selected' : ''}`}
            onClick={() => setSel(i)}
            title={`${m.dir === 'c2s' ? 'client → server' : 'server → client'} · ${m.opcode} · ${m.size} B — click to view`}
          >
            <span className={`ws-arrow ${m.dir}`}>{m.dir === 'c2s' ? '→' : '←'}</span>
            <span className="ws-op">{m.opcode}</span>
            <span className="grow" />
            <span className="ws-size">{formatSize(m.size)}</span>
            {m.truncated && <span className="ws-size" title="payload capped">…</span>}
          </div>
        ))}
      </div>
      <div className="ws-body">
        {current ? (
          current.opcode === 'text' ? (
            <pre className="code-view">{bodyToText(current.data ?? '') || '(empty)'}</pre>
          ) : current.opcode === 'binary' ? (
            <pre className="code-view">{bodyToHex(current.data ?? '')}</pre>
          ) : (
            <div className="empty">
              <b>{current.opcode} frame</b>
              <div>{formatSize(current.size)} control frame — no payload to show.</div>
            </div>
          )
        ) : (
          <div className="empty">
            <div className="glyph">
              <Icon name="bolt" size={22} />
            </div>
            <b>{ws.length} message{ws.length > 1 ? 's' : ''}</b>
            <div>Click one to view its payload.</div>
          </div>
        )}
      </div>
    </div>
  )
}

function CopyBody({ b64 }: { b64: string | null }) {
  if (!b64) return null
  return (
    <button
      className="btn ghost sm icon-btn"
      title="Copy body to clipboard"
      onClick={async () => {
        await copyToClipboard(bodyToText(b64))
      }}
    >
      <Icon name="copy" size={13} />
    </button>
  )
}

function SubTabs({
  tab,
  setTab,
  hasBody,
  hasParams,
  alwaysRaw,
  wsCount,
}: {
  tab: Tab
  setTab: (t: Tab) => void
  hasBody: boolean
  hasParams: boolean
  /** show Raw (start line + headers + body) even when there is no body */
  alwaysRaw?: boolean
  wsCount?: number
}) {
  const tabs: [Tab, string][] = [
    ['headers', 'Headers'],
    ...(hasParams ? ([['params', 'Params']] as [Tab, string][]) : []),
    ...(alwaysRaw || hasBody ? ([['raw', 'Raw']] as [Tab, string][]) : []),
    ...(hasBody ? ([['pretty', 'Pretty'], ['hex', 'Hex']] as [Tab, string][]) : []),
    ...(wsCount ? ([['ws', `WebSocket (${wsCount})`]] as [Tab, string][]) : []),
  ]
  return (
    <div className="subtabs">
      {tabs.map(([t, label]) => (
        <button key={t} className={`subtab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
          {label}
        </button>
      ))}
    </div>
  )
}

function TabBody({
  tab,
  headers,
  params,
  text,
  b64,
  kind,
  req,
}: {
  tab: Tab
  headers: Header[]
  params: [string, string, string][]
  text: string
  b64: string | null
  kind: 'request' | 'response'
  req?: RequestLike
}) {
  switch (tab) {
    case 'headers':
      return (
        <table className="kv-table">
          <tbody>
            {headers.map((h, i) => (
              <tr key={i}>
                <td>{h.name}</td>
                <td>{h.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )
    case 'params':
      return (
        <table className="kv-table">
          <tbody>
            {params.map(([where, k, v], i) => (
              <tr key={i}>
                <td>{k}</td>
                <td>
                  <span className="src-tag">[{where}]</span>
                  {v}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )
    case 'pretty': {
      const json = prettyJsonIfPossible(text)
      if (json) return <pre className="code-view">{json}</pre>
      const ct = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? ''
      if (ct.startsWith('image/') && b64) return <ImagePreview b64={b64} contentType={ct} />
      if (looksBinary(b64)) return <BinaryNotice b64={b64} />
      return <pre className="code-view">{text || '(empty)'}</pre>
    }
    case 'hex':
      return <pre className="code-view">{bodyToHex(b64)}</pre>
    case 'raw': {
      const lines = rawView(kind, req, headers, text)
      return (
        <pre className="code-view">
          {lines.map((l, i) => (
            <div key={i}>
              <span className="ln">{i + 1}</span>
              {l}
            </div>
          ))}
        </pre>
      )
    }
  }
}

function ImagePreview({ b64, contentType }: { b64: string; contentType: string }) {
  const bytes = Math.floor((b64.length * 3) / 4)
  return (
    <div className="img-preview">
      <img src={`data:${contentType.split(';')[0]};base64,${b64}`} alt="response body" />
      <span className="caption">
        {contentType} · {formatSize(bytes)}
      </span>
    </div>
  )
}

function BinaryNotice({ b64 }: { b64: string | null }) {
  const bytes = Math.floor(((b64?.length ?? 0) * 3) / 4)
  return (
    <div className="empty">
      <div className="glyph">
        <Icon name="file" size={22} />
      </div>
      <b>Binary body</b>
      <div>
        {formatSize(bytes)} — switch to the Hex tab to inspect the bytes.
      </div>
    </div>
  )
}

function rawView(kind: 'request' | 'response', req: RequestLike | undefined, headers: Header[], bodyText: string): string[] {
  const head: string[] = []
  if (kind === 'request' && req) {
    head.push(`${req.method} ${pathOf(req.url)} ${req.httpVersion || 'HTTP/1.1'}`)
  }
  for (const h of headers) head.push(`${h.name}: ${h.value}`)
  head.push('')
  const bodyLines = bodyText ? bodyText.split('\n') : []
  return [...head, ...bodyLines]
}

function collectParams(url: string, headers: Header[], bodyB64: string | null): [string, string, string][] {
  const out: [string, string, string][] = []
  try {
    const q = url.slice(url.indexOf('?') + 1)
    if (url.includes('?') && q) {
      for (const pair of q.split('&')) {
        const [k, v = ''] = pair.split('=')
        out.push(['query', decodeMaybe(k), decodeMaybe(v)])
      }
    }
  } catch {
    /* ignore */
  }
  for (const h of headers) {
    if (h.name.toLowerCase() === 'cookie') {
      for (const pair of h.value.split(';')) {
        const [k, ...rest] = pair.trim().split('=')
        if (k) out.push(['cookie', k, rest.join('=')])
      }
    }
  }
  const ct = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? ''
  if (ct.includes('application/x-www-form-urlencoded') && bodyB64) {
    try {
      const text = bodyToText(bodyB64)
      for (const pair of text.split('&')) {
        const [k, v = ''] = pair.split('=')
        out.push(['body', decodeMaybe(k), decodeMaybe(v)])
      }
    } catch {
      /* ignore */
    }
  }
  return out
}

function decodeMaybe(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return s
  }
}

function hostOf(url: string): string {
  const m = url.match(/^\w+:\/\/([^/?#]+)/)
  return m ? m[1] : url
}

function pathOf(url: string): string {
  const i = url.indexOf('://')
  const rest = i >= 0 ? url.slice(i + 3) : url
  const j = rest.indexOf('/')
  return j >= 0 ? rest.slice(j) : '/'
}
