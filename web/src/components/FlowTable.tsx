// Virtualized, sortable, column-resizable traffic table.
// Renders only the visible window (+ overscan) as spacer rows keep the
// scrollbar honest — 5000 captured flows scroll at 60fps. Column widths
// are user-adjustable via header grips and persisted per browser.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { copyToClipboard, bodyToText, formatSize, formatTime, getFlow, toCurl } from '../api'
import type { FlowMeta } from '../types'
import ContextMenu, { type MenuItem } from './ContextMenu'
import Icon from '../ui/Icon'
import Empty from '../ui/Empty'
import { colorTriplet } from '../ui/palette'

export type SortKey = 'time' | 'method' | 'host' | 'path' | 'status' | 'size' | 'dur' | 'type'

export interface SortSpec {
  key: SortKey | null
  dir: 1 | -1
}

const ROW_H = 28
const OVERSCAN = 10

interface Props {
  flows: FlowMeta[]
  selectedId: string | null
  sort: SortSpec
  onSort: (s: SortSpec) => void
  follow: boolean
  onFollowChange: (v: boolean) => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onSendToRepeater: (id: string) => Promise<boolean>
  notify: (text: string, kind?: 'ok' | 'err') => void
  proxyAddr?: string
  /** true when a filter is active and 0 results is therefore a filter outcome */
  filtered?: boolean
  /** returns a marker color (hex) when a highlight rule matches, else null */
  highlightOf?: (m: FlowMeta) => string | null
}

// fixed-pixel columns; `path` flexes to fill the remainder
type ColKey = 'id' | 'time' | 'method' | 'host' | 'status' | 'type' | 'size' | 'dur' | 'src'
const DEFAULT_W: Record<ColKey, number> = {
  id: 56,
  time: 84,
  method: 68,
  host: 240,
  status: 62,
  type: 92,
  size: 78,
  dur: 64,
  src: 56,
}
const WIDTHS_KEY = 'pulse.colw'

function loadWidths(): Record<ColKey, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? '{}')
    const out = { ...DEFAULT_W }
    for (const k of Object.keys(DEFAULT_W) as ColKey[]) {
      if (typeof raw[k] === 'number' && raw[k] >= 44 && raw[k] <= 720) out[k] = raw[k]
    }
    return out
  } catch {
    return { ...DEFAULT_W }
  }
}

function statusClass(code: number): string {
  if (code === 0) return 'status0'
  return `status${Math.floor(code / 100)}`
}

function stateCell(m: FlowMeta) {
  switch (m.state) {
    case 'pending':
      return <span className="state-chip state-pending">···</span>
    case 'intercepted':
      return <span className="state-chip state-held">HELD</span>
    case 'dropped':
      return <span className="state-chip state-drop">DROP</span>
    case 'error':
      return <span className="state-chip state-err">ERR</span>
    default:
      return m.statusCode
  }
}

