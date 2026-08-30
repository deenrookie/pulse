// CyberChef-style decoder card: left = input, right = output, middle =
// searchable operations palette. Clicking operations builds a chained
// recipe (applied in order, auto-baked); the card is draggable,
// resizable (corner grip), pinnable/ghost, and fully persistent.
import { useEffect, useRef, useState } from 'react'
import Icon from './Icon'

interface Op {
  id: string
  label: string
  run: (text: string) => string | null | Promise<string | null>
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

const DEFAULTS: Persisted = { x: 140, y: 110, w: 760, h: 430, mode: 'top', input: '', recipe: [] }

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

const OPS: Op[] = [
  { id: 'b64enc', label: 'To Base64', run: (t) => b64encode(t) },
  { id: 'b64dec', label: 'From Base64', run: (t) => b64decode(t) },
  { id: 'urlenc', label: 'Encode URL', run: (t) => encodeURIComponent(t) },
  { id: 'urldec', label: 'Decode URL', run: (t) => urlDecode(t) },
  { id: 'hexenc', label: 'To Hex', run: (t) => hexEncode(t) },
  { id: 'hexdec', label: 'From Hex', run: (t) => hexDecode(t) },
  { id: 'htmlenc', label: 'Encode HTML', run: (t) => htmlEncode(t) },
  { id: 'htmldec', label: 'Decode HTML', run: (t) => htmlDecode(t) },
  { id: 'gzenc', label: 'Gzip → Base64', run: (t) => gzipEncode(t) },
  { id: 'gzdec', label: 'Base64 → Gunzip', run: (t) => gzipDecode(t) },
  { id: 'magic', label: '✨ Magic (auto)', run: (t) => smartDecode(t) },
]

const opById = (id: string) => OPS.find((o) => o.id === id)

export default function Decoder({ onClose }: { onClose: () => void }) {
  const [st, setSt] = useState<Persisted>(load)
  const [search, setSearch] = useState('')
  const [output, setOutput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const bakeToken = useRef(0)

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

  // keep the card on screen on first mount
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

  // ---- dragging (header) ----
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

  // ---- resizing (corner grip) ----
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
    const w = Math.min(Math.max(520, s.w + e.clientX - s.x), window.innerWidth - st.x - 8)
    const h = Math.min(Math.max(340, s.h + e.clientY - s.y), window.innerHeight - st.y - 8)
    setSt((prev) => ({ ...prev, w, h }))
  }
  const onGripUp = () => {
    if (!sizeRef.current) return
    sizeRef.current = null
    setResizing(false)
    persist()
  }

  // ---- palette / recipe ----
  const filteredOps = OPS.filter((o) => o.label.toLowerCase().includes(search.trim().toLowerCase()))
  const addOp = (id: string) => save({ recipe: [...st.recipe, id] })
  const removeOp = (i: number) => save({ recipe: st.recipe.filter((_, idx) => idx !== i) })
  const moveOp = (i: number, dir: -1 | 1) => {
    const next = [...st.recipe]
    const j = i + dir
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    save({ recipe: next })
  }

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

      <div className="cyber-body">
        <div className="cyber-palette">
          <input
            className="input cyber-search"
            placeholder="Search operations…"
            value={search}
            spellCheck={false}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="cyber-ops">
            {filteredOps.map((op) => (
              <button key={op.id} className="cyber-op" onClick={() => addOp(op.id)} title={`Add “${op.label}” to the recipe`}>
                <Icon name="plus" size={11} />
                {op.label}
              </button>
            ))}
            {filteredOps.length === 0 && <div className="cyber-ops-empty">No matching operations</div>}
          </div>
        </div>

        <div className="cyber-io">
          <span className="decoder-label">Input</span>
          <textarea
            value={st.input}
            spellCheck={false}
            placeholder="paste text here, then chain operations from the left…"
            onChange={(e) => save({ input: e.target.value })}
          />
        </div>

        <div className="cyber-io">
          <span className="decoder-label">
            Output {error ? <span style={{ color: 'var(--danger)', textTransform: 'none', letterSpacing: 0 }}>{error}</span> : ''}
          </span>
          <textarea value={output} spellCheck={false} readOnly placeholder="recipe result appears here automatically…" />
          <div className="cyber-out-actions">
            <button
              className="mini"
              disabled={!output}
              onClick={() => save({ input: output, recipe: [] })}
              title="Move the output into the input and clear the recipe"
            >
              ↻ Output → Input
            </button>
            <button className="mini" disabled={!output} onClick={() => void navigator.clipboard?.writeText(output)}>
              Copy
            </button>
          </div>
        </div>
      </div>

      <div className="cyber-recipe">
        <span className="decoder-label">Recipe</span>
        {st.recipe.length === 0 ? (
          <span className="cyber-ops-empty" style={{ padding: 0 }}>
            click operations on the left to chain them
          </span>
        ) : (
          <>
            {st.recipe.map((id, i) => {
              const op = opById(id)
              return (
                <span key={`${id}-${i}`} className="cyber-chip">
                  <button className="cyber-chip-move" title="Move earlier" disabled={i === 0} onClick={() => moveOp(i, -1)}>
                    ▲
                  </button>
                  <button className="cyber-chip-move" title="Move later" disabled={i === st.recipe.length - 1} onClick={() => moveOp(i, 1)}>
                    ▼
                  </button>
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
