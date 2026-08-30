// Burp-style site map workspace: three resizable columns —
//   tree (host → path) | request list (one row per captured flow) |
//   inspector (request above, response below)
// All columns are windowed where lists can grow; every divider is
// draggable. Query strings fold into the tree's path node but stay
// visible per-record in the middle list.
import { useEffect, useMemo, useRef, useState } from 'react'
import { getFlow, formatSize, formatTime, createRepeaterTab } from '../api'
import { rawToRequest, requestToRaw } from '../components/RawEditor'
import { RequestInspector, ResponseInspector } from '../components/MessageViewer'
import Split from '../ui/Split'
import Icon from '../ui/Icon'
import Empty from '../ui/Empty'
import ContextMenu, { type MenuItem } from '../components/ContextMenu'
import type { PulseState } from '../state'
import type { Flow, FlowMeta } from '../types'

const ROW_H = 28
const OVERSCAN = 12

interface PathNode {
  methods: Set<string>
  count: number
  newestId: string
  newestStatus: number
}
interface HostNode {
  host: string
  paths: Map<string, PathNode> // key: clean path (no query string)
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
    let node = host.paths.get(cleanPath)
    if (!node) {
      node = { methods: new Set(), count: 0, newestId: f.id, newestStatus: f.statusCode }
      host.paths.set(cleanPath, node)
    }
    node.count++
    node.methods.add(f.method)
    node.newestId = f.id // arrival order → keep the newest
    node.newestStatus = f.statusCode
  }
  return [...hosts.values()].sort((a, b) => b.total - a.total)
}

interface TreeSel {
  host: string
  path?: string // clean path (no query)
  method?: string
}

function viewParam(name: string): string | null {
  const h = window.location.hash
  const q = h.includes('?') ? h.slice(h.indexOf('?') + 1) : ''
  return new URLSearchParams(q).get(name)
}

function windowRange(scrollTop: number, viewH: number, count: number) {
  const rawStart = Math.floor(scrollTop / ROW_H) - OVERSCAN
  const start = Math.min(Math.max(0, rawStart), Math.max(0, count - OVERSCAN))
  const n = Math.ceil(viewH / ROW_H) + OVERSCAN * 2
  return { start, end: Math.min(count, start + n) }
}

