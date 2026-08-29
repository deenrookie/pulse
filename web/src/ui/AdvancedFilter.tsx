// Burp-style advanced filter popover for Live Traffic: fine-grained text
// matching (field + regex + invert), per-type hiding, and a response-size
// range. Persisted client-side; ANDs with the quick filter chips.
import { useEffect } from 'react'
import Icon from '../ui/Icon'

export interface AdvancedFilter {
  field: 'any' | 'host' | 'path' | 'url' | 'method' | 'status'
  mode: 'contains' | 'regex'
  text: string
  invert: boolean
  hideImages: boolean
  hideCssJs: boolean
  hideFonts: boolean
  minSize: number | null
  maxSize: number | null
}

export const EMPTY_ADVANCED: AdvancedFilter = {
  field: 'any',
  mode: 'contains',
  text: '',
  invert: false,
  hideImages: false,
  hideCssJs: false,
  hideFonts: false,
  minSize: null,
  maxSize: null,
}

export function advancedActive(a: AdvancedFilter): boolean {
  return (
    a.text.trim() !== '' || a.hideImages || a.hideCssJs || a.hideFonts || a.minSize !== null || a.maxSize !== null
  )
}

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|ico|webp|avif)(\?|$)/i
const CSSJS_EXT = /\.(css|js|mjs|map)(\?|$)/i
const FONT_EXT = /\.(woff2?|ttf|otf|eot)(\?|$)/i
const IMAGE_TYPE = /^image\//i
const CSSJS_TYPE = /^(text\/css|text\/javascript|application\/javascript)/i
const FONT_TYPE = /^font\/|application\/x-font/i

export function passesAdvanced(a: AdvancedFilter, m: Record<string, string>, respSize: number): boolean {
  const text = a.text.trim()
  if (text) {
    let value: string
    switch (a.field) {
      case 'host':
        value = m.host
        break
      case 'path':
        value = m.path
        break
      case 'url':
        value = m.url
        break
      case 'method':
        value = m.method
        break
      case 'status':
        value = m.status
        break
      default:
        value = `${m.method} ${m.host} ${m.path} ${m.status} ${m.type}`
    }
    let hit: boolean
    if (a.mode === 'regex') {
      try {
        hit = new RegExp(text, 'i').test(value)
      } catch {
        hit = true // broken regex matches everything rather than hiding all
      }
    } else {
      hit = value.toLowerCase().includes(text.toLowerCase())
    }
    if (a.invert === hit) return false // invert flips the outcome
  }
  if (a.hideImages && (IMAGE_EXT.test(m.path) || IMAGE_TYPE.test(m.type))) return false
  if (a.hideCssJs && (CSSJS_EXT.test(m.path) || CSSJS_TYPE.test(m.type))) return false
  if (a.hideFonts && (FONT_EXT.test(m.path) || FONT_TYPE.test(m.type))) return false
  if (a.minSize !== null && respSize < a.minSize) return false
  if (a.maxSize !== null && respSize > a.maxSize) return false
  return true
}

export default function AdvancedFilterPopover({
  value,
  onChange,
  x,
  y,
  onClose,
}: {
  value: AdvancedFilter
  onChange: (v: AdvancedFilter) => void
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

  const set = (patch: Partial<AdvancedFilter>) => onChange({ ...value, ...patch })

  const num = (v: string): number | null => {
    const n = parseInt(v, 10)
    return Number.isFinite(n) && n >= 0 ? n : null
  }

  return (
    <div
      className="popover"
      style={{ left: Math.max(8, Math.min(x, window.innerWidth - 480)), top: Math.max(8, Math.min(y, window.innerHeight - 460)) }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <h4>
        <Icon name="filter" size={14} />
        Advanced filter
      </h4>
      <div className="sub">ANDs with the quick chips. Saved in this browser.</div>

      <div className="adv-section">
        <div className="adv-label">Match</div>
        <div className="adv-row">
          <select className="mini" value={value.field} onChange={(e) => set({ field: e.target.value as AdvancedFilter['field'] })}>
            <option value="any">anywhere</option>
            <option value="host">host</option>
            <option value="path">path</option>
            <option value="url">url</option>
            <option value="method">method</option>
            <option value="status">status</option>
          </select>
          <select className="mini" value={value.mode} onChange={(e) => set({ mode: e.target.value as AdvancedFilter['mode'] })}>
            <option value="contains">contains</option>
            <option value="regex">regex</option>
          </select>
          <input
            className="mini"
            placeholder={value.mode === 'regex' ? 'regex…' : 'text…'}
            value={value.text}
            spellCheck={false}
            onChange={(e) => set({ text: e.target.value })}
          />
        </div>
        <label className="switch sm">
          <input type="checkbox" checked={value.invert} onChange={(e) => set({ invert: e.target.checked })} />
          <span className="track" />
          Invert — show everything that does NOT match
        </label>
      </div>

      <div className="adv-section">
        <div className="adv-label">Hide by type</div>
        <div className="adv-checks">
          <label className="switch sm">
            <input type="checkbox" checked={value.hideImages} onChange={(e) => set({ hideImages: e.target.checked })} />
            <span className="track" />
            Images
          </label>
          <label className="switch sm">
            <input type="checkbox" checked={value.hideCssJs} onChange={(e) => set({ hideCssJs: e.target.checked })} />
            <span className="track" />
            CSS / JS
          </label>
          <label className="switch sm">
            <input type="checkbox" checked={value.hideFonts} onChange={(e) => set({ hideFonts: e.target.checked })} />
            <span className="track" />
            Fonts
          </label>
        </div>
      </div>

      <div className="adv-section">
        <div className="adv-label">Response size (bytes)</div>
        <div className="adv-row">
          <input
            className="mini"
            type="number"
            min={0}
            placeholder="min"
            value={value.minSize ?? ''}
            onChange={(e) => set({ minSize: num(e.target.value) })}
          />
          <span className="faint">—</span>
          <input
            className="mini"
            type="number"
            min={0}
            placeholder="max"
            value={value.maxSize ?? ''}
            onChange={(e) => set({ maxSize: num(e.target.value) })}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn ghost sm" onClick={() => onChange({ ...EMPTY_ADVANCED })}>
          Reset
        </button>
        <button className="btn sm" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}
