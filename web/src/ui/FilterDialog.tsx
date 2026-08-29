// Burp-style display filter, centered modal. Covers everything in Burp's
// dialog except scripting and scope: methods, status expressions, file
// extension grid, MIME, request/response text match (regex + filter-out),
// and response size. Excludes script mode and scope per product decision.
// All client-side over flow metadata; persisted per browser.
import { useEffect } from 'react'
import Icon from '../ui/Icon'

export interface FilterModel {
  methods: string[] // empty = all
  statusExpr: string // "2xx, 404, 500-504"
  hideExts: string[] // extensions to hide (no dot)
  extraExts: string // custom extensions to hide, comma separated
  mime: string // response Content-Type contains
  reqText: string
  reqRegex: boolean
  reqOut: boolean // filter OUT matching requests
  respText: string
  respRegex: boolean
  respOut: boolean
  minSize: number | null
  maxSize: number | null
}

export const EMPTY_FILTER: FilterModel = {
  methods: [],
  statusExpr: '',
  hideExts: [],
  extraExts: '',
  mime: '',
  reqText: '',
  reqRegex: false,
  reqOut: false,
  respText: '',
  respRegex: false,
  respOut: false,
  minSize: null,
  maxSize: null,
}

const ALL_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']
const EXT_GRID = [
  'css', 'js', 'mjs', 'map',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp',
  'woff', 'woff2', 'ttf', 'otf',
  'mp4', 'webm', 'mp3', 'wav',
  'pdf', 'html', 'json',
]

export function filterActive(f: FilterModel): boolean {
  return (
    f.methods.length > 0 ||
    f.statusExpr.trim() !== '' ||
    f.hideExts.length > 0 ||
    f.extraExts.trim() !== '' ||
    f.mime.trim() !== '' ||
    f.reqText.trim() !== '' ||
    f.respText.trim() !== '' ||
    f.minSize !== null ||
    f.maxSize !== null
  )
}

function parseStatusExpr(expr: string): ((code: number) => boolean) | null {
  const tokens = expr.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
  if (tokens.length === 0) return null
  const checks: ((code: number) => boolean)[] = []
  for (const t of tokens) {
    const cls = t.match(/^(\d)xx$/)
    if (cls) {
      const c = Number(cls[1])
      checks.push((code) => Math.floor(code / 100) === c)
      continue
    }
    const range = t.match(/^(\d{3})-(\d{3})$/)
    if (range) {
      const lo = Number(range[1])
      const hi = Number(range[2])
      checks.push((code) => code >= lo && code <= hi)
      continue
    }
    const exact = t.match(/^\d{3}$/)
    if (exact) {
      const e = Number(t)
      checks.push((code) => code === e)
    }
  }
  return checks.length ? (code: number) => checks.some((c) => c(code)) : null
}

function matchText(text: string, value: string, regex: boolean): boolean {
  const needle = text.trim()
  if (!needle) return true
  if (regex) {
    try {
      return new RegExp(needle, 'i').test(value)
    } catch {
      return true
    }
  }
  return value.toLowerCase().includes(needle.toLowerCase())
}

export function passesFilter(f: FilterModel, m: Record<string, string>, status: number, respSize: number): boolean {
  if (f.methods.length > 0 && !f.methods.includes(m.method.toUpperCase())) return false
  const statusOk = parseStatusExpr(f.statusExpr)
  if (statusOk && !statusOk(status)) return false
  if (f.hideExts.length > 0 || f.extraExts.trim()) {
    const extras = f.extraExts.split(',').map((e) => e.trim().replace(/^\./, '').toLowerCase()).filter(Boolean)
    const ext = m.path.split('?')[0].split('.').pop()?.toLowerCase() ?? ''
    const hasExt = m.path.includes('.')
    if (hasExt && (f.hideExts.includes(ext) || extras.includes(ext))) return false
  }
  if (f.mime.trim() && !m.type.toLowerCase().includes(f.mime.trim().toLowerCase())) return false
  if (f.reqText.trim()) {
    const reqValue = `${m.method} ${m.host} ${m.path} ${m.url}`
    const hit = matchText(f.reqText, reqValue, f.reqRegex)
    if (f.reqOut ? hit : !hit) return false
  }
  if (f.respText.trim()) {
    // bodies are not indexed client-side — response match covers status + reason + content type
    const respValue = `${status} ${m.type}`
    const hit = matchText(f.respText, respValue, f.respRegex)
    if (f.respOut ? hit : !hit) return false
  }
  if (f.minSize !== null && respSize < f.minSize) return false
  if (f.maxSize !== null && respSize > f.maxSize) return false
  return true
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="fsec">
      <div className="fsec-label">{title}</div>
      {children}
    </div>
  )
}

