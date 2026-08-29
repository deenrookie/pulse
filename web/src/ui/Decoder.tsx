// Burp-style decoder card: draggable, pinnable (always-on-top) or ghost
// (semi-transparent, raises on hover), manually closable, and persistent —
// input, transform history, position and mode survive close/reopen.
import { useEffect, useRef, useState } from 'react'
import Icon from './Icon'

type Step = { label: string; text: string }

const LS_KEY = 'pulse.decoder'

interface Persisted {
  x: number
  y: number
  mode: 'top' | 'ghost'
  input: string
  steps: Step[]
  selected: number | null
}

const DEFAULTS: Persisted = { x: 120, y: 120, mode: 'top', input: '', steps: [], selected: null }

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

function urlEncode(text: string): string {
  return encodeURIComponent(text)
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

type Transform = {
  label: string
  run: (text: string) => string | null | Promise<string | null>
}

const TRANSFORMS: Transform[] = [
  { label: 'Encode → Base64', run: (t) => b64encode(t) },
  { label: 'Decode → Base64', run: (t) => b64decode(t) },
  { label: 'Encode → URL', run: (t) => urlEncode(t) },
  { label: 'Decode → URL', run: (t) => urlDecode(t) },
  { label: 'Encode → Hex', run: (t) => hexEncode(t) },
  { label: 'Decode → Hex', run: (t) => hexDecode(t) },
  { label: 'Encode → HTML', run: (t) => htmlEncode(t) },
  { label: 'Decode → HTML', run: (t) => htmlDecode(t) },
  { label: 'Encode → Gzip·b64', run: (t) => gzipEncode(t) },
  { label: 'Decode → Gzip·b64', run: (t) => gzipDecode(t) },
]

/** apply transforms one by one while their output looks like another layer */
async function smartDecode(text: string): Promise<{ text: string; chain: string[] }> {
  let cur = text
  const chain: string[] = []
  for (let depth = 0; depth < 6; depth++) {
    let matched = false
    // url
    if (/%[0-9a-f]{2}/i.test(cur)) {
      const r = urlDecode(cur)
      if (r !== null && r !== cur) {
        cur = r
        chain.push('URL')
        matched = true
      }
    } else if (/^\s*[A-Za-z0-9+/]+={0,2}\s*$/.test(cur) && cur.replace(/\s/g, '').length % 4 === 0 && cur.replace(/\s/g, '').length >= 8) {
      const r = b64decode(cur)
      if (r !== null && r !== cur && /[\x20-\x7e]/.test(r)) {
        // could be gzip base64 too — prefer gunzip when it works
        const g = await gzipDecode(cur.replace(/\s+/g, ''))
        if (g !== null && g !== cur) {
          cur = g
          chain.push('Gzip')
        } else {
          cur = r
          chain.push('Base64')
        }
        matched = true
      }
    } else if (/&(#x?[0-9a-f]+|[a-z]+);/i.test(cur)) {
      const r = htmlDecode(cur)
      if (r !== null && r !== cur) {
        cur = r
        chain.push('HTML')
        matched = true
      }
    } else if (/^\s*([0-9a-f]{2}[\s,]+)+[0-9a-f]{2}\s*$/i.test(cur)) {
      const r = hexDecode(cur)
      if (r !== null && r !== cur) {
        cur = r
        chain.push('Hex')
        matched = true
      }
    }
    if (!matched) break
  }
  return { text: cur, chain }
}

export default function Decoder({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<Persisted>(load)
  const [busy, setBusy] = useState(false)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const save = (patch: Partial<Persisted>) =>
    setState((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })

  // keep the card on screen
  useEffect(() => {
    const w = window.innerWidth
    const h = window.innerHeight
    if (state.x > w - 120 || state.y > h - 80 || state.x < 0 || state.y < 0) {
      save({ x: Math.min(Math.max(8, state.x), w - 200), y: Math.min(Math.max(8, state.y), h - 120) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onHeadDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { dx: e.clientX - state.x, dy: e.clientY - state.y }
    setDragging(true)
  }
  const onHeadMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    const x = Math.min(Math.max(0, e.clientX - dragRef.current.dx), window.innerWidth - 100)
    const y = Math.min(Math.max(0, e.clientY - dragRef.current.dy), window.innerHeight - 60)
    setState((prev) => ({ ...prev, x, y }))
  }
  const onHeadUp = () => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state))
    } catch {
      /* ignore */
    }
  }

  const applyTransform = async (t: Transform) => {
    setBusy(true)
    try {
      const out = await t.run(state.input)
      if (out === null) {
        return
      }
      save({ steps: [...state.steps, { label: t.label, text: out }], selected: state.steps.length })
    } finally {
      setBusy(false)
    }
  }

  const applySmart = async () => {
    setBusy(true)
    try {
      const { text, chain } = await smartDecode(state.input)
      if (chain.length === 0) return
      save({ steps: [...state.steps, { label: `Smart (${chain.join(' → ')})`, text }], selected: state.steps.length })
    } finally {
      setBusy(false)
    }
  }

  const selectedStep = state.selected !== null ? state.steps[state.selected] : null

  return (
    <div
      className={`decoder ${state.mode === 'ghost' ? 'ghost' : ''} ${dragging ? 'dragging' : ''}`}
      style={{ left: state.x, top: state.y }}
    >
      <div
        className="decoder-head"
        onPointerDown={onHeadDown}
        onPointerMove={onHeadMove}
        onPointerUp={onHeadUp}
        title="Drag to move"
      >
        <span className="title">
          <Icon name="terminal" size={14} />
          Decoder
        </span>
        <span className="spacer" />
        <button
          className="btn ghost sm icon-btn"
          title={state.mode === 'top' ? 'Pinned on top — click for ghost mode (fades, hover to focus)' : 'Ghost mode — click to pin on top'}
          onClick={() => save({ mode: state.mode === 'top' ? 'ghost' : 'top' })}
        >
          <Icon name={state.mode === 'top' ? 'shield' : 'circle'} size={13} />
        </button>
        <button className="btn ghost sm icon-btn" title="Close (input and history are kept)" onClick={onClose}>
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="decoder-body">
        <span className="decoder-label">Input</span>
        <textarea
          value={state.input}
          spellCheck={false}
          placeholder="paste text to encode or decode…"
          onChange={(e) => save({ input: e.target.value })}
        />
        <div className="decoder-actions">
          {TRANSFORMS.map((t) => (
            <button key={t.label} className="mini" disabled={busy} onClick={() => void applyTransform(t)}>
              {t.label}
            </button>
          ))}
          <button className="mini" disabled={busy} onClick={() => void applySmart()} title="Auto-detect and decode repeatedly">
            ✨ Smart decode
          </button>
        </div>
        <span className="decoder-label">Output</span>
        <textarea
          value={selectedStep ? selectedStep.text : ''}
          spellCheck={false}
          readOnly
          placeholder="transform results appear here…"
        />
        {state.steps.length > 0 && (
          <div className="decoder-history">
            {state.steps
              .map((st, i) => (
                <div
                  key={i}
                  className={`decoder-step ${state.selected === i ? 'on' : ''}`}
                  onClick={() => save({ selected: i })}
                  title={st.text.slice(0, 200)}
                >
                  <span className="n">{i + 1}</span> {st.label}
                  <span className="grow" style={{ flex: 1 }} />
                  <span className="n">{st.text.length} ch</span>
                </div>
              ))
              .reverse()}
          </div>
        )}
        <div className="decoder-actions">
          <button
            className="mini"
            disabled={!selectedStep}
            onClick={() => selectedStep && save({ input: selectedStep.text, steps: [], selected: null })}
          >
            ↻ Use output as input
          </button>
          <button className="mini" onClick={() => save({ steps: [], selected: null })} disabled={state.steps.length === 0}>
            Clear history
          </button>
          <button
            className="mini"
            disabled={!selectedStep}
            onClick={() => selectedStep && void navigator.clipboard?.writeText(selectedStep.text)}
          >
            Copy output
          </button>
        </div>
      </div>
    </div>
  )
}
