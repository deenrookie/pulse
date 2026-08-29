// Popover to manage Live Traffic highlight rules: request/response scope,
// field, contains/regex match, marker color. Rules live in localStorage and
// are evaluated client-side against flow metadata (first match wins).
import { useEffect, useRef } from 'react'
import Icon from './Icon'
import { MARK_COLORS } from './palette'

export interface HighlightRule {
  id: string
  scope: 'request' | 'response'
  field: 'url' | 'host' | 'path' | 'method' | 'status' | 'type'
  mode: 'contains' | 'regex'
  match: string
  color: string
}

const FIELDS: { id: HighlightRule['field']; label: string }[] = [
  { id: 'host', label: 'Host' },
  { id: 'path', label: 'Path' },
  { id: 'url', label: 'URL' },
  { id: 'method', label: 'Method' },
  { id: 'status', label: 'Status' },
  { id: 'type', label: 'Type' },
]

export function ruleMatches(rule: HighlightRule, m: Record<string, string>): boolean {
  if (!rule.match) return false
  const value = m[`${rule.scope}.${rule.field}`] ?? ''
  if (!value) return false
  if (rule.mode === 'regex') {
    try {
      return new RegExp(rule.match, 'i').test(value)
    } catch {
      return false
    }
  }
  return value.toLowerCase().includes(rule.match.toLowerCase())
}

export default function HighlightRules({
  rules,
  onChange,
  x,
  y,
  onClose,
}: {
  rules: HighlightRule[]
  onChange: (rules: HighlightRule[]) => void
  x: number
  y: number
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
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

  const update = (id: string, patch: Partial<HighlightRule>) =>
    onChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)))

  const add = () =>
    onChange([
      ...rules,
      {
        id: crypto.randomUUID(),
        scope: 'request',
        field: 'host',
        mode: 'contains',
        match: '',
        color: '#fb923c',
      },
    ])

  const del = (id: string) => onChange(rules.filter((r) => r.id !== id))

  return (
    <div
      ref={ref}
      className="popover"
      style={{ left: Math.max(8, Math.min(x, window.innerWidth - 440)), top: Math.max(8, Math.min(y, window.innerHeight - 360)) }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <h4>
        <Icon name="bolt" size={14} />
        Highlight rules
      </h4>
      <div className="sub">
        Matching flows get a colored marker in Live Traffic. First match wins. Applied client-side, saved in this
        browser.
      </div>
      <div className="rule-list">
        {rules.length === 0 && (
          <div className="rule-empty">
            No rules. Example: response · Host · contains · <b>api.</b> → red — every API response row turns red.
          </div>
        )}
        {rules.map((r) => (
          <div key={r.id} className="rule-row">
            <select className="mini" value={r.scope} onChange={(e) => update(r.id, { scope: e.target.value as HighlightRule['scope'] })}>
              <option value="request">request</option>
              <option value="response">response</option>
            </select>
            <select className="mini" value={r.field} onChange={(e) => update(r.id, { field: e.target.value as HighlightRule['field'] })}>
              {FIELDS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            <select className="mini" value={r.mode} onChange={(e) => update(r.id, { mode: e.target.value as HighlightRule['mode'] })}>
              <option value="contains">contains</option>
              <option value="regex">regex</option>
            </select>
            <input
              className="mini"
              placeholder="match…"
              value={r.match}
              spellCheck={false}
              onChange={(e) => update(r.id, { match: e.target.value })}
            />
            <div className="swatch-picker">
              {MARK_COLORS.map((c) => (
                <button
                  key={c.id}
                  className={`swatch ${r.color === c.value ? 'on' : ''}`}
                  style={{ background: c.value }}
                  title={c.label}
                  onClick={() => update(r.id, { color: c.value })}
                />
              ))}
            </div>
            <button className="btn ghost sm icon-btn" title="Remove rule" onClick={() => del(r.id)}>
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn sm" onClick={add}>
          <Icon name="plus" size={13} />
          Add rule
        </button>
        {rules.length > 0 && (
          <button className="btn ghost sm" onClick={() => onChange([])}>
            Clear all
          </button>
        )}
      </div>
    </div>
  )
}
