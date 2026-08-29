// Burp-style site map: every captured flow aggregated into a
// host → path → method tree. Built for scale:
//  - query strings are folded into the path node (counts cover variants)
//  - the visible tree is flattened and windowed — only on-screen rows
//    exist in the DOM, so tens of thousands of endpoints stay smooth
// Selecting a leaf inspects the newest flow; right-click integrates with
// the rest of the workflow.
import { useEffect, useMemo, useRef, useState } from 'react'
import { getFlow } from '../api'
import { RequestInspector, ResponseInspector } from '../components/MessageViewer'
import Split from '../ui/Split'
import Icon from '../ui/Icon'
import Empty from '../ui/Empty'
import ContextMenu, { type MenuItem } from '../components/ContextMenu'
import type { PulseState } from '../state'
import type { Flow, FlowMeta } from '../types'

const ROW_H = 28
const OVERSCAN = 12

interface Leaf {
  method: string
  status: number
  count: number
  flowId: string // newest flow for this host+path+method
}
interface HostNode {
  host: string
  paths: Map<string, Leaf[]> // key: clean path (no query string)
  total: number
}

function buildTree(flows: FlowMeta[]): HostNode[] {
  const hosts = new Map<string, HostNode>()
  for (const f of flows) {
    let host = hosts.get(f.host)
    if (!host) {
      host = { host: f.host, paths: new Map(), total: 0 }
      hosts.set(f.host, host)
    }
    host.total++
    const cleanPath = f.path.split('?')[0] || '/'
    let leaves = host.paths.get(cleanPath)
    if (!leaves) {
      leaves = []
      host.paths.set(cleanPath, leaves)
    }
    const existing = leaves.find((l) => l.method === f.method)
    if (existing) {
      existing.count++
      existing.flowId = f.id // list is arrival-ordered; keep the newest
      existing.status = f.statusCode
    } else {
      leaves.push({ method: f.method, status: f.statusCode, count: 1, flowId: f.id })
    }
  }
  return [...hosts.values()].sort((a, b) => b.total - a.total)
}

type Row =
  | { kind: 'host'; host: HostNode }
  | { kind: 'path'; host: HostNode; path: string }
  | { kind: 'leaf'; host: HostNode; path: string; leaf: Leaf }

function viewParam(name: string): string | null {
  const h = window.location.hash
  const q = h.includes('?') ? h.slice(h.indexOf('?') + 1) : ''
  return new URLSearchParams(q).get(name)
}