export default function FlowTable({
  flows,
  selectedId,
  sort,
  onSort,
  follow,
  onFollowChange,
  onSelect,
  onDelete,
  onSendToRepeater,
  notify,
  proxyAddr,
  filtered,
  highlightOf,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(600)
  const knownIds = useRef<Set<string>>(new Set())
  const [newIds, setNewIds] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ x: number; y: number; flow: FlowMeta } | null>(null)

  // ---- column widths (draggable) ----
  const [widths, setWidths] = useState<Record<ColKey, number>>(loadWidths)
  const [dragCol, setDragCol] = useState<ColKey | null>(null)
  const dragRef = useRef<{ key: ColKey; startX: number; startW: number } | null>(null)

  const gripDown = (key: ColKey) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { key, startX: e.clientX, startW: widths[key] }
    setDragCol(key)
  }
  const gripMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const next = Math.min(720, Math.max(44, d.startW + e.clientX - d.startX))
    setWidths((w) => ({ ...w, [d.key]: next }))
  }
  const gripUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    dragRef.current = null
    setDragCol(null)
    setWidths((w) => {
      try {
        localStorage.setItem(WIDTHS_KEY, JSON.stringify(w))
      } catch {
        /* ignore */
      }
      return w
    })
  }

  // visible window — clamp start so a shrinking list (filtering, deletes)
  // can never leave the scrollport past the last row
  const { start, end } = useMemo(() => {
    const rawStart = Math.floor(scrollTop / ROW_H) - OVERSCAN
    const start = Math.min(Math.max(0, rawStart), Math.max(0, flows.length - OVERSCAN))
    const count = Math.ceil(viewH / ROW_H) + OVERSCAN * 2
    return { start, end: Math.min(flows.length, start + count) }
  }, [scrollTop, viewH, flows.length])
  const visible = useMemo(() => flows.slice(start, end), [flows, start, end])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    setViewH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  // flag freshly arrived rows for the flash animation
  useEffect(() => {
    const fresh = new Set<string>()
    for (const f of flows) {
      if (!knownIds.current.has(f.id)) {
        fresh.add(f.id)
        knownIds.current.add(f.id)
      }
    }
    if (fresh.size > 0 && fresh.size <= 12) {
      setNewIds(fresh)
      const t = window.setTimeout(() => setNewIds(new Set()), 600)
      return () => window.clearTimeout(t)
    }
  }, [flows])

  // auto-scroll to newest while "follow" is on (arrival order or time-asc sort)
  const followsNewest = sort.key === null || (sort.key === 'time' && sort.dir === 1)
  useLayoutEffect(() => {
    if (follow && followsNewest && wrapRef.current) {
      wrapRef.current.scrollTop = wrapRef.current.scrollHeight
    }
  }, [flows.length, follow, followsNewest])

  const onScroll = () => {
    const el = wrapRef.current
    if (el) setScrollTop(el.scrollTop)
  }

  const toTop = () => {
    if (wrapRef.current) wrapRef.current.scrollTop = 0
  }

  const copy = async (label: string, getText: () => Promise<string> | string) => {
    try {
      const text = await getText()
      if (!text) {
        notify(`${label} is empty`, 'err')
        return
      }
      await copyToClipboard(text, { label })
    } catch (e) {
      notify(`Copy failed: ${(e as Error).message}`, 'err')
    }
  }

  const flowLink = (id: string) => `${location.origin}/#/proxy?flow=${id}`

  const menuItems = (m: FlowMeta): MenuItem[] => [
    {
      icon: 'send',
      label: 'Send to Repeater',
      onClick: () => void onSendToRepeater(m.id),
    },
    {
      icon: 'external',
      label: 'Show response in browser',
      disabled: m.statusCode === 0,
      onClick: () => {
        window.open(`/api/flows/${m.id}/render`, '_blank')
      },
    },
    {
      icon: 'link',
      label: 'Copy link to this flow',
      separatorAfter: true,
      onClick: () => copy('Link', () => flowLink(m.id)),
    },
    {
      icon: 'copy',
      label: 'Copy URL',
      onClick: () => copy('URL', () => m.url),
    },
    {
      icon: 'terminal',
      label: 'Copy as cURL',
      onClick: async () => {
        const fl = await getFlow(m.id)
        await copy('cURL command', () => toCurl(fl))
      },
    },
    {
      icon: 'copy',
      label: 'Copy request body',
      onClick: async () => {
        const fl = await getFlow(m.id)
        await copy('Request body', () => bodyToText(fl.request.body))
      },
    },
    {
      icon: 'copy',
      label: 'Copy response body',
      disabled: m.statusCode === 0,
      onClick: async () => {
        const fl = await getFlow(m.id)
        await copy('Response body', () => bodyToText(fl.response?.body ?? null))
      },
    },
    {
      icon: 'trash',
      label: 'Delete flow',
      danger: true,
      separatorAfter: true,
      onClick: () => onDelete(m.id),
    },
  ]

  const sortIndicator = (key: SortKey) =>
    sort.key === key ? (
      <span className="sort-ind">
        <Icon name={sort.dir === 1 ? 'arrowUp' : 'arrowDown'} size={10} />
      </span>
    ) : null

  const clickSort = (key: SortKey) => {
    if (sort.key === key) {
      onSort({ key, dir: sort.dir === 1 ? -1 : 1 })
    } else {
      onSort({ key, dir: -1 })
    }
  }

  const th = (key: SortKey, label: string) => (
    <th className="sortable" style={{ width: widths[key as ColKey] }} onClick={() => clickSort(key)} title={`Sort by ${label.toLowerCase()}`}>
      {label}
      {sortIndicator(key)}
      <span
        className={`col-grip ${dragCol === key ? 'dragging' : ''}`}
        onPointerDown={gripDown(key as ColKey)}
        onPointerMove={gripMove}
        onPointerUp={gripUp}
        title="Drag to resize"
      />
    </th>
  )

  const hlOf = (m: FlowMeta) => highlightOf?.(m) ?? null

  const rowStyle = (m: FlowMeta): CSSProperties | undefined => {
    const hl = hlOf(m)
    if (!hl) return undefined
    const t = colorTriplet(hl)
    return { '--hl-bar': hl, '--hl-bg': `rgb(${t} / 0.09)`, '--hl-hover': `rgb(${t} / 0.16)` } as CSSProperties
  }

  return (
    <div className="panel" style={{ flex: 1 }}>
      <div className="panel-head">
        <span className="title">Traffic</span>
        <span className="meta">{flows.length.toLocaleString()} shown</span>
        <div className="spacer" />
        <label className="switch" title="Automatically scroll to the newest request">
          <input type="checkbox" checked={follow} onChange={(e) => onFollowChange(e.target.checked)} />
          <span className="track" />
          Follow
        </label>
      </div>
      <div className="table-wrap" ref={wrapRef} onScroll={onScroll}>
        {flows.length === 0 ? (
          <Empty icon={filtered ? 'search' : 'waves'} title={filtered ? 'No matching traffic' : 'No traffic captured yet'}>
            {filtered ? (
              <>Nothing matches the current filters — try Reset in the toolbar.</>
            ) : (
              <>
                Point your browser proxy at <b>{proxyAddr ?? '127.0.0.1:8080'}</b>
                <br />
                then browse any site — requests appear here in real time.
              </>
            )}
          </Empty>
        ) : (
          <table className="flows">
            <colgroup>
              <col style={{ width: widths.id }} />
              <col style={{ width: widths.time }} />
              <col style={{ width: widths.method }} />
              <col style={{ width: widths.host }} />
              <col />
              <col style={{ width: widths.status }} />
              <col style={{ width: widths.type }} />
              <col style={{ width: widths.size }} />
              <col style={{ width: widths.dur }} />
              <col style={{ width: widths.src }} />
              <col style={{ width: 34 }} />
            </colgroup>
            <thead>
              <tr>
                <th className="col-id" title="Flow id">#</th>
                {th('time', 'Time')}
                {th('method', 'Method')}
                {th('host', 'Host')}
                <th className="sortable" onClick={() => clickSort('path')} title="Sort by path">
                  Path
                  {sortIndicator('path')}
                </th>
                {th('status', 'Status')}
                {th('type', 'Type')}
                {th('size', 'Size')}
                {th('dur', 'Took')}
                <th className="col-src" title="Source">
                  Src
                </th>
                <th style={{ width: 34 }} />
              </tr>
            </thead>
            <tbody>
              {start > 0 && (
                <tr className="vspacer" style={{ height: start * ROW_H }}>
                  <td colSpan={11} />
                </tr>
              )}
              {visible.map((m) => {
                const hl = hlOf(m)
                return (
                  <tr
                    key={m.id}
                    style={{ height: ROW_H, ...rowStyle(m) }}
                    className={`${selectedId === m.id ? 'selected' : ''} ${newIds.has(m.id) ? 'new-row' : ''} ${hl ? 'hl' : ''}`}
                    onClick={() => onSelect(m.id)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      onSelect(m.id)
                      setMenu({ x: e.clientX, y: e.clientY, flow: m })
                    }}
                    title={`${m.url} — right-click for actions`}
                  >
                    <td className="col-id" title={m.id}>
                      {m.id.replace('req-', '')}
                    </td>
                    <td className="col-time" title={m.timestamp}>
                      {formatTime(m.timestamp)}
                    </td>
                    <td className={`col-method method-${m.method}`} title={m.method}>
                      {m.method}
                    </td>
                    <td className="col-host" title={m.host}>
                      {hl && <span className="hl-dot" style={{ background: hl }} />}
                      {m.host}
                    </td>
                    <td className="col-path" title={m.path}>
                      {m.path}
                    </td>
                    <td className={`col-status ${statusClass(m.statusCode)}`} title={m.state === 'complete' ? `HTTP ${m.statusCode}` : m.state}>
                      {stateCell(m)}
                    </td>
                    <td className="col-type" title={m.contentType}>
                      {shortType(m.contentType)}
                    </td>
                    <td className="col-size" title={`response ${formatSize(m.respSize)} · request ${formatSize(m.reqSize)}`}>
                      {formatSize(m.respSize || m.reqSize)}
                    </td>
                    <td className="col-dur" title={`${m.durationMs} ms`}>
                      {m.durationMs > 0 ? `${m.durationMs}ms` : ''}
                    </td>
                    <td className="col-src" title={m.source === 'repeater' ? 'Sent from Repeater' : 'Captured from the proxy'}>
                      {m.source === 'repeater' ? 'rptr' : ''}
                    </td>
                    <td>
                      <button
                        className="btn ghost sm icon-btn"
                        title="Delete row"
                        onClick={(e) => {
                          e.stopPropagation()
                          onDelete(m.id)
                        }}
                      >
                        <Icon name="x" size={12} />
                      </button>
                    </td>
                  </tr>
                )
              })}
              {end < flows.length && (
                <tr className="vspacer" style={{ height: (flows.length - end) * ROW_H }}>
                  <td colSpan={11} />
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      {scrollTop > 400 && (
        <button className="to-top" title="Back to top" onClick={toTop}>
          <Icon name="arrowUp" size={13} />
        </button>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.flow)} onClose={() => setMenu(null)} />}
    </div>
  )
}

function shortType(ct: string): string {
  if (!ct) return ''
  const [mime] = ct.split(';')
  return mime.trim().replace('application/', '').replace('text/', '')
}
