import { useEffect, useMemo, useRef, useState } from 'react'
import FlowTable, { type SortSpec } from '../components/FlowTable'
import { RequestInspector, ResponseInspector } from '../components/MessageViewer'
import Split from '../ui/Split'
import Empty from '../ui/Empty'
import Icon from '../ui/Icon'
import { confirm } from '../ui/Confirm'
import HighlightRules, { ruleMatches, type HighlightRule } from '../ui/HighlightRules'
import FilterDialog, { EMPTY_FILTER, filterActive, passesFilter, type FilterModel } from '../ui/FilterDialog'
import type { PulseState } from '../state'
import type { FlowMeta } from '../types'

const METHODS = ['ANY', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']
const STATUS_FILTERS: [string, string][] = [
  ['2', '2xx'],
  ['3', '3xx'],
  ['4', '4xx'],
  ['5', '5xx'],
  ['pending', 'pending'],
]
const STATIC_EXT = /\.(css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|mp4|webm)(\?|$)/i
const STATIC_TYPE = /^(image\/|font\/|text\/css|text\/javascript|application\/javascript|application\/x-font)/i
const HL_KEY = 'pulse.highlights'
const FILTER_KEY = 'pulse.filter'

function loadFilter(): FilterModel {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null')
    return raw ? { ...EMPTY_FILTER, ...raw } : { ...EMPTY_FILTER }
  } catch {
    return { ...EMPTY_FILTER }
  }
}

function loadRules(): HighlightRule[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HL_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((r) => r && r.match !== undefined) : []
  } catch {
    return []
  }
}

function isStatic(m: FlowMeta): boolean {
  if (m.contentType && STATIC_TYPE.test(m.contentType)) return true
  return STATIC_EXT.test(m.path)
}

function cmp(a: FlowMeta, b: FlowMeta, key: keyof FlowMeta, dir: 1 | -1): number {
  const va = a[key]
  const vb = b[key]
  let r = 0
  if (typeof va === 'number' && typeof vb === 'number') r = va - vb
  else r = String(va).localeCompare(String(vb))
  if (r === 0 && a.id !== b.id) r = a.id.localeCompare(b.id)
  return r * dir
}

/** view params from the address bar: #/proxy?flow=req-12 */
function viewParam(name: string): string | null {
  const h = window.location.hash
  const q = h.includes('?') ? h.slice(h.indexOf('?') + 1) : ''
  return new URLSearchParams(q).get(name)
}

