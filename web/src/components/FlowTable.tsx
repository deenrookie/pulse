// Virtualized, sortable traffic table.
// Renders only the visible window (+ overscan) as spacer rows keep the
// scrollbar honest — 5000 captured flows scroll at 60fps.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { copyToClipboard, bodyToText, formatSize, formatTime, getFlow, toCurl } from '../api'
import type { FlowMeta } from '../types'
import ContextMenu, { type MenuItem } from './ContextMenu'
import Icon from '../ui/Icon'
import Empty from '../ui/Empty'

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
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(600)
  const knownIds = useRef<Set<string>>(new Set())
  const [newIds, setNewIds] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ x: number; y: number; flow: FlowMeta } | null>(null)

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

  const copy = async (label: string, getText: () => Promise<string> | string) => {
    try {
      const text = await getText()
      if (!text) {
        notify(`${label} is empty`, 'err')
        return
      }
      if (await copyToClipboard(text)) notify(`${label} copied`)
      else notify('Clipboard unavailable in this browser', 'err')
    } catch (e) {
      notify(`Copy failed: ${(e as Error).message}`, 'err')
    }
  }

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
      icon: 'copy',
      label: 'Copy URL',
      separatorAfter: true,
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
    sort.key === key ? <span className="sort-ind"><Icon name={sort.dir === 1 ? 'arrowUp' : 'arrowDown'} size={10} /></span> : null

  const clickSort = (key: SortKey) => {
    if (sort.key === key) {
      onSort({ key, dir: sort.dir === 1 ? -1 : 1 })
    } else if (sort.key === null) {
      onSort({ key, dir: -1 })
    } else {
      onSort({ key, dir: -1 })
    }
  }

  const th = (key: SortKey, label: string, className: string) => (
    <th className={`${className} sortable`} onClick={() => clickSort(key)} title={`Sort by ${label.toLowerCase()}`}>
      {label}
      {sortIndicator(key)}
    </th>
  )

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
              <>
                Nothing matches the current filters — try Reset in the toolbar.
              </>
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
            <thead>
              <tr>
                <th className="col-id">#</th>
                {th('time', 'Time', 'col-time')}
                {th('method', 'Method', 'col-method')}
                {th('host', 'Host', 'col-host')}
                {th('path', 'Path', 'col-path')}
                {th('status', 'Status', 'col-status')}
                {th('type', 'Type', 'col-type')}
                {th('size', 'Size', 'col-size')}
                {th('dur', 'Took', 'col-dur')}
                <th className="col-src">Src</th>
                <th style={{ width: 34 }} />
              </tr>
            </thead>
            <tbody>
              {start > 0 && (
                <tr className="vspacer" style={{ height: start * ROW_H }}>
                  <td colSpan={11} />
                </tr>
              )}
              {visible.map((m) => (
                <tr
                  key={m.id}
                  style={{ height: ROW_H }}
                  className={`${selectedId === m.id ? 'selected' : ''} ${newIds.has(m.id) ? 'new-row' : ''}`}
                  onClick={() => onSelect(m.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    onSelect(m.id)
                    setMenu({ x: e.clientX, y: e.clientY, flow: m })
                  }}
                  title={`${m.url} — right-click for actions`}
                >
                  <td className="col-id">{m.id.replace('req-', '')}</td>
                  <td className="col-time">{formatTime(m.timestamp)}</td>
                  <td className={`col-method method-${m.method}`}>{m.method}</td>
                  <td className="col-host" title={m.host}>
                    {m.host}
                  </td>
                  <td className="col-path" title={m.path}>
                    {m.path}
                  </td>
                  <td className={`col-status ${statusClass(m.statusCode)}`}>{stateCell(m)}</td>
                  <td className="col-type" title={m.contentType}>
                    {shortType(m.contentType)}
                  </td>
                  <td className="col-size">{formatSize(m.respSize || m.reqSize)}</td>
                  <td className="col-dur">{m.durationMs > 0 ? `${m.durationMs}ms` : ''}</td>
                  <td className="col-src" title={m.source === 'repeater' ? 'Sent from Repeater' : ''}>
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
              ))}
              {end < flows.length && (
                <tr className="vspacer" style={{ height: (flows.length - end) * ROW_H }}>
                  <td colSpan={11} />
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.flow)} onClose={() => setMenu(null)} />}
    </div>
  )
}

function shortType(ct: string): string {
  if (!ct) return ''
  const [mime] = ct.split(';')
  return mime.trim().replace('application/', '').replace('text/', '')
}
