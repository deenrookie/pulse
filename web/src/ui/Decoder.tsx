// XSSor/CyberChef-inspired decoder card: input and output stacked on the
// left, a grouped operations column on the right. Clicking operations
// appends them to a chained recipe (auto-baked, reorderable); the card is
// draggable, resizable, pinnable/ghost, and fully persistent.
import { useEffect, useRef, useState } from 'react'
import Icon from './Icon'
import { copyToClipboard } from '../api'

interface Op {
  id: string
  label: string
  run: (text: string) => string | null | Promise<string | null>
}
interface Group {
  label: string
  ops: Op[]
}

const LS_KEY = 'pulse.decoder2'

interface Persisted {
  x: number
  y: number
  w: number
  h: number
  mode: 'top' | 'ghost'
  input: string
  recipe: string[]
}

const DEFAULTS: Persisted = { x: 140, y: 110, w: 780, h: 460, mode: 'top', input: '', recipe: [] }

function load(): Persisted {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null')
    return raw ? { ...DEFAULTS, ...raw } : { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS }
  }
}

// ---------- transforms ----------

function b64encode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function b64decode(text: string): string | null {
  try {
    const bin = atob(text.replace(/\s+/g, ''))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return null
  }
}

function urlDecode(text: string): string | null {
  try {
    return decodeURIComponent(text.replace(/\+/g, '%20'))
  } catch {
    return null
  }
}

/** percent-encode everything that is not URI-unreserved */
function urlEncodeAll(text: string): string {
  return Array.from(text)
    .map((c) => (/^[A-Za-z0-9_.~-]$/.test(c) ? c : encodeURIComponent(c)))
    .join('')
}

function hexEncode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ')
}

function hexDecode(text: string): string | null {
  const clean = text.replace(/0x/gi, '').replace(/[\s,]/g, '')
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) return null
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

function htmlEncode(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function htmlDecode(text: string): string | null {
  const doc = new DOMParser().parseFromString(text, 'text/html')
  return doc.documentElement.textContent
}

/** \uXXXX escapes (with surrogate pairs) */
function unicodeEncode(text: string): string {
  return Array.from(text)
    .map((c) => {
      const cp = c.codePointAt(0)!
      if (cp > 0xffff) {
        const hi = Math.floor((cp - 0x10000) / 0x400) + 0xd800
        const lo = ((cp - 0x10000) % 0x400) + 0xdc00
        return `\\u${hi.toString(16).padStart(4, '0')}\\u${lo.toString(16).padStart(4, '0')}`
      }
      return `\\u${cp.toString(16).padStart(4, '0')}`
    })
    .join('')
}

function unicodeDecode(text: string): string | null {
  if (!/\\u/i.test(text)) return null
  try {
    return JSON.parse(`"${text.replace(/"/g, '\\"')}"`)
  } catch {
    return null
  }
}

/** decimal char codes, comma separated (String.fromCharCode style) */
function charCodesEncode(text: string): string {
  return Array.from(text)
    .map((c) => c.codePointAt(0))
    .join(',')
}

function charCodesDecode(text: string): string | null {
  const parts = text.split(/[\s,]+/).filter(Boolean)
  if (parts.length === 0 || parts.some((p) => !/^\d+$/.test(p))) return null
  try {
    return String.fromCodePoint(...parts.map(Number))
  } catch {
    return null
  }
}

function rot13(text: string): string {
  return text.replace(/[a-z]/gi, (c) => {
    const base = c <= 'Z' ? 65 : 97
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base)
  })
}

async function gzipEncode(text: string): Promise<string | null> {
  try {
    const cs = new CompressionStream('gzip')
    const stream = new Response(new Blob([new TextEncoder().encode(text) as unknown as BlobPart]).stream().pipeThrough(cs))
    const bytes = new Uint8Array(await stream.arrayBuffer())
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    return btoa(bin)
  } catch {
    return null
  }
}

