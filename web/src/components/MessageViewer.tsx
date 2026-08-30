// Structured inspector for one side (request or response) of an HTTP message.
// Sub-tabs: Headers / Params / Pretty (JSON, text or image) / Hex / Raw.
import { useEffect, useMemo, useRef, useState } from 'react'
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
  hideRawHint,
}: {
  req: RequestLike
  flowId?: string
  /** Repeater mode: the Raw tab becomes an editor wired to the parent state */
  raw?: string
  onRawChange?: (v: string) => void
  /** suppress the raw format hint bar under the editor */
  hideRawHint?: boolean
}) {
  const [tab, setTab] = useState<Tab>('raw')
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
        <SubTabs tab={tab} setTab={setTab} hasBody={hasBody} alwaysRaw />
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
          <RawEditor value={raw} onChange={onRawChange} hideHint={hideRawHint} />
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
  const [tab, setTab] = useState<Tab>('raw')
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
        <SubTabs tab={tab} setTab={setTab} hasBody={hasBody} alwaysRaw wsCount={ws?.length ?? 0} />
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
          <TabBody tab={tab} headers={resp.headers} params={params} text={text} b64={resp.body} kind="response" curlFlowId={flowId} decompressed={wasDecompressed} statusLine={`${resp.httpVersion || 'HTTP/1.1'} ${resp.statusCode} ${resp.reason}`} />
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
        await copyToClipboard(rawOfMessage(headLine, headers, text), { label: `raw ${kind}` })
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
  alwaysRaw,
  wsCount,
}: {
  tab: Tab
  setTab: (t: Tab) => void
  hasBody: boolean
  /** show Raw (start line + headers + body) even when there is no body */
  alwaysRaw?: boolean
  wsCount?: number
}) {
  const tabs: [Tab, string][] = [
    ...(alwaysRaw || hasBody ? ([['raw', 'Raw']] as [Tab, string][]) : [['headers', 'Headers']] as [Tab, string][]),
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
  decompressed,
  statusLine,
}: {
  tab: Tab
  headers: Header[]
  params: [string, string, string][]
  text: string
  b64: string | null
  kind: 'request' | 'response'
  req?: RequestLike
  curlFlowId?: string
  /** true when text came from transparent decompression — binary sniffing
   *  must judge the decoded text, not the compressed wire bytes */
  decompressed?: boolean
  /** ad-hoc request (Repeater) — enables Copy as cURL without a stored flow */
  curlRequest?: RequestLike
  /** response status line (e.g. "HTTP/1.1 200 OK") */
  statusLine?: string
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
      if (json) return <CappedPre text={json} />
      const ct = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? ''
      if (ct.startsWith('image/') && b64) return <ImagePreview b64={b64} contentType={ct} />
      if (!decompressed && looksBinary(b64)) return <BinaryNotice b64={b64} />
      return <CappedPre text={text} emptyHint="(empty)" />
    }
    case 'hex':
      return <pre className="code-view">{bodyToHex(b64)}</pre>
    case 'raw': {
      const headLine =
        kind === 'request' && req
          ? `${req.method} ${pathOf(req.url)} ${req.httpVersion || 'HTTP/1.1'}`
          : statusLine
      return <RawView headLine={headLine} headers={headers} text={text} flowIdForCurl={curlFlowId} curlRequest={curlRequest} urlForCopy={kind === 'request' ? req?.url : undefined} />
    }
  }
}

/** renders text with a display cap + expander (multi-MB bodies jank) */
function CappedPre({ text, emptyHint }: { text: string; emptyHint?: string }) {
  const CAP = 200_000
  const [showAll, setShowAll] = useState(false)
  if (!text && emptyHint !== undefined) return <pre className="code-view">{emptyHint}</pre>
  if (text.length <= CAP || showAll) return <pre className="code-view">{text}</pre>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <pre className="code-view" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{text.slice(0, CAP)}</pre>
      <div className="raw-cap">
        Showing the first {(CAP / 1000).toFixed(0)}k of {(text.length / 1e6).toFixed(2)}M characters
        <button className="mini" onClick={() => setShowAll(true)}>
          Show all anyway
        </button>
      </div>
    </div>
  )
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

