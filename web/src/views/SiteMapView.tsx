// Burp-style site map: every captured flow aggregated into a
// host → path → method tree. Selecting a leaf inspects the newest
// flow for that endpoint; right-click integrates with the workflow.
import { useEffect, useMemo, useState } from 'react'
import { getFlow } from '../api'
import { RequestInspector, ResponseInspector } from '../components/MessageViewer'
import Split from '../ui/Split'
import Icon from '../ui/Icon'
import Empty from '../ui/Empty'
import ContextMenu, { type MenuItem } from '../components/ContextMenu'
import type { PulseState } from '../state'
import type { Flow, FlowMeta } from '../types'

interface Leaf {
  method: string
  status: number
  count: number
  flowId: string // newest flow for this host+path+method
}
interface HostNode {
  host: string
  paths: Map<string, Leaf[]>
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
    let leaves = host.paths.get(f.path)
    if (!leaves) {
      leaves = []
      host.paths.set(f.path, leaves)
    }
    const existing = leaves.find((l) => l.method === f.method)
    if (existing) {
      existing.count++
      // keep the newest flow (list is arrival-ordered)
      existing.flowId = f.id
      existing.status = f.statusCode
    } else {
      leaves.push({ method: f.method, status: f.statusCode, count: 1, flowId: f.id })
    }
  }
  return [...hosts.values()].sort((a, b) => b.total - a.total)
}

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

  // deep link: #/sitemap?flow=<id> selects that flow's leaf
  useEffect(() => {
    const apply = () => {
      const id = viewParam('flow')
      if (id) {
        setSelectedId(id)
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

  const toggle = (host: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(host)) next.delete(host)
      else next.add(host)
      return next
    })

  const selectFlow = (id: string) => setSelectedId(id)

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
                {filteredTree.length} host{filteredTree.length === 1 ? '' : 's'} · {pulse.flows.length.toLocaleString()} flows
              </span>
              <div className="spacer" />
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
            <div className="panel-body">
              {filteredTree.length === 0 ? (
                <Empty icon="sitemap" title={search ? 'No matching endpoints' : 'Nothing mapped yet'}>
                  {search ? 'Try a different search.' : 'Traffic captured by the proxy appears here as a host → path tree.'}
                </Empty>
              ) : (
                filteredTree.map((h) => {
                  const open = expanded.has(h.host) || !!search
                  return (
                    <div key={h.host} className="tree-host">
                      <div className="tree-row host" onClick={() => toggle(h.host)}>
                        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
                        <Icon name="globe" size={13} />
                        <span className="name" title={h.host}>
                          {h.host}
                        </span>
                        <span className="grow" />
                        <span className="badge">{h.total}</span>
                      </div>
                      {open &&
                        [...h.paths.entries()].map(([path, leaves]) => (
                          <div key={path} className="tree-path">
                            <div className="tree-row path" title={path}>
                              <span className="name" title={path}>
                                {path}
                              </span>
                            </div>
                            {leaves.map((leaf) => (
                              <div
                                key={leaf.method}
                                className={`tree-row leaf ${selectedId === leaf.flowId ? 'selected' : ''}`}
                                onClick={() => selectFlow(leaf.flowId)}
                                onContextMenu={(e) => {
                                  e.preventDefault()
                                  selectFlow(leaf.flowId)
                                  const url = `http://${h.host}${path}`
                                  setMenu({ x: e.clientX, y: e.clientY, flowId: leaf.flowId, url })
                                }}
                                title="Click to inspect the newest flow · right-click for actions"
                              >
                                <span className={`method-${leaf.method} mono`} style={{ fontWeight: 600 }}>
                                  {leaf.method}
                                </span>
                                <span className={`mono ${statusClass(leaf.status)}`} style={{ fontWeight: 700 }}>
                                  {leaf.status === 0 ? '—' : leaf.status}
                                </span>
                                {leaf.count > 1 && <span className="count mono">×{leaf.count}</span>}
                              </div>
                            ))}
                          </div>
                        ))}
                    </div>
                  )
                })
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