async function gzipDecode(text: string): Promise<string | null> {
  try {
    const bin = atob(text.replace(/\s+/g, ''))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const ds = new DecompressionStream('gzip')
    const stream = new Response(new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(ds))
    return new TextDecoder('utf-8', { fatal: false }).decode(await stream.arrayBuffer())
  } catch {
    return null
  }
}

async function digest(text: string, algo: 'SHA-1' | 'SHA-256' | 'SHA-512'): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const buf = await crypto.subtle.digest(algo, bytes)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** decode one layer automatically (used by Magic) */
async function decodeOneLayer(text: string): Promise<{ text: string; label: string } | null> {
  if (/%[0-9a-f]{2}/i.test(text)) {
    const r = urlDecode(text)
    if (r !== null && r !== text) return { text: r, label: 'URL' }
  }
  const compact = text.replace(/\s+/g, '')
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(compact) && compact.length % 4 === 0 && compact.length >= 8) {
    const g = await gzipDecode(compact)
    if (g !== null && g !== text) return { text: g, label: 'Gzip' }
    const r = b64decode(compact)
    if (r !== null && r !== text && /[\x20-\x7e]/.test(r)) return { text: r, label: 'Base64' }
  }
  if (/&(#x?[0-9a-f]+|[a-z]+);/i.test(text)) {
    const r = htmlDecode(text)
    if (r !== null && r !== text) return { text: r, label: 'HTML' }
  }
  if (/^\s*([0-9a-f]{2}[\s,]+)+[0-9a-f]{2}\s*$/i.test(text)) {
    const r = hexDecode(text)
    if (r !== null && r !== text) return { text: r, label: 'Hex' }
  }
  if (/\\u[0-9a-f]{4}/i.test(text)) {
    const r = unicodeDecode(text)
    if (r !== null && r !== text) return { text: r, label: 'Unicode' }
  }
  return null
}

async function smartDecode(text: string): Promise<string> {
  let cur = text
  for (let depth = 0; depth < 6; depth++) {
    const layer = await decodeOneLayer(cur)
    if (!layer) break
    cur = layer.text
  }
  return cur
}

const GROUPS: Group[] = [
  {
    label: 'Encode',
    ops: [
      { id: 'b64enc', label: 'Base64', run: (t) => b64encode(t) },
      { id: 'urlenc', label: 'URL', run: (t) => encodeURIComponent(t) },
      { id: 'urlall', label: 'URL (all)', run: (t) => urlEncodeAll(t) },
      { id: 'hexenc', label: 'Hex', run: (t) => hexEncode(t) },
      { id: 'htmlenc', label: 'HTML', run: (t) => htmlEncode(t) },
      { id: 'unienc', label: 'Unicode', run: (t) => unicodeEncode(t) },
      { id: 'cdcenc', label: 'Char codes', run: (t) => charCodesEncode(t) },
      { id: 'gzenc', label: 'Gzip·b64', run: (t) => gzipEncode(t) },
    ],
  },
  {
    label: 'Decode',
    ops: [
      { id: 'b64dec', label: 'Base64', run: (t) => b64decode(t) },
      { id: 'urldec', label: 'URL', run: (t) => urlDecode(t) },
      { id: 'hexdec', label: 'Hex', run: (t) => hexDecode(t) },
      { id: 'htmldec', label: 'HTML', run: (t) => htmlDecode(t) },
      { id: 'unidec', label: 'Unicode', run: (t) => unicodeDecode(t) },
      { id: 'cdcdec', label: 'Char codes', run: (t) => charCodesDecode(t) },
      { id: 'gzdec', label: 'Gunzip·b64', run: (t) => gzipDecode(t) },
      { id: 'magic', label: '✨ Magic', run: (t) => smartDecode(t) },
    ],
  },
  {
    label: 'Transform',
    ops: [
      { id: 'rot13', label: 'ROT13', run: (t) => rot13(t) },
      { id: 'reverse', label: 'Reverse', run: (t) => Array.from(t).reverse().join('') },
      { id: 'upper', label: 'UPPER', run: (t) => t.toUpperCase() },
      { id: 'lower', label: 'lower', run: (t) => t.toLowerCase() },
      { id: 'trim', label: 'Trim', run: (t) => t.trim() },
    ],
  },
  {
    label: 'Hash',
    ops: [
      { id: 'sha1', label: 'SHA-1', run: (t) => digest(t, 'SHA-1') },
      { id: 'sha256', label: 'SHA-256', run: (t) => digest(t, 'SHA-256') },
      { id: 'sha512', label: 'SHA-512', run: (t) => digest(t, 'SHA-512') },
    ],
  },
]

