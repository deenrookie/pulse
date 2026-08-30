import { useEffect, useMemo, useRef, useState } from 'react'
import { requestToRaw, rawToRequest } from '../components/RawEditor'
import { RequestInspector } from '../components/MessageViewer'
import * as api from '../api'
import Icon from '../ui/Icon'
import Empty from '../ui/Empty'
import ContextMenu, { type MenuItem } from '../components/ContextMenu'
import { copyToClipboard } from '../api'
import type { PulseState } from '../state'
import type { HttpRequest, PendingItem } from '../types'

const RULES_KEY = 'pulse.holdrules'

/** client-side hold rules: when non-empty, only matching requests are held;
    everything else is auto-forwarded the moment it arrives */
export interface HoldRule {
  id: string
  field: 'host' | 'path' | 'method' | 'url'
  mode: 'contains' | 'regex'
  match: string
}

function loadRules(): HoldRule[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RULES_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((r) => r && r.match !== undefined) : []
  } catch {
    return []
  }
}

function ruleMatchesUrl(r: HoldRule, method: string, url: string): boolean {
  if (!r.match) return false
  let value = url
  if (r.field === 'host') {
    const m = url.match(/^\w+:\/\/([^/?#]+)/)
    value = m ? m[1] : url
  } else if (r.field === 'path') {
    const i = url.indexOf('://')
    const rest = i >= 0 ? url.slice(i + 3) : url
    const j = rest.indexOf('/')
    value = j >= 0 ? rest.slice(j) : '/'
  } else if (r.field === 'method') {
    value = method
  }
  if (r.mode === 'regex') {
    try {
      return new RegExp(r.match, 'i').test(value)
    } catch {
      return false
    }
  }
  return value.toLowerCase().includes(r.match.toLowerCase())
}

// tiny inline rules popover (reuses .popover styles)
function HoldRules({
  rules,
  onChange,
  x,
  y,
  onClose,
}: {
  rules: HoldRule[]
  onChange: (r: HoldRule[]) => void
  x: number
  y: number
  onClose: () => void
}) {
  useEffect(() => {
    const onDoc = () => onClose()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDoc)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // focus the match input of the freshly added rule (runs after commit)
  const prevCount = useRef(rules.length)
  useEffect(() => {
    if (rules.length > prevCount.current) {
      const rows = document.querySelectorAll('.popover .rule-row')
      const last = rows[rows.length - 1]
      ;(last?.querySelector('input.mini') as HTMLInputElement | null)?.focus()
    }
    prevCount.current = rules.length
  }, [rules.length])

  const update = (id: string, patch: Partial<HoldRule>) => onChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)))

  const focusLastMatch = () => {
    requestAnimationFrame(() => {
      const rows = document.querySelectorAll('.popover .rule-row')
      const last = rows[rows.length - 1]
      const input = last?.querySelector('input.mini') as HTMLInputElement | null
      input?.focus()
    })
  }

  return (
    <div
      className="popover"
      style={{ left: Math.max(8, Math.min(x, window.innerWidth - 440)), top: Math.max(8, Math.min(y, window.innerHeight - 320)) }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <h4>
        <Icon name="sliders" size={14} />
        Hold rules
      </h4>
      <div className="sub">
        With no rules every request is held. With rules, only requests matching at least one rule pause here — the rest
        are auto-forwarded instantly. Needs the console to stay open.
      </div>
      <div className="rule-list">
        {rules.length === 0 && <div className="rule-empty">No rules — currently holding everything.</div>}
        {rules.map((r) => (
          <div key={r.id} className="rule-row" style={{ gridTemplateColumns: '118px 96px 26px' }}>
            <select className="mini" value={r.field} onChange={(e) => update(r.id, { field: e.target.value as HoldRule['field'] })}>
              <option value="host">host</option>
              <option value="path">path</option>
              <option value="url">url</option>
              <option value="method">method</option>
            </select>
            <select className="mini" value={r.mode} onChange={(e) => update(r.id, { mode: e.target.value as HoldRule['mode'] })}>
              <option value="contains">contains</option>
              <option value="regex">regex</option>
            </select>
            <button
              className="btn ghost sm icon-btn"
              title="Remove rule"
              onClick={() => onChange(rules.filter((x) => x.id !== r.id))}
            >
              <Icon name="x" size={12} />
            </button>
            <div className="match-line">
              <input
                className="mini"
                placeholder="match…"
                value={r.match}
                spellCheck={false}
                onChange={(e) => update(r.id, { match: e.target.value })}
              />
            </div>
          </div>
        ))}
      </div>
      <button
        className="btn sm"
        onClick={() => {
          onChange([...rules, { id: crypto.randomUUID(), field: 'host', mode: 'contains', match: '' }])
          focusLastMatch()
        }}
      >
        <Icon name="plus" size={13} />
        Add rule
      </button>
    </div>
  )
}

export default function InterceptView({ pulse }: { pulse: PulseState }) {
  const pending = pulse.intercept.pending
  const [selectedPending, setSelectedPending] = useState<string | null>(null)
  const [heldFull, setHeldFull] = useState<HttpRequest | null>(null)
  const [raw, setRaw] = useState<string | null>(null)

  // request-like view for the shared inspector: parse the edited raw when it
  // is valid, otherwise fall back to the held shape
  const reqView = useMemo(() => {
    if (!heldFull) return null
    if (raw === null) return heldFull
    const parsed = rawToRequest(raw, heldFull.url)
    if ('error' in parsed) return heldFull
    return { ...heldFull, method: parsed.method, url: parsed.url, httpVersion: parsed.httpVersion, headers: parsed.headers, body: parsed.body }
  }, [heldFull, raw])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [rules, setRules] = useState<HoldRule[]>(loadRules)
  const [rulesPos, setRulesPos] = useState<{ x: number; y: number } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; item: PendingItem } | null>(null)
  const autoForwarded = useRef<Set<string>>(new Set())

  const currentId = selectedPending ?? pending[0]?.id ?? null

  const saveRules = (next: HoldRule[]) => {
    setRules(next)
    autoForwarded.current.clear()
    try {
      localStorage.setItem(RULES_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }

  // auto-forward engine: non-matching held requests are released instantly
  useEffect(() => {
    if (rules.length === 0 || pending.length === 0) return
    for (const p of pending) {
      if (autoForwarded.current.has(p.id)) continue
      const matched = rules.some((r) => ruleMatchesUrl(r, p.method, p.url))
      if (!matched) {
        autoForwarded.current.add(p.id)
        void api.forwardHeld(p.id).catch(() => autoForwarded.current.delete(p.id))
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, rules])

  // prune the forwarded set when the queue drains
  useEffect(() => {
    if (pending.length === 0) autoForwarded.current.clear()
  }, [pending.length])

  useEffect(() => {
    if (!currentId) {
      setHeldFull(null)
      setRaw(null)
      return
    }
    let alive = true
    api
      .getHeldRequest(currentId)
      .then((req) => {
        if (!alive) return
        setHeldFull(req)
        setRaw(requestToRaw(req))
        setErr(null)
      })
      .catch((e) => alive && setErr(String(e)))
    return () => {
      alive = false
    }
  }, [currentId, pulse.intercept.pending.length])

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      setSelectedPending(null)
      setHeldFull(null)
      setRaw(null)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const onForward = () => {
    if (!currentId || raw === null || !heldFull) return
    const req = rawToRequest(raw, heldFull.url)
    if ('error' in req) {
      setErr(req.error)
      return
    }
    act(() => pulse.forwardPending(currentId, req))
  }

  const onDrop = () => {
    if (!currentId) return
    act(() => pulse.dropPending(currentId))
  }

  // Ctrl+R (global): copy the currently held request into a Repeater tab
  useEffect(() => {
    const onSend = () => {
      if (!heldFull) return
      void api.createRepeaterTab({
        request: {
          method: heldFull.method,
          url: heldFull.url,
          httpVersion: heldFull.httpVersion,
          headers: heldFull.headers,
          body: heldFull.body ?? '',
        },
      }).then(() => {
        try {
          localStorage.setItem('pulse.repeater.jumpNewest', '1')
        } catch {
          /* ignore */
        }
      })
    }
    window.addEventListener('pulse:send-to-repeater', onSend)
    return () => window.removeEventListener('pulse:send-to-repeater', onSend)
  }, [heldFull])

  // F / D forward & drop the held request — but never while typing
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy || !currentId) return
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) return
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        onForward()
      } else if (e.key === 'd' || e.key === 'D') {
        e.preventDefault()
        onDrop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, currentId, raw, heldFull])

  const queueMenu = (p: PendingItem): MenuItem[] => [
    {
      icon: 'play',
      label: 'Forward',
      hint: 'F',
      onClick: () => {
        setSelectedPending(p.id)
        // forward the stored request as-is
        void api.forwardHeld(p.id).then(
          () => pulse.refreshIntercept(),
          (e) => pulse.notify(`Forward failed: ${e.message}`, 'err'),
        )
      },
    },
    {
      icon: 'x',
      label: 'Drop',
      hint: 'D',
      separatorAfter: true,
      onClick: () => {
        void api.dropHeld(p.id).then(
          () => pulse.refreshIntercept(),
          (e) => pulse.notify(`Drop failed: ${e.message}`, 'err'),
        )
      },
    },
    {
      icon: 'copy',
      label: 'Copy URL',
      onClick: async () => {
        if (await copyToClipboard(p.url)) pulse.notify('URL copied')
      },
    },
  ]

  return (
    <div className="view padded row">
      <div className="panel" style={{ flex: 1 }}>
        <div className="panel-head">
          <span className="title">Held requests</span>
          <span className={`badge ${pending.length ? 'hot' : ''}`}>{pending.length || ''}</span>
          <button
            className={`btn sm ${rules.length > 0 ? 'primary' : ''}`}
            title="Hold rules — only matching requests pause here"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setRulesPos(rulesPos ? null : { x: r.left, y: r.bottom + 6 })
            }}
          >
            <Icon name="sliders" size={13} />
            Rules
            {rules.length > 0 && <span className="badge">{rules.length}</span>}
          </button>
          <div className="spacer" />
          {pulse.intercept.enabled ? (
            <span className="meta" style={{ color: 'var(--accent)' }}>
              ● holding
            </span>
          ) : (
            <span className="meta" style={{ color: 'var(--warn)' }}>
              ● off
            </span>
          )}
        </div>
        <div className="panel-body">
          {pending.length === 0 ? (
            <Empty icon={pulse.intercept.enabled ? 'hand' : 'circle'} title={pulse.intercept.enabled ? 'Nothing held' : 'Intercept is off'}>
              {pulse.intercept.enabled ? (
                rules.length > 0 ? (
                  <>
                    Only requests matching the {rules.length} hold rule{rules.length > 1 ? 's' : ''} pause here.
                    <br />
                    Everything else flows straight through.
                  </>
                ) : (
                  'Browse something — matching requests will pause here.'
                )
              ) : (
                'Every request currently flows straight to the server.'
              )}
              {!pulse.intercept.enabled && (
                <button className="btn primary" style={{ marginTop: 8 }} onClick={() => pulse.toggleIntercept(true)}>
                  <Icon name="hand" size={13} />
                  Turn on Intercept
                </button>
              )}
            </Empty>
          ) : (
            pending.map((p) => (
              <div
                key={p.id}
                className={`side-item ${currentId === p.id ? 'selected' : ''}`}
                onClick={() => setSelectedPending(p.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setSelectedPending(p.id)
                  setMenu({ x: e.clientX, y: e.clientY, item: p })
                }}
                title={`${p.url} — right-click for actions`}
              >
                <div className="l1">
                  <span className={`method-${p.method}`}>{p.method}</span>
                  <span className="id">{p.id.replace('req-', '')}</span>
                </div>
                <div className="l2" title={p.url}>
                  {p.url}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="panel" style={{ flex: 3 }}>
        <div className="panel-head">
          {/* common actions on the left, next to the title */}
          <button className="btn primary" disabled={!currentId || busy} onClick={onForward} title="Forward (F)">
            {busy ? <span className="spinner" /> : <Icon name="play" size={13} />}
            Forward
            <kbd>F</kbd>
          </button>
          <button className="btn danger" disabled={!currentId || busy} onClick={onDrop} title="Drop (D)">
            <Icon name="x" size={13} />
            Drop
            <kbd>D</kbd>
          </button>
          <div className="spacer" />
          {err && (
            <span className="err-inline" title={err}>
              <Icon name="alert" size={13} />
              {err}
            </span>
          )}
          {heldFull && <span className="meta">{heldFull.id}</span>}
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column' }}>
          {reqView && raw !== null ? (
            <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
              <RequestInspector
                req={reqView}
                editable
                raw={raw}
                onRawChange={setRaw}
              />
            </div>
          ) : (
            <Empty icon="hand" title="Nothing is being held">
              Enable Intercept, then trigger a request to catch it here.
            </Empty>
          )}
        </div>
      </div>

      {rulesPos && (
        <HoldRules rules={rules} onChange={saveRules} x={rulesPos.x} y={rulesPos.y} onClose={() => setRulesPos(null)} />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={queueMenu(menu.item)} onClose={() => setMenu(null)} />}
    </div>
  )
}
