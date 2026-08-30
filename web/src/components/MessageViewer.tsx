// Structured inspector for one side (request or response) of an HTTP message.
// Sub-tabs: Headers / Params / Pretty (JSON, text or image) / Hex / Raw.
import { useEffect, useMemo, useState } from 'react'
import {
  bodyToHex,
  bodyToText,
  bodyToTextDecoded,
  copyToClipboard,
  formatSize,
  getFlow,
  looksBinary,
  prettyJsonIfPossible,
  rawOfMessage,
  toCurl,
} from '../api'
import type { Header, WSMessage } from '../types'
import Icon from '../ui/Icon'
import ContextMenu, { type MenuItem } from './ContextMenu'
import RawEditor from './RawEditor'
import { toCurlRequest } from '../api'

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

export function RequestInspector({
  req,
  flowId,
  raw,
  onRawChange,
}: {
  req: RequestLike
  flowId?: string
  /** Repeater mode: the Raw tab becomes an editor wired to the parent state */
  raw?: string
  onRawChange?: (v: string) => void
}) {
  const [tab, setTab] = useState<Tab>('headers')
  const params = useMemo(() => collectParams(req.url, req.headers, req.body), [req.url, req.headers, req.body])
  const hasBody = (req.body?.length ?? 0) > 0
  const text = useMemo(() => bodyToText(req.body), [req.body])
  const editableRaw = raw !== undefined && onRawChange // any caller passing raw gets an editable buffer
  return (
    <div className="panel" style={{ flex: 1 }}>
      <div className="panel-head">
        <span className="title">Request</span>
        <span className="meta" title={req.url}>
          {req.method} {pathOf(req.url)}
        </span>
        <div className="spacer" />
        <CopyRaw
          text={raw ?? text}
          kind="request"
          headLine={`${req.method} ${pathOf(req.url)} ${req.httpVersion || 'HTTP/1.1'}`}
          headers={req.headers}
        />
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
      <div className={`panel-body ${tab === 'raw' && editableRaw ? 'io-flex' : ''}`}>
        {tab === 'raw' && editableRaw ? (
          <RawEditor value={raw} onChange={onRawChange} />
        ) : (
          <TabBody tab={tab} headers={req.headers} params={params} text={text} b64={req.body} kind="request" req={req} curlFlowId={flowId} curlRequest={editableRaw ? req : undefined} />
        )}
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
        <CopyRaw
          text={text}
          kind="response"
          headLine={`${resp.httpVersion || 'HTTP/1.1'} ${resp.statusCode} ${resp.reason}`}
          headers={resp.headers}
        />
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
          <TabBody tab={tab} headers={resp.headers} params={params} text={text} b64={resp.body} kind="response" curlFlowId={flowId} />
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

function CopyRaw({ text, kind, headLine, headers, title }: {
  text: string
  kind: 'request' | 'response'
  headLine: string
  headers: Header[]
  title?: string
}) {
  return (
    <button
      className="btn ghost sm icon-btn"
      title={title ?? `Copy the complete raw ${kind} to the clipboard`}
      onClick={async () => {
        await copyToClipboard(rawOfMessage(headLine, headers, text))
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
  curlFlowId,
  curlRequest,
}: {
  tab: Tab
  headers: Header[]
  params: [string, string, string][]
  text: string
  b64: string | null
  kind: 'request' | 'response'
  req?: RequestLike
  curlFlowId?: string
  /** ad-hoc request (Repeater) — enables Copy as cURL without a stored flow */
  curlRequest?: RequestLike
}) {
  switch (tab) {
    case 'headers':
      return <HeadersTable headers={headers} />
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
      const headLine =
        kind === 'request' && req ? `${req.method} ${pathOf(req.url)} ${req.httpVersion || 'HTTP/1.1'}` : undefined
      return <RawView headLine={headLine} headers={headers} text={text} flowIdForCurl={curlFlowId} curlRequest={curlRequest} />
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

/** Burp-style raw view: start line, headers with colored names, blank
 *  line, body — with an in-content search bar and a context menu. */
function RawView({
  headLine,
  headers,
  text,
  flowIdForCurl,
  curlRequest,
}: {
  headLine?: string
  headers: Header[]
  text: string
  flowIdForCurl?: string
  curlRequest?: RequestLike
}) {
  const [q, setQ] = useState('')
  const [hit, setHit] = useState(0)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const fullRaw = useMemo(
    () => rawOfMessage(headLine ?? `${headers.length} headers`, headers, text),
    [headLine, headers, text],
  )

  const needle = q.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!needle) return 0
    return fullRaw.toLowerCase().split(needle).length - 1
  }, [fullRaw, needle])
  const clampHit = (n: number) => (matches > 0 ? ((n % matches) + matches) % matches : 0)
  const step = (dir: 1 | -1) => {
    const next = clampHit(hit + dir)
    setHit(next)
    document.querySelectorAll('.raw-lines mark.cur')?.forEach((m) => m.classList.remove('cur'))
    const els = document.querySelectorAll('.raw-lines mark')
    els[next]?.classList.add('cur')
    els[next]?.scrollIntoView({ block: 'center' })
  }

  const renderLine = (line: string, key: number) => {
    if (!needle || !line.toLowerCase().includes(needle)) {
      return <RawLine key={key} line={line} n={key} />
    }
    // highlight all occurrences
    const parts: React.ReactNode[] = []
    let rest = line
    let idx = 0
    while (rest) {
      const hit = rest.toLowerCase().indexOf(needle)
      if (hit < 0) {
        parts.push(rest)
        break
      }
      parts.push(rest.slice(0, hit))
      parts.push(<mark key={`${key}-${idx++}`}>{rest.slice(hit, hit + needle.length)}</mark>)
      rest = rest.slice(hit + needle.length)
    }
    return (
      <div key={key}>
        <span className="ln">{key + 1}</span>
        {parts}
      </div>
    )
  }

  const lines = useMemo(() => {
    const head: string[] = []
    if (headLine) head.push(headLine)
    for (const h of headers) head.push(`${h.name}: ${h.value}`)
    head.push('')
    return [...head, ...text.split('\n')]
  }, [headLine, headers, text])

  const menuItems = (): MenuItem[] => [
    ...((flowIdForCurl || curlRequest)
      ? [
          {
            icon: 'terminal' as const,
            label: 'Copy as cURL',
            onClick: async () => {
              const cmd = flowIdForCurl
                ? toCurl(await getFlow(flowIdForCurl))
                : toCurlRequest(curlRequest!.method, curlRequest!.url, curlRequest!.headers, bodyToText(curlRequest!.body))
              await copyToClipboard(cmd)
            },
          },
        ]
      : []),
    {
      icon: 'copy',
      label: 'Copy raw message',
      separatorAfter: !!flowIdForCurl,
      onClick: async () => {
        await copyToClipboard(fullRaw)
      },
    },
    {
      icon: 'copy',
      label: 'Copy headers',
      onClick: async () => {
        await copyToClipboard(headers.map((h) => `${h.name}: ${h.value}`).join('\n'))
      },
    },
    {
      icon: 'copy',
      label: 'Copy body',
      onClick: async () => {
        await copyToClipboard(text)
      },
    },
  ]

  return (
    <div className="raw-wrap">
      <pre
        className="code-view raw-lines"
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        {lines.map((l, i) => renderLine(l, i))}
      </pre>
      <div className="raw-search">
        <Icon name="search" size={11} />
        <input
          value={q}
          spellCheck={false}
          placeholder="Find in raw…"
          onChange={(e) => {
            setQ(e.target.value)
            setHit(0)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              step(e.shiftKey ? -1 : 1)
            }
          }}
        />
        {needle && (
          <>
            <span className="count">
              {matches > 0 ? `${clampHit(hit) + 1}/${matches}` : '0'}
            </span>
            <button className="mini" title="Previous match (Shift+Enter)" disabled={matches < 2} onClick={() => step(-1)}>
              ▲
            </button>
            <button className="mini" title="Next match (Enter)" disabled={matches < 2} onClick={() => step(1)}>
              ▼
            </button>
          </>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** one raw line: header names get their own color (Burp-style), with a
 *  hover copy button on header lines */
function RawLine({ line, n }: { line: string; n: number }) {
  const idx = line.indexOf(':')
  const isHeader = n > 0 && idx > 0 && !line.startsWith(' ')
  if (!isHeader) {
    return (
      <div>
        <span className="ln">{n + 1}</span>
        {line || ' '}
      </div>
    )
  }
  const name = line.slice(0, idx)
  const value = line.slice(idx + 1)
  return (
    <div className="raw-hdr">
      <span className="ln">{n + 1}</span>
      <CopyableText className="raw-hname" text={name} />
      <span className="raw-colon">:</span>
      <CopyableText className="raw-hvalue" text={value.slice(1)} />
    </div>
  )
}

/** headers table with per-row context menu + hover copy buttons */
function HeadersTable({ headers }: { headers: Header[] }) {
  const [menu, setMenu] = useState<{ x: number; y: number; h: Header } | null>(null)
  const allText = headers.map((h) => `${h.name}: ${h.value}`).join(String.fromCharCode(10))
  return (
    <>
      <table className="kv-table">
        <tbody>
          {headers.map((h, i) => (
            <tr
              key={i}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, h })
              }}
              title="Right-click for actions"
            >
              <td><CopyableText text={h.name} /></td>
              <td><CopyableText text={h.value} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { icon: 'copy', label: `Copy "${menu.h.name}: ${menu.h.value.slice(0, 24)}${menu.h.value.length > 24 ? '…' : ''}"`, onClick: async () => void (await copyToClipboard(`${menu.h.name}: ${menu.h.value}`)) },
            { icon: 'copy', label: 'Copy value', onClick: async () => void (await copyToClipboard(menu.h.value)) },
            { icon: 'copy', label: 'Copy all headers', separatorAfter: true, onClick: async () => void (await copyToClipboard(allText)) },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}

/** text span with a hover-revealed copy button */
function CopyableText({ text, className }: { text: string; className?: string }) {
  const [hover, setHover] = useState(false)
  return (
    <span
      className={`copyable ${className ?? ''}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={text}
    >
      {text}
      {hover && (
        <button
          className="copy-mini"
          title="Copy"
          onClick={(e) => {
            e.stopPropagation()
            void copyToClipboard(text)
          }}
        >
          <Icon name="copy" size={10} />
        </button>
      )}
    </span>
  )
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