const ALL_OPS: Op[] = GROUPS.flatMap((g) => g.ops)
const opById = (id: string) => ALL_OPS.find((o) => o.id === id)

export default function Decoder({ onClose, seed }: { onClose: () => void; seed?: { text: string; n: number } | null }) {
  const [st, setSt] = useState<Persisted>(load)
  const [search, setSearch] = useState('')
  const [output, setOutput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const bakeToken = useRef(0)

  // "Send to Decoder" payload: replace the input (recipe is kept — Burp keeps
  // its transform chain too); n re-triggers even for identical text
  useEffect(() => {
    if (seed) save({ input: seed.text })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.n])

  const save = (patch: Partial<Persisted>) =>
    setSt((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })

  const persist = () => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(st))
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    const w = window.innerWidth
    const h = window.innerHeight
    if (st.x > w - 120 || st.y > h - 80 || st.x < 0 || st.y < 0) {
      save({ x: Math.min(Math.max(8, st.x), w - 200), y: Math.min(Math.max(8, st.y), h - 120) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- auto-bake: input → recipe chain → output ----
  useEffect(() => {
    const token = ++bakeToken.current
    let cancelled = false
    const bake = async () => {
      setError(null)
      let cur = st.input
      for (const id of st.recipe) {
        const op = opById(id)
        if (!op) continue
        try {
          const out = await op.run(cur)
          if (out === null) {
            if (!cancelled && token === bakeToken.current) {
              setError(`“${op.label}” cannot parse this input`)
              setOutput(cur)
            }
            return
          }
          cur = out
        } catch (e) {
          if (!cancelled && token === bakeToken.current) {
            setError(`“${op.label}” failed: ${(e as Error).message}`)
          }
          return
        }
      }
      if (!cancelled && token === bakeToken.current) setOutput(cur)
    }
    void bake()
    return () => {
      cancelled = true
    }
  }, [st.input, st.recipe])

  // ---- dragging ----
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const onHeadDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { dx: e.clientX - st.x, dy: e.clientY - st.y }
    setDragging(true)
  }
  const onHeadMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    const x = Math.min(Math.max(0, e.clientX - dragRef.current.dx), window.innerWidth - 100)
    const y = Math.min(Math.max(0, e.clientY - dragRef.current.dy), window.innerHeight - 60)
    setSt((prev) => ({ ...prev, x, y }))
  }
  const onHeadUp = () => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    persist()
  }

  // ---- resizing ----
  const sizeRef = useRef<{ w: number; h: number; x: number; y: number } | null>(null)
  const [resizing, setResizing] = useState(false)
  const onGripDown = (e: React.PointerEvent) => {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    sizeRef.current = { w: st.w, h: st.h, x: e.clientX, y: e.clientY }
    setResizing(true)
  }
  const onGripMove = (e: React.PointerEvent) => {
    const s = sizeRef.current
    if (!s) return
    const w = Math.min(Math.max(560, s.w + e.clientX - s.x), window.innerWidth - st.x - 8)
    const h = Math.min(Math.max(360, s.h + e.clientY - s.y), window.innerHeight - st.y - 8)
    setSt((prev) => ({ ...prev, w, h }))
  }
  const onGripUp = () => {
    if (!sizeRef.current) return
    sizeRef.current = null
    setResizing(false)
    persist()
  }

  // ---- palette / recipe ----
  const needle = search.trim().toLowerCase()
  const groups = GROUPS.map((g) => ({
    label: g.label,
    ops: g.ops.filter((o) => !needle || o.label.toLowerCase().includes(needle)),
  })).filter((g) => g.ops.length > 0)

  const addOp = (id: string) => save({ recipe: [...st.recipe, id] })
  const removeOp = (i: number) => save({ recipe: st.recipe.filter((_, idx) => idx !== i) })

  return (
    <div
      className={`decoder ${st.mode === 'ghost' ? 'ghost' : ''} ${dragging || resizing ? 'dragging' : ''}`}
      style={{ left: st.x, top: st.y, width: st.w, height: st.h }}
    >
      <div
        className="decoder-head"
        onPointerDown={onHeadDown}
        onPointerMove={onHeadMove}
        onPointerUp={onHeadUp}
        title="Drag to move · corner grip resizes"
      >
        <span className="title">
          <Icon name="terminal" size={14} />
          Decoder
        </span>
        <span className="spacer" />
        <button
          className="btn ghost sm icon-btn"
          title={st.mode === 'top' ? 'Pinned on top — click for ghost mode (fades, hover to focus)' : 'Ghost mode — click to pin on top'}
          onClick={() => save({ mode: st.mode === 'top' ? 'ghost' : 'top' })}
        >
          <Icon name={st.mode === 'top' ? 'shield' : 'circle'} size={13} />
        </button>
        <button className="btn ghost sm icon-btn" title="Close (input, recipe, size and position are kept)" onClick={onClose}>
          <Icon name="x" size={13} />
        </button>
      </div>

      <div className="dc-main">
        <div className="dc-io-col">
          <div className="dc-io">
            <span className="dc-label">
              Input
              <span className="dc-hint">operations on the right chain into a recipe</span>
            </span>
            <textarea
              value={st.input}
              spellCheck={false}
              placeholder="paste text here…"
              onChange={(e) => save({ input: e.target.value })}
            />
          </div>
          <div className="dc-io">
            <span className="dc-label">
              Output
              {error ? <span className="dc-err">{error}</span> : <span className="dc-hint">auto-baked</span>}
            </span>
            <textarea value={output} spellCheck={false} readOnly placeholder="recipe result appears here…" />
            <div className="dc-out-actions">
              <button
                className="mini"
                disabled={!output}
                onClick={() => save({ input: output, recipe: [] })}
                title="Move the output into the input and clear the recipe"
              >
                ↻ Output → Input
              </button>
              <button className="mini" disabled={!output} onClick={() => void copyToClipboard(output, { label: 'output' })}>
                Copy
              </button>
            </div>
          </div>
        </div>

        <div className="dc-ops-col">
          <input className="input dc-search" placeholder="Search operations…" value={search} spellCheck={false} onChange={(e) => setSearch(e.target.value)} />
          <div className="dc-groups">
            {groups.map((g) => (
              <div key={g.label} className="dc-group">
                <div className="dc-group-label">{g.label}</div>
                <div className="dc-grid">
                  {g.ops.map((op) => (
                    <button key={op.id} className="dc-op" onClick={() => addOp(op.id)} title={`Add “${op.label}” to the recipe`}>
                      {op.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {groups.length === 0 && <div className="dc-empty">No matching operations</div>}
          </div>
        </div>
      </div>

      <div className="cyber-recipe">
        <span className="dc-label" style={{ flex: 'none' }}>Recipe</span>
        {st.recipe.length === 0 ? (
          <span className="dc-empty" style={{ padding: 0 }}>
            click operations on the right to chain them
          </span>
        ) : (
          <>
            {st.recipe.map((id, i) => {
              const op = opById(id)
              return (
                <span key={`${id}-${i}`} className="cyber-chip">
                  {op?.label ?? id}
                  <button className="cyber-chip-x" title="Remove" onClick={() => removeOp(i)}>
                    <Icon name="x" size={10} />
                  </button>
                </span>
              )
            })}
            <button className="mini" onClick={() => save({ recipe: [] })}>
              Clear
            </button>
          </>
        )}
      </div>

      <div
        className={`decoder-grip ${resizing ? 'active' : ''}`}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        title="Drag to resize"
      />
    </div>
  )
}