export default function ProxyView({ pulse }: { pulse: PulseState }) {
  const [q, setQ] = useState('')
  const [statuses, setStatuses] = useState<Set<string>>(new Set())
  const [method, setMethod] = useState('ANY')
  const [hideStatic, setHideStatic] = useState(false)
  const [sort, setSort] = useState<SortSpec>({ key: null, dir: 1 })
  const [follow, setFollow] = useState(true)
  const [rules, setRules] = useState<HighlightRule[]>(loadRules)
  const [rulesPos, setRulesPos] = useState<{ x: number; y: number } | null>(null)
  const [filter, setFilter] = useState<FilterModel>(loadFilter)
  const [filterOpen, setFilterOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  // Ctrl+F lands here (App dispatches after switching views)
  useEffect(() => {
    const focus = () => searchRef.current?.focus()
    window.addEventListener('pulse:focus-filter', focus)
    return () => window.removeEventListener('pulse:focus-filter', focus)
  }, [])

  // deep link: #/proxy?flow=<id> selects that flow
  useEffect(() => {
    const apply = () => {
      const id = viewParam('flow')
      if (id) pulse.selectFlow(id)
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // address bar mirrors the selected flow (replaceState fires no hashchange)
  useEffect(() => {
    const base = '#/proxy'
    const next = pulse.selectedId ? `${base}?flow=${pulse.selectedId}` : base
    if (window.location.hash !== next) window.history.replaceState(null, '', next)
  }, [pulse.selectedId])

  const saveRules = (next: HighlightRule[]) => {
    setRules(next)
    try {
      localStorage.setItem(HL_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }

  const saveFilter = (next: FilterModel) => {
    setFilter(next)
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }

  const highlightOf = useMemo(() => {
    if (rules.length === 0) return undefined
    return (m: FlowMeta) => {
      const flat: Record<string, string> = {
        'request.url': m.url,
        'request.host': m.host,
        'request.path': m.path,
        'request.method': m.method,
        'request.status': '',
        'request.type': '',
        'response.url': '',
        'response.host': '',
        'response.path': '',
        'response.method': '',
        'response.status': String(m.statusCode),
        'response.type': m.contentType,
      }
      for (const r of rules) {
        if (ruleMatches(r, flat)) return r.color
      }
      return null
    }
  }, [rules])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let out = pulse.flows
    if (needle) {
      out = out.filter((m) => `${m.method} ${m.host} ${m.path} ${m.statusCode} ${m.state}`.toLowerCase().includes(needle))
    }
    if (method !== 'ANY') out = out.filter((m) => m.method === method)
    if (statuses.size > 0) {
      out = out.filter((m) => {
        if (m.state === 'pending' || m.state === 'intercepted') return statuses.has('pending')
        if (m.statusCode === 0) return statuses.has('pending')
        return statuses.has(String(Math.floor(m.statusCode / 100)))
      })
    }
    if (hideStatic) out = out.filter((m) => !isStatic(m))
    if (filterActive(filter)) {
      out = out.filter((m) =>
        passesFilter(
          filter,
          { host: m.host, path: m.path, url: m.url, method: m.method, type: m.contentType },
          m.statusCode,
          m.respSize || m.reqSize,
        ),
      )
    }
    if (sort.key) {
      const key: keyof FlowMeta =
        sort.key === 'status'
          ? 'statusCode'
          : sort.key === 'size'
            ? 'respSize'
            : sort.key === 'dur'
              ? 'durationMs'
              : sort.key === 'time'
                ? 'timestamp'
                : sort.key === 'type'
                  ? 'contentType'
                  : sort.key
      out = [...out].sort((a, b) => cmp(a, b, key, sort.dir))
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulse.flows, q, method, statuses, hideStatic, sort, filter])

  const toggleStatus = (s: string) => {
    setStatuses((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }

  const clearHistory = async () => {
    const ok = await confirm({
      title: 'Clear captured traffic?',
      message: `Deletes all ${pulse.total} recorded flows from local storage. This cannot be undone.`,
      confirmLabel: 'Clear history',
      danger: true,
    })
    if (ok) pulse.clearAllFlows()
  }

  const fl = pulse.selectedFlow
  const filtersActive = q.trim() !== '' || method !== 'ANY' || statuses.size > 0 || hideStatic || filterActive(filter)

  return (
    <div className="view padded">
      <Split
        dir="v"
        storageKey="pulse.split.proxy"
        initial={0.52}
        a={
          <div className="panel" style={{ flex: 1 }}>
            <div className="toolbar">
              <div className="search-box">
                <Icon name="search" size={13} />
                <input
                  ref={searchRef}
                  className="input"
                  placeholder="Filter traffic…"
                  value={q}
                  spellCheck={false}
                  onChange={(e) => setQ(e.target.value)}
                />
                <kbd className="hint">Ctrl F</kbd>
              </div>
              {STATUS_FILTERS.map(([id, label]) => (
                <button
                  key={id}
                  className={`tchip ${statuses.has(id) ? 'on' : ''}`}
                  onClick={() => toggleStatus(id)}
                >
                  {label}
                </button>
              ))}
              <select className="select" style={{ width: 92 }} value={method} onChange={(e) => setMethod(e.target.value)}>
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m === 'ANY' ? 'All methods' : m}
                  </option>
                ))}
              </select>
              <button
                className={`tchip ${hideStatic ? 'on' : ''}`}
                onClick={() => setHideStatic((v) => !v)}
                title="Hide images, styles, scripts and fonts"
              >
                <Icon name="filter" size={11} />
                Hide static
              </button>
              {filtersActive && (
                <button
                  className="tchip"
                  onClick={() => {
                    setQ('')
                    setMethod('ANY')
                    setStatuses(new Set())
                    setHideStatic(false)
                  }}
                >
                  <Icon name="x" size={11} />
                  Reset
                </button>
              )}
              <div className="spacer" style={{ flex: 1 }} />
              <button
                className={`btn sm ${filterActive(filter) ? 'primary' : ''}`}
                title="Display filter — methods, status, extensions, MIME, request/response match, size"
                onClick={() => setFilterOpen(true)}
              >
                <Icon name="filter" size={13} />
                Filter
                {filterActive(filter) && <span className="badge">on</span>}
              </button>
              <button
                className={`btn sm ${rules.length > 0 ? 'primary' : ''}`}
                title="Highlight rules — color-code matching flows"
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setRulesPos(rulesPos ? null : { x: r.right - 430, y: r.bottom + 6 })
                }}
              >
                <Icon name="bolt" size={13} />
                Highlights
                {rules.length > 0 && <span className="badge">{rules.length}</span>}
              </button>
              <span className="faint mono" style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }} title="Total recorded flows (including filtered-out)">
                {pulse.total.toLocaleString()} total
              </span>
              <button className="btn danger sm" onClick={clearHistory} disabled={pulse.total === 0}>
                <Icon name="trash" size={13} />
                Clear
              </button>
            </div>
            <FlowTable
              flows={filtered}
              selectedId={pulse.selectedId}
              sort={sort}
              onSort={setSort}
              follow={follow}
              onFollowChange={setFollow}
              onSelect={pulse.selectFlow}
              onDelete={pulse.removeFlow}
              onSendToRepeater={pulse.sendToRepeater}
              notify={pulse.notify}
              proxyAddr={pulse.status?.proxyAddr}
              filtered={filtersActive}
              highlightOf={highlightOf}
            />
          </div>
        }
        b={
          <div className="panel" style={{ flex: 1 }}>
            <div className="panel-head">
              {fl ? (
                <>
                  <button
                    className="btn sm"
                    disabled={!fl}
                    title="Copy this request into a new Repeater tab"
                    onClick={() => fl && pulse.sendToRepeater(fl.id)}
                  >
                    <Icon name="send" size={13} />
                    Send to Repeater
                  </button>
                  <span className={`method-${fl.request.method} mono`} style={{ fontWeight: 700, fontSize: 12 }}>
                    {fl.request.method}
                  </span>
                  <span className="meta" title={fl.request.url}>
                    {fl.request.url}
                  </span>
                </>
              ) : (
                <span className="title">Inspector</span>
              )}
              <div className="spacer" />
              {fl && (
                <button
                  className="btn ghost sm icon-btn"
                  title="Copy a link that opens this flow selected"
                  onClick={() => {
                    void navigator.clipboard?.writeText(`${location.origin}/#/proxy?flow=${fl.id}`).then(
                      () => pulse.notify('Link copied'),
                      () => pulse.notify('Clipboard unavailable', 'err'),
                    )
                  }}
                >
                  <Icon name="link" size={13} />
                </button>
              )}
              {fl?.response && (
                <button
                  className="btn ghost sm icon-btn"
                  title="Open the response in a browser tab"
                  onClick={() => window.open(`/api/flows/${fl.id}/render`, '_blank')}
                >
                  <Icon name="external" size={13} />
                </button>
              )}
            </div>
            {fl ? (
              <Split
                dir="h"
                storageKey="pulse.split.inspector"
                initial={0.5}
                a={<RequestInspector req={fl.request} />}
                b={<ResponseInspector resp={fl.response} error={fl.error} flowId={fl.id} />}
              />
            ) : (
              <Empty icon="eye" title="Nothing selected">
                Click a row to inspect its request and response.
              </Empty>
            )}
          </div>
        }
      />
      {filterOpen && <FilterDialog value={filter} onChange={saveFilter} onClose={() => setFilterOpen(false)} />}
      {rulesPos && (
        <HighlightRules
          rules={rules}
          onChange={saveRules}
          x={rulesPos.x}
          y={rulesPos.y}
          onClose={() => setRulesPos(null)}
        />
      )}
    </div>
  )
}