function TextMatch({
  label,
  text,
  regex,
  out,
  onText,
  onRegex,
  onOut,
}: {
  label: string
  text: string
  regex: boolean
  out: boolean
  onText: (v: string) => void
  onRegex: (v: boolean) => void
  onOut: (v: boolean) => void
}) {
  return (
    <div className="fsec">
      <div className="fsec-label">{label}</div>
      <div className="adv-row">
        <input className="mini" placeholder="keyword…" value={text} spellCheck={false} onChange={(e) => onText(e.target.value)} />
        <label className="switch sm">
          <input type="checkbox" checked={regex} onChange={(e) => onRegex(e.target.checked)} />
          <span className="track" />
          Regex
        </label>
        <label className="switch sm">
          <input type="checkbox" checked={out} onChange={(e) => onOut(e.target.checked)} />
          <span className="track" />
          Filter out
        </label>
      </div>
    </div>
  )
}

export default function FilterDialog({
  value,
  onChange,
  onClose,
}: {
  value: FilterModel
  onChange: (v: FilterModel) => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const set = (patch: Partial<FilterModel>) => onChange({ ...value, ...patch })

  const toggleMethod = (mth: string) =>
    set({ methods: value.methods.includes(mth) ? value.methods.filter((x) => x !== mth) : [...value.methods, mth] })

  const toggleExt = (ext: string) =>
    set({ hideExts: value.hideExts.includes(ext) ? value.hideExts.filter((x) => x !== ext) : [...value.hideExts, ext] })

  const num = (v: string): number | null => {
    const n = parseInt(v, 10)
    return Number.isFinite(n) && n >= 0 ? n : null
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal filter-modal" role="dialog" aria-label="Display filter">
        <h3>
          <Icon name="filter" size={15} />
          Display filter
        </h3>
        <p className="sub">ANDs with the toolbar chips. Saved in this browser.</p>

        <div className="filter-scroll">
          <Section title="Request method">
            <div className="fsec-checks">
              {ALL_METHODS.map((mth) => (
                <label key={mth} className="switch sm">
                  <input type="checkbox" checked={value.methods.includes(mth)} onChange={() => toggleMethod(mth)} />
                  <span className="track" />
                  {mth}
                </label>
              ))}
            </div>
          </Section>

          <Section title="Status code">
            <input
              className="mini"
              placeholder='e.g. 2xx, 404, 500-504 (empty = all)'
              value={value.statusExpr}
              spellCheck={false}
              onChange={(e) => set({ statusExpr: e.target.value })}
            />
          </Section>

          <Section title="Hide file extensions">
            <div className="fsec-ext">
              {EXT_GRID.map((ext) => (
                <label key={ext} className="fsec-ext-item">
                  <input type="checkbox" checked={value.hideExts.includes(ext)} onChange={() => toggleExt(ext)} />
                  .{ext}
                </label>
              ))}
            </div>
            <input
              className="mini"
              style={{ marginTop: 8 }}
              placeholder="more extensions to hide, comma separated (e.g. wasm, avif)"
              value={value.extraExts}
              spellCheck={false}
              onChange={(e) => set({ extraExts: e.target.value })}
            />
          </Section>

          <Section title="Response Content-Type contains">
            <input
              className="mini"
              placeholder="e.g. json, text/html (empty = all)"
              value={value.mime}
              spellCheck={false}
              onChange={(e) => set({ mime: e.target.value })}
            />
          </Section>

          <TextMatch
            label="Request containing"
            text={value.reqText}
            regex={value.reqRegex}
            out={value.reqOut}
            onText={(v) => set({ reqText: v })}
            onRegex={(v) => set({ reqRegex: v })}
            onOut={(v) => set({ reqOut: v })}
          />
          <TextMatch
            label="Response containing (status & content-type; bodies are not indexed)"
            text={value.respText}
            regex={value.respRegex}
            out={value.respOut}
            onText={(v) => set({ respText: v })}
            onRegex={(v) => set({ respRegex: v })}
            onOut={(v) => set({ respOut: v })}
          />

          <Section title="Response size (bytes)">
            <div className="adv-row">
              <input className="mini" type="number" min={0} placeholder="min" value={value.minSize ?? ''} onChange={(e) => set({ minSize: num(e.target.value) })} />
              <span className="faint">—</span>
              <input className="mini" type="number" min={0} placeholder="max" value={value.maxSize ?? ''} onChange={(e) => set({ maxSize: num(e.target.value) })} />
            </div>
          </Section>
        </div>

        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn ghost sm" style={{ marginRight: 'auto' }} onClick={() => onChange({ ...EMPTY_FILTER })}>
            Reset all
          </button>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