/** Burp-style raw view: start line, headers with colored names, blank
 *  line, body — with an in-content search bar and a context menu. */
function RawView({
  headLine,
  headers,
  text,
  flowIdForCurl,
  curlRequest,
  urlForCopy,
}: {
  headLine?: string
  headers: Header[]
  text: string
  flowIdForCurl?: string
  curlRequest?: RequestLike
  /** request side only — adds the Burp-style "Copy URL" menu entry */
  urlForCopy?: string
}) {
  const [q, setQ] = useState('')
  const [hit, setHit] = useState(0)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [wrap, toggleWrap] = useRawWrap()
  const preRef = useRef<HTMLPreElement>(null)
  // text selected inside this raw at context-menu time (read-only side: Copy
  // + Send to Decoder only — no cut/paste, matching Burp's read-only viewers)
  const [selText, setSelText] = useState<string | null>(null)
  // Chrome can clear the page selection on right-button mousedown before
  // contextmenu fires — snapshot it so the menu still targets it (Burp-style)
  const lastSelRef = useRef<string | null>(null)
  const readSel = () => {
    const s = window.getSelection()
    if (!s || s.isCollapsed) return null
    const node = s.anchorNode
    return node && preRef.current?.contains(node) ? s.toString() : null
  }

  const fullRaw = useMemo(
    () => rawOfMessage(headLine ?? '', headers, text),
    [headLine, headers, text],
  )

  // cap what hits the DOM: minified bundles can be one multi-MB line and
  // rendering that synchronously freezes the tab. Show a prefix + expander.
  const CAP = 200_000
  const [showAll, setShowAll] = useState(false)
  const rawText = showAll ? fullRaw : fullRaw.length > CAP ? fullRaw.slice(0, CAP) : fullRaw

  const needle = q.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!needle) return 0
    return fullRaw.toLowerCase().split(needle).length - 1
  }, [fullRaw, needle])
  const clampHit = (n: number) => (matches > 0 ? ((n % matches) + matches) % matches : 0)

  // paint the current-match marker inside THIS raw only (the old global
  // document.querySelectorAll crossed wires between multiple raw panes)
  const applyCur = (idx: number, scroll: boolean) => {
    const root = preRef.current
    if (!root) return
    root.querySelectorAll('mark.cur').forEach((m) => m.classList.remove('cur'))
    const el = root.querySelectorAll('mark')[idx]
    if (el) {
      el.classList.add('cur')
      if (scroll) el.scrollIntoView({ block: 'center' })
    }
  }

  // typing a needle: land on the first match immediately so the highlight
  // is visible even when it lives outside the viewport
  useEffect(() => {
    if (!needle) return
    requestAnimationFrame(() => applyCur(0, true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle])

  // content swapped under the same needle (cap expander, live flow update):
  // repaint the marker at the (clamped) position without stealing scroll
  useEffect(() => {
    if (!needle) return
    requestAnimationFrame(() => applyCur(clampHit(hit), false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawText])

  const step = (dir: 1 | -1) => {
    const next = clampHit(hit + dir)
    setHit(next)
    requestAnimationFrame(() => applyCur(next, true))
  }

  const renderLine = (line: string, key: number) => {
    if (!needle || !line.toLowerCase().includes(needle)) {
      return <RawLine key={key} line={line} n={key} inHead={key > 0 && key < headEnd} />
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

  // fullRaw already contains the start line + header block + body — split it
  // directly (prepending a separate head block duplicated every header)
  const lines = useMemo(() => rawText.split('\n'), [rawText])
  // header names are colored only between the start line and the first blank
  // line — body lines containing ':' (JSON, URLs) must not light up as headers
  const headEnd = useMemo(() => {
    const i = lines.findIndex((l, idx) => idx > 0 && l.trim() === '')
    return i < 0 ? lines.length : i
  }, [lines])

  const menuItems = (): MenuItem[] => [
    ...(selText
      ? [
          {
            label: 'Copy',
            hint: '⌃C',
            onClick: async () => {
              await copyToClipboard(selText, { label: 'selection' })
            },
          },
          {
            icon: 'terminal' as const,
            label: 'Send to Decoder',
            hint: '⌃⇧D',
            separatorAfter: true,
            onClick: () => {
              window.dispatchEvent(new CustomEvent('pulse:send-to-decoder', { detail: selText }))
            },
          },
        ]
      : []),
    ...((flowIdForCurl || curlRequest)
      ? [
          {
            icon: 'terminal' as const,
            label: 'Copy as cURL',
            onClick: async () => {
              const cmd = flowIdForCurl
                ? toCurl(await getFlow(flowIdForCurl))
                : toCurlRequest(curlRequest!.method, curlRequest!.url, curlRequest!.headers, bodyToText(curlRequest!.body))
              await copyToClipboard(cmd, { label: 'cURL' })
            },
          },
        ]
      : []),
    ...(urlForCopy
      ? [
          {
            icon: 'copy' as const,
            label: 'Copy URL',
            separatorAfter: true,
            onClick: async () => {
              await copyToClipboard(urlForCopy, { label: 'URL' })
            },
          },
        ]
      : []),
    {
      icon: 'copy',
      label: 'Copy raw message',
      separatorAfter: !!flowIdForCurl,
      onClick: async () => {
        await copyToClipboard(fullRaw, { label: 'raw message' })
      },
    },
    {
      icon: 'copy',
      label: 'Copy headers',
      onClick: async () => {
        await copyToClipboard(headers.map((h) => `${h.name}: ${h.value}`).join('\n'), { label: 'headers' })
      },
    },
    {
      icon: 'copy',
      label: 'Copy body',
      onClick: async () => {
        await copyToClipboard(text, { label: 'body' })
      },
    },
  ]

  return (
    <div className="raw-wrap">
      <button className="wrap-btn" title="Toggle soft wrap of long lines" onClick={toggleWrap}>
        {wrap ? '⏳ Wrap' : '⏩ Wrap'}
      </button>
      <pre
        ref={preRef}
        className={`code-view raw-lines ${wrap ? '' : 'no-wrap'}`}
        onMouseDown={(e) => {
          if (e.button === 2) lastSelRef.current = readSel()
        }}
        onMouseUp={(e) => {
          if (e.button === 2) return
          lastSelRef.current = readSel() // null when collapsed → clears stale
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setSelText(readSel() ?? lastSelRef.current)
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
      {fullRaw.length > CAP && !showAll && (
        <div className="raw-cap">
          Showing the first {(CAP / 1000).toFixed(0)}k of {(fullRaw.length / 1e6).toFixed(2)}M characters — rendering everything can freeze the tab
          <button className="mini" onClick={() => setShowAll(true)}>
            Show all anyway
          </button>
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** one raw line: header names get their own color (Burp-style), with a
 *  hover copy button on header lines — inHead scopes the coloring to the
 *  header block so body lines containing ':' stay plain */
function RawLine({ line, n, inHead }: { line: string; n: number; inHead: boolean }) {
  const idx = line.indexOf(':')
  const isHeader = inHead && idx > 0 && !line.startsWith(' ')
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
            { icon: 'copy', label: `Copy "${menu.h.name}: ${menu.h.value.slice(0, 24)}${menu.h.value.length > 24 ? '…' : ''}"`, onClick: async () => void (await copyToClipboard(`${menu.h.name}: ${menu.h.value}`, { label: 'header' })) },
            { icon: 'copy', label: 'Copy value', onClick: async () => void (await copyToClipboard(menu.h.value, { label: 'value' })) },
            { icon: 'copy', label: 'Copy all headers', separatorAfter: true, onClick: async () => void (await copyToClipboard(allText, { label: 'headers' })) },
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
