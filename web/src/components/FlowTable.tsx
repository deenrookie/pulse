import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { copyToClipboard, bodyToText, formatSize, formatTime, getFlow, toCurl } from '../api'
import type { FlowMeta } from '../types'
import ContextMenu, { type MenuItem } from './ContextMenu'

interface Props {
  flows: FlowMeta[]
  selectedId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onSendToRepeater: (id: string) => Promise<boolean>
  notify: (text: string, kind?: 'ok' | 'err') => void
}

function statusClass(code: number): string {
  if (code === 0) return 'status0'
  return `status${Math.floor(code / 100)}`
}

function stateLabel(m: FlowMeta): string {
  switch (m.state) {
    case 'pending':
      return '…'
    case 'intercepted':
      return 'HELD'
    case 'dropped':
      return 'DROP'
    case 'error':
      return 'ERR'
    default:
      return String(m.statusCode)
  }
}

export default function FlowTable({ flows, selectedId, onSelect, onDelete, onSendToRepeater, notify }: Props) {
  const [follow, setFollow] = useState(true)
  const wrapRef = useRef<HTMLDivElement>(null)
  const knownIds = useRef<Set<string>>(new Set())
  const [newIds, setNewIds] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ x: number; y: number; flow: FlowMeta } | null>(null)

  // flag freshly arrived rows for the flash animation
  useEffect(() => {
    const fresh = new Set<string>()
    for (const f of flows) {
      if (!knownIds.current.has(f.id)) {
        fresh.add(f.id)
        knownIds.current.add(f.id)
      }
    }
    if (fresh.size > 0) {
      setNewIds(fresh)
      const t = window.setTimeout(() => setNewIds(new Set()), 600)
      return () => window.clearTimeout(t)
    }
  }, [flows])

  // auto-scroll to newest when "follow" is on
  useLayoutEffect(() => {
    if (follow && wrapRef.current) {
      wrapRef.current.scrollTop = wrapRef.current.scrollHeight
    }
  }, [flows.length, follow])

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
      label: '⟳ Send to Repeater',
      onClick: () => void onSendToRepeater(m.id),
    },
    {
      label: '♷ Show response in browser',
      disabled: m.statusCode === 0,
      onClick: () => {
        window.open(`/api/flows/${m.id}/render`, '_blank')
      },
    },
    {
      label: 'Copy URL',
      separatorAfter: true,
      onClick: () => copy('URL', () => m.url),
    },
    {
      label: 'Copy as cURL',
      onClick: async () => {
        const fl = await getFlow(m.id)
        await copy('cURL command', () => toCurl(fl))
      },
    },
    {
      label: 'Copy request body',
      onClick: async () => {
        const fl = await getFlow(m.id)
        await copy('Request body', () => bodyToText(fl.request.body))
      },
    },
    {
      label: 'Copy response body',
      disabled: m.statusCode === 0,
      onClick: async () => {
        const fl = await getFlow(m.id)
        await copy('Response body', () => bodyToText(fl.response?.body ?? null))
      },
    },
    {
      label: '✕ Delete flow',
      danger: true,
      separatorAfter: false,
      onClick: () => onDelete(m.id),
    },
  ]

  return (
    <div className="panel" style={{ flex: 1 }}>
      <div className="toolbar">
        <span className="title" style={{ fontWeight: 600 }}>
          Traffic
        </span>
        <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--mono)' }}>{flows.length} rows</span>
        <div className="spacer" style={{ flex: 1 }} />
        <label className="switch" title="Automatically scroll to the newest request">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          <span className="track" />
          Follow
        </label>
      </div>
      <div className="flow-table-wrap" ref={wrapRef}>
        {flows.length === 0 ? (
          <div className="empty">
            <div className="big">🛰️</div>
            <div>
              No traffic captured yet.
              <br />
              Point your browser proxy at the address shown in the header, then browse any site.
            </div>
          </div>
        ) : (
          <table className="flows">
            <thead>
              <tr>
                <th className="col-id">#</th>
                <th className="col-time">Time</th>
                <th className="col-method">Method</th>
                <th className="col-host">Host</th>
                <th className="col-path">Path</th>
                <th className="col-status">Status</th>
                <th className="col-type">Type</th>
                <th className="col-size">Size</th>
                <th className="col-dur">Time</th>
                <th className="col-src">Src</th>
                <th style={{ width: 30 }} />
              </tr>
            </thead>
            <tbody>
              {flows.map((m) => (
                <tr
                  key={m.id}
                  className={`${selectedId === m.id ? 'selected' : ''} ${newIds.has(m.id) ? 'new-row' : ''}`}
                  onClick={() => onSelect(m.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
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
                  <td className={`col-status ${statusClass(m.statusCode)}`}>{stateLabel(m)}</td>
                  <td className="col-type" title={m.contentType}>
                    {shortType(m.contentType)}
                  </td>
                  <td className="col-size">{formatSize(m.respSize || m.reqSize)}</td>
                  <td className="col-dur">{m.durationMs > 0 ? `${m.durationMs}ms` : ''}</td>
                  <td className="col-src">{m.source === 'repeater' ? 'rptr' : ''}</td>
                  <td>
                    <button
                      className="btn ghost sm"
                      title="Delete row"
                      onClick={(e) => {
                        e.stopPropagation()
                        onDelete(m.id)
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.flow)} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}

function shortType(ct: string): string {
  if (!ct) return ''
  const [mime] = ct.split(';')
  return mime.trim().replace('application/', '').replace('text/', '')
}