export default function SiteMapView({ pulse, goProxy }: { pulse: PulseState; goProxy: () => void }) {
  const tree = useMemo(() => buildTree(pulse.flows), [pulse.flows])
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [flow, setFlow] = useState<Flow | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; flowId: string; url: string } | null>(null)

  const wrapRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(500)
  const pendingScroll = useRef<boolean>(false)

  // deep link: #/sitemap?flow=<id> selects that flow's leaf and expands its
  // host; flows may not be loaded yet at mount, so the pending flag stays
  // set until the target row actually appears in the flattened tree
  useEffect(() => {
    const apply = () => {
      const id = viewParam('flow')
      if (id) {
        setSelectedId(id)
        pendingScroll.current = true // retried by the rows effect below
        const meta = pulse.flows.find((f) => f.id === id)
        if (meta) setExpanded((prev) => new Set(prev).add(meta.host))
      }
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // address bar mirrors selection
  useEffect(() => {
    const next = selectedId ? `#/sitemap?flow=${selectedId}` : '#/sitemap'
    if (window.location.hash !== next) window.history.replaceState(null, '', next)
  }, [selectedId])

  // full detail fetch on selection
  useEffect(() => {
    if (!selectedId) {
      setFlow(null)
      return
    }
    let alive = true
    getFlow(selectedId)
      .then((f) => alive && setFlow(f))
      .catch(() => alive && setFlow(null))
    return () => {
      alive = false
    }
  }, [selectedId])

  const filteredTree = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return tree
    return tree
      .map((h) => {
        const paths = [...h.paths.entries()].filter(
          ([path, leaves]) =>
            h.host.toLowerCase().includes(needle) ||
            path.toLowerCase().includes(needle) ||
            leaves.some((l) => l.method.toLowerCase().includes(needle)),
        )
        return { host: h.host, paths: new Map(paths), total: [...paths.values()].reduce((n, ls) => n + ls.length, 0) }
      })
      .filter((h) => h.paths.size > 0)
  }, [tree, search])

  // flatten the visible tree — the only rows that can possibly render
  const rows = useMemo(() => {
    const out: Row[] = []
    for (const h of filteredTree) {
      out.push({ kind: 'host', host: h })
      if (expanded.has(h.host) || !!search) {
        for (const [path, leaves] of h.paths) {
          out.push({ kind: 'path', host: h, path })
          for (const leaf of leaves) out.push({ kind: 'leaf', host: h, path, leaf })
        }
      }
    }
    return out
  }, [filteredTree, expanded, search])

  // scroll a freshly-selected row into view (deep link / cross-view jump);
  // keeps retrying while flows load — expanding the host and scrolling once
  // the target row becomes reachable in the flattened tree
  useEffect(() => {
    if (!selectedId || !pendingScroll.current) return
    const meta = pulse.flows.find((f) => f.id === selectedId)
    if (meta) setExpanded((prev) => (prev.has(meta.host) ? prev : new Set(prev).add(meta.host)))
    const idx = rows.findIndex((r) => r.kind === 'leaf' && r.leaf.flowId === selectedId)
    if (idx < 0) return // not built yet — leave pending for the next change
    pendingScroll.current = false
    if (wrapRef.current) wrapRef.current.scrollTop = Math.max(0, idx * ROW_H - viewH / 2)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, selectedId, viewH, pulse.flows])

  // visible window (clamped so shrinking lists never blank the viewport)
  const { start, end } = useMemo(() => {
    const rawStart = Math.floor(scrollTop / ROW_H) - OVERSCAN
    const s = Math.min(Math.max(0, rawStart), Math.max(0, rows.length - OVERSCAN))
    const count = Math.ceil(viewH / ROW_H) + OVERSCAN * 2
    return { start: s, end: Math.min(rows.length, s + count) }
  }, [scrollTop, viewH, rows.length])
  const visible = useMemo(() => rows.slice(start, end), [rows, start, end])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    setViewH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const toggle = (host: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(host)) next.delete(host)
      else next.add(host)
      return next
    })

  const collapseAll = () => setExpanded(new Set())
  const expandAll = () => {
    const next = new Set<string>()
    for (const h of filteredTree) next.add(h.host)
    setExpanded(next)
  }

  const leafMenu = (flowId: string, url: string): MenuItem[] => [
    {
      icon: 'send',
      label: 'Send to Repeater',
      onClick: () => void pulse.sendToRepeater(flowId),
    },
    {
      icon: 'waves',
      label: 'Open in Live Traffic',
      separatorAfter: true,
      onClick: () => {
        window.history.replaceState(null, '', `#/proxy?flow=${flowId}`)
        goProxy()
      },
    },
    {
      icon: 'copy',
      label: 'Copy URL',
      onClick: async () => {
        await navigator.clipboard?.writeText(url)
        pulse.notify('URL copied')
      },
    },
  ]

  const statusClass = (code: number) => (code === 0 ? 'status0' : `status${Math.floor(code / 100)}`)

  const renderRow = (row: Row) => {
    const key = `${row.kind}:${row.host.host}:${'path' in row ? row.path : ''}:${'leaf' in row ? row.leaf.method : ''}`
    if (row.kind === 'host') {
      const open = expanded.has(row.host.host)
      return (
        <div key={key} className="tree-row host" style={{ height: ROW_H }} onClick={() => toggle(row.host.host)}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
          <Icon name="globe" size={13} />
          <span className="name" title={row.host.host}>
            {row.host.host}
          </span>
          <span className="grow" />
          <span className="badge" title={`${row.host.total} flows`}>
            {row.host.total > 999 ? `${(row.host.total / 1000).toFixed(1)}k` : row.host.total}
          </span>
        </div>
      )
    }
    if (row.kind === 'path') {
      return (
        <div key={key} className="tree-row path" style={{ height: ROW_H }} title={row.path}>
          <span className="name" title={row.path}>
            {row.path}
          </span>
        </div>
      )
    }
    const sel = selectedId === row.leaf.flowId
    return (
      <div
        key={key}
        className={`tree-row leaf ${sel ? 'selected' : ''}`}
        style={{ height: ROW_H }}
        onClick={() => {
          pendingScroll.current = false
          setSelectedId(row.leaf.flowId)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setSelectedId(row.leaf.flowId)
          setMenu({ x: e.clientX, y: e.clientY, flowId: row.leaf.flowId, url: `http://${row.host.host}${row.path}` })
        }}
        title={`Newest of ${row.leaf.count} — click to inspect · right-click for actions`}
      >
        <span className={`method-${row.leaf.method} mono`} style={{ fontWeight: 600 }}>
          {row.leaf.method}
        </span>
        <span className={`mono ${statusClass(row.leaf.status)}`} style={{ fontWeight: 700 }}>
          {row.leaf.status === 0 ? '—' : row.leaf.status}
        </span>
        {row.leaf.count > 1 && <span className="count mono">×{row.leaf.count}</span>}
      </div>
    )
  }

  const endpointCount = useMemo(() => rows.filter((r) => r.kind === 'leaf').length, [rows])

  return (
    <div className="view padded row">
      <Split
        dir="h"
        storageKey="pulse.split.sitemap"
        initial={0.38}
        min={0.15}
        max={0.7}
        a={
          <div className="panel" style={{ flex: 1 }}>
            <div className="panel-head">
              <span className="title">Site map</span>
              <span className="meta">
                {filteredTree.length} host{filteredTree.length === 1 ? '' : 's'} ·{' '}
                {endpointCount.toLocaleString()} endpoint{endpointCount === 1 ? '' : 's'}
              </span>
              <div className="spacer" />
              <button className="btn ghost sm icon-btn" title="Expand all hosts" onClick={expandAll}>
                <Icon name="plus" size={13} />
              </button>
              <button className="btn ghost sm icon-btn" title="Collapse all" onClick={collapseAll}>
                <Icon name="minus" size={13} />
              </button>
            </div>
            <div className="side-search">
              <div className="search-box" style={{ display: 'flex', flex: 1 }}>
                <Icon name="search" size={12} />
                <input
                  className="input"
                  style={{ width: '100%', paddingLeft: 26, paddingRight: 26, fontSize: 12 }}
                  placeholder="Filter hosts & paths…"
                  value={search}
                  spellCheck={false}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button className="clear-btn" title="Clear filter" onClick={() => setSearch('')}>
                    <Icon name="x" size={11} />
                  </button>
                )}
              </div>
            </div>
            <div className="tree-wrap" ref={wrapRef} onScroll={() => wrapRef.current && setScrollTop(wrapRef.current.scrollTop)}>
              {filteredTree.length === 0 ? (
                <Empty icon="sitemap" title={search ? 'No matching endpoints' : 'Nothing mapped yet'}>
                  {search ? 'Try a different search.' : 'Traffic captured by the proxy appears here as a host → path tree.'}
                </Empty>
              ) : (
                <>
                  {start > 0 && <div style={{ height: start * ROW_H }} />}
                  {visible.map(renderRow)}
                  {end < rows.length && <div style={{ height: (rows.length - end) * ROW_H }} />}
                </>
              )}
            </div>
          </div>
        }
        b={
          <div className="panel" style={{ flex: 1 }}>
            <div className="panel-head">
              {flow ? (
                <>
                  <button className="btn sm" title="Copy this request into a new Repeater tab" onClick={() => void pulse.sendToRepeater(flow.id)}>
                    <Icon name="send" size={13} />
                    Send to Repeater
                  </button>
                  <span className={`method-${flow.request.method} mono`} style={{ fontWeight: 700, fontSize: 12 }}>
                    {flow.request.method}
                  </span>
                  <span className="meta" title={flow.request.url}>
                    {flow.request.url}
                  </span>
                </>
              ) : (
                <span className="title">Inspector</span>
              )}
              <div className="spacer" />
              {flow?.response && (
                <button
                  className="btn ghost sm icon-btn"
                  title="Open the response in a browser tab"
                  onClick={() => window.open(`/api/flows/${flow.id}/render`, '_blank')}
                >
                  <Icon name="external" size={13} />
                </button>
              )}
            </div>
            {flow ? (
              <Split
                dir="h"
                storageKey="pulse.split.sitemap-inspector"
                initial={0.5}
                a={<RequestInspector req={flow.request} />}
                b={<ResponseInspector resp={flow.response} error={flow.error} flowId={flow.id} />}
              />
            ) : (
              <Empty icon="sitemap" title="Pick an endpoint">
                Expand a host and click a method row to inspect
                <br />
                the newest request/response captured for it.
              </Empty>
            )}
          </div>
        }
      />
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={leafMenu(menu.flowId, menu.url)} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