export default function SiteMapView({ pulse, goProxy }: { pulse: PulseState; goProxy: () => void }) {
  const tree = useMemo(() => buildTree(pulse.flows), [pulse.flows])
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [treeSel, setTreeSel] = useState<TreeSel | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [flow, setFlow] = useState<Flow | null>(null)
  const [rawEdit, setRawEdit] = useState<{ id: string; text: string } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; flowId: string; url: string } | null>(null)
  const pendingScroll = useRef(false)

  // ---- tree (flattened + windowed) ----
  const treeWin = useRef<HTMLDivElement>(null)
  const [treeScroll, setTreeScroll] = useState(0)
  const [treeViewH, setTreeViewH] = useState(400)

  const filteredTree = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return tree
    return tree
      .map((h) => {
        const paths = [...h.paths.entries()].filter(
          ([path, node]) =>
            h.host.toLowerCase().includes(needle) ||
            path.toLowerCase().includes(needle) ||
            [...node.methods].some((mth) => mth.toLowerCase().includes(needle)),
        )
        const nodes = paths.map(([, node]) => node)
        return { host: h.host, paths: new Map(paths), total: nodes.reduce((n, x) => n + x.count, 0) }
      })
      .filter((h) => h.paths.size > 0)
  }, [tree, search])

  const treeRows = useMemo(() => {
    const out: { kind: 'host' | 'path'; host: HostNode; path?: string }[] = []
    for (const h of filteredTree) {
      out.push({ kind: 'host', host: h })
      if (expanded.has(h.host) || !!search) {
        for (const path of h.paths.keys()) out.push({ kind: 'path', host: h, path })
      }
    }
    return out
  }, [filteredTree, expanded, search])

  const treeRange = windowRange(treeScroll, treeViewH, treeRows.length)
  const treeVisible = treeRows.slice(treeRange.start, treeRange.end)

  // pinned host bar: while a host's children scroll under the top edge,
  // keep that host visible (and collapsible) — the classic tree behavior
  const pinnedHost = (() => {
    const topIndex = Math.min(treeRows.length - 1, Math.max(0, Math.floor(treeScroll / ROW_H)))
    const topRow = treeRows[topIndex]
    return topRow && topRow.kind === 'path' ? topRow.host : null
  })()

  // ---- request list for the selected tree node (windowed) ----
  const listWin = useRef<HTMLDivElement>(null)
  const [listScroll, setListScroll] = useState(0)
  const [listViewH, setListViewH] = useState(400)

  const listFlows = useMemo(() => {
    if (!treeSel) return []
    return pulse.flows
      .filter((f) => {
        if (f.host !== treeSel.host) return false
        if (treeSel.path !== undefined && f.path.split('?')[0] !== treeSel.path) return false
        if (treeSel.method !== undefined && f.method !== treeSel.method) return false
        return true
      })
      .slice()
      .reverse() // newest first
  }, [pulse.flows, treeSel])

  const listRange = windowRange(listScroll, listViewH, listFlows.length)
  const listVisible = listFlows.slice(listRange.start, listRange.end)

  useEffect(() => {
    const els = [treeWin.current, listWin.current]
    const ros = els.map((el) => {
      if (!el) return null
      const ro = new ResizeObserver(() => {
        setTreeViewH(treeWin.current?.clientHeight ?? 400)
        setListViewH(listWin.current?.clientHeight ?? 400)
      })
      ro.observe(el)
      return ro
    })
    setTreeViewH(treeWin.current?.clientHeight ?? 400)
    setListViewH(listWin.current?.clientHeight ?? 400)
    return () => ros.forEach((ro) => ro?.disconnect())
  }, [])

  // deep link: #/sitemap?flow=<id> — retries until flows make it reachable
  useEffect(() => {
    const apply = () => {
      const id = viewParam('flow')
      if (id) {
        setSelectedId(id)
        pendingScroll.current = true
      }
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [])

  // address bar mirrors selection
  useEffect(() => {
    const next = selectedId ? `#/sitemap?flow=${selectedId}` : '#/sitemap'
    if (window.location.hash !== next) window.history.replaceState(null, '', next)
  }, [selectedId])

  // resolve pending deep link: expand host, focus tree, load inspector
  useEffect(() => {
    if (!selectedId || !pendingScroll.current) return
    const meta = pulse.flows.find((f) => f.id === selectedId)
    if (meta) {
      setExpanded((prev) => (prev.has(meta.host) ? prev : new Set(prev).add(meta.host)))
      setTreeSel({ host: meta.host, path: meta.path.split('?')[0] || '/' })
    }
    if (meta && treeWin.current) {
      const idx = treeRows.findIndex((r) => r.kind === 'path' && r.host.host === meta.host && r.path === meta.path.split('?')[0])
      if (idx >= 0) {
        pendingScroll.current = false
        treeWin.current.scrollTop = Math.max(0, idx * ROW_H - treeViewH / 2)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulse.flows, treeRows, selectedId, treeViewH])

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

  const toggle = (host: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(host)) next.delete(host)
      else next.add(host)
      return next
    })

  const collapseAll = () => {
    setExpanded(new Set())
    setTreeSel(null)
  }
  const expandAll = () => setExpanded(new Set(filteredTree.map((h) => h.host)))

  const selectTreeNode = (host: string, path?: string, method?: string) => {
    setTreeSel({ host, path, method })
    // clicking a node also loads its newest flow, Burp-style
    const pool = pulse.flows.filter((f) => {
      if (f.host !== host) return false
      if (path !== undefined && f.path.split('?')[0] !== path) return false
      if (method !== undefined && f.method !== method) return false
      return true
    })
    pendingScroll.current = false
    setSelectedId(pool.length > 0 ? pool[pool.length - 1].id : null)
  }

  const rowMenu = (flowId: string, url: string): MenuItem[] => [
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

  const editedRaw = flow && rawEdit && rawEdit.id === flow.id ? rawEdit.text : null

  const sendSelected = async () => {
    if (!flow) return
    if (editedRaw !== null) {
      const parsed = rawToRequest(editedRaw, flow.request.url)
      if ('error' in parsed) return
      try {
        await createRepeaterTab({ request: parsed })
        try {
          localStorage.setItem('pulse.repeater.jumpNewest', '1')
        } catch { /* ignore */ }
      } catch { /* notify-less best effort */ }
      return
    }
    void pulse.sendToRepeater(flow.id)
  }

  useEffect(() => {
    const onSend = () => void sendSelected()
    window.addEventListener('pulse:send-to-repeater', onSend)
    return () => window.removeEventListener('pulse:send-to-repeater', onSend)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, editedRaw])

  const statusClass = (code: number) => (code === 0 ? 'status0' : `status${Math.floor(code / 100)}`)

  return (
    <div className="view padded row">
      <Split
        dir="h"
        storageKey="pulse.split.sitemap"
        initial={0.26}
        min={0.1}
        max={0.6}
        a={
          <div className="panel" style={{ flex: 1 }}>
            <div className="panel-head">
              <span className="title">Site map</span>
              <span className="meta">{filteredTree.length} hosts</span>
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
            <div className="tree-col">
            {pinnedHost && (
              <div
                className="tree-row host pinned"
                style={{ height: ROW_H }}
                onClick={() => toggle(pinnedHost.host)}
                title={`${pinnedHost.host} — click to collapse`}
              >
                <Icon name="chevronDown" size={12} />
                <Icon name="globe" size={13} />
                <span className="name" title={pinnedHost.host}>
                  {pinnedHost.host}
                </span>
                <span className="grow" />
                <span className="badge" title={`${pinnedHost.total} flows`}>
                  {pinnedHost.total > 999 ? `${(pinnedHost.total / 1000).toFixed(1)}k` : pinnedHost.total}
                </span>
              </div>
            )}
            <div
              className="tree-wrap"
              ref={treeWin}
              onScroll={() => treeWin.current && setTreeScroll(treeWin.current.scrollTop)}
            >
              {filteredTree.length === 0 ? (
                <Empty icon="sitemap" title={search ? 'No matching endpoints' : 'Nothing mapped yet'}>
                  {search ? 'Try a different search.' : 'Traffic captured by the proxy appears here as a host → path tree.'}
                </Empty>
              ) : (
                <>
                  {treeRange.start > 0 && <div style={{ height: treeRange.start * ROW_H }} />}
                  {treeVisible.map((row) => {
                    if (row.kind === 'host') {
                      const open = expanded.has(row.host.host)
                      const active = treeSel?.host === row.host.host
                      return (
                        <div
                          key={`h:${row.host.host}`}
                          className={`tree-row host ${active ? 'selected' : ''}`}
                          style={{ height: ROW_H }}
                          onClick={() => selectTreeNode(row.host.host)}
                          title={`${row.host.host} — click to list its flows · double-click to expand`}
                          onDoubleClick={() => toggle(row.host.host)}
                        >
                          <span
                            onClick={(e) => {
                              e.stopPropagation()
                              toggle(row.host.host)
                            }}
                            style={{ display: 'flex' }}
                          >
                            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
                          </span>
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
                    const node = row.host.paths.get(row.path!)!
                    const active = treeSel?.host === row.host.host && treeSel.path === row.path && !treeSel.method
                    return (
                      <div
                        key={`p:${row.host.host}:${row.path}`}
                        className={`tree-row path ${active ? 'selected' : ''}`}
                        style={{ height: ROW_H, paddingLeft: 40, cursor: 'pointer' }}
                        onClick={() => selectTreeNode(row.host.host, row.path)}
                        title={`${row.path} — ${node.count} flow${node.count > 1 ? 's' : ''} · click to list`}
                      >
                        <span className="name" title={row.path}>
                          {row.path}
                        </span>
                        <span className="grow" />
                        <span className="count mono">
                          {[...node.methods].join('·')} ×{node.count}
                        </span>
                      </div>
                    )
                  })}
                  {treeRange.end < treeRows.length && <div style={{ height: (treeRows.length - treeRange.end) * ROW_H }} />}
                </>
              )}
            </div>
            </div>
          </div>
        }
        b={
          <Split
            dir="h"
            storageKey="pulse.split.sitelist"
            initial={0.34}
            min={0.15}
            max={0.7}
            a={
              <div className="panel" style={{ flex: 1 }}>
                <div className="panel-head">
                  <span className="title">Requests</span>
                  {treeSel && (
                    <span className="meta" title={`${treeSel.host}${treeSel.path ?? ''}`}>
                      {treeSel.host}
                      {treeSel.path}
                      {treeSel.method ? ` · ${treeSel.method}` : ''}
                    </span>
                  )}
                  <div className="spacer" />
                  <span className="meta">{listFlows.length.toLocaleString()} rows</span>
                </div>
                <div
                  className="tree-wrap"
                  ref={listWin}
                  onScroll={() => listWin.current && setListScroll(listWin.current.scrollTop)}
                >
                  {!treeSel ? (
                    <Empty icon="waves" title="Pick a site">
                      Select a host or path in the tree — every captured request for it lists here, one row each.
                    </Empty>
                  ) : listFlows.length === 0 ? (
                    <Empty icon="search" title="No requests" />
                  ) : (
                    <>
                      {listRange.start > 0 && <div style={{ height: listRange.start * ROW_H }} />}
                      {listVisible.map((m) => (
                        <div
                          key={m.id}
                          className={`tree-row req ${selectedId === m.id ? 'selected' : ''}`}
                          style={{ height: ROW_H }}
                          onClick={() => setSelectedId(m.id)}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            setSelectedId(m.id)
                            setMenu({ x: e.clientX, y: e.clientY, flowId: m.id, url: m.url })
                          }}
                          title={`${m.url} — click to inspect · right-click for actions`}
                        >
                          <span className={`method-${m.method} mono`} style={{ fontWeight: 600, flex: 'none' }}>
                            {m.method}
                          </span>
                          <span className={`mono ${statusClass(m.statusCode)}`} style={{ fontWeight: 700, flex: 'none' }}>
                            {m.statusCode === 0 ? '—' : m.statusCode}
                          </span>
                          <span className="name mono" title={m.path}>
                            {m.path}
                          </span>
                          <span className="grow" />
                          <span className="count mono" title={m.timestamp}>
                            {formatTime(m.timestamp)}
                          </span>
                          <span className="count mono">{formatSize(m.respSize || m.reqSize)}</span>
                        </div>
                      ))}
                      {listRange.end < listFlows.length && <div style={{ height: (listFlows.length - listRange.end) * ROW_H }} />}
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
                    dir="v"
                    storageKey="pulse.split.sitemap-inspector"
                    initial={0.5}
                    a={<RequestInspector req={flow.request} flowId={flow.id} raw={editedRaw ?? requestToRaw(flow.request)} onRawChange={(text) => flow && setRawEdit({ id: flow.id, text })} />}
                    b={<ResponseInspector resp={flow.response} error={flow.error} flowId={flow.id} ws={flow.ws} />}
                  />
                ) : (
                  <Empty icon="sitemap" title="Pick a request">
                    Click a row in the request list to inspect
                    <br />
                    its request and response.
                  </Empty>
                )}
              </div>
            }
          />
        }
      />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={rowMenu(menu.flowId, menu.url)} onClose={() => setMenu(null)} />}
    </div>
  )
}
