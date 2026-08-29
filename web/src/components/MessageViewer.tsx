// Structured inspector for one side (request or response) of an HTTP message.
// Sub-tabs: Headers / Params / Pretty (JSON, text or image) / Hex / Raw.
import { useMemo, useState } from 'react'
import { bodyToHex, bodyToText, copyToClipboard, formatSize, looksBinary, prettyJsonIfPossible } from '../api'
import type { Header } from '../types'
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

type Tab = 'headers' | 'params' | 'pretty' | 'hex' | 'raw'

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
        <SubTabs tab={tab} setTab={setTab} hasBody={hasBody} hasParams={params.length > 0} />
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
}: {
  resp?: ResponseLike
  error?: string
  flowId?: string
}) {
  const [tab, setTab] = useState<Tab>('headers')
  if (!resp) {
    return (
      <div className="panel" style={{ flex: 1 }}>
        <div className="panel-head">
          <span className="title">Response</span>
        </div>
        <div className="empty-wrap" style={{ flex: 1, display: 'flex' }}>
          {error ? (
            <div className="empty" style={{ color: 'var(--danger)' }}>
              <div className="glyph" style={{ borderColor: 'rgba(239,112,112,.35)', color: 'var(--danger)' }}>
                <Icon name="alert" size={22} />
              </div>
              <div style={{ wordBreak: 'break-all', color: 'var(--danger)' }}>{error}</div>
            </div>
          ) : (
            <div className="empty">
              <div className="glyph">
                <Icon name="clock" size={22} />
              </div>
              <b>Waiting for response…</b>
            </div>
          )}
        </div>
      </div>
    )
  }
  const hasBody = (resp.body?.length ?? 0) > 0
  const params: [string, string, string][] = []
  const text = bodyToText(resp.body ?? '')
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
        <SubTabs tab={tab} setTab={setTab} hasBody={hasBody} hasParams={false} />
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
      </div>
      <div className="panel-body">
        <TabBody tab={tab} headers={resp.headers} params={params} text={text} b64={resp.body} kind="response" />
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
}: {
  tab: Tab
  setTab: (t: Tab) => void
  hasBody: boolean
  hasParams: boolean
}) {
  const tabs: [Tab, string][] = [
    ['headers', 'Headers'],
    ...(hasParams ? ([['params', 'Params']] as [Tab, string][]) : []),
    ...(hasBody ? ([['pretty', 'Pretty'], ['hex', 'Hex'], ['raw', 'Raw']] as [Tab, string][]) : []),
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
