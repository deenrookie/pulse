// Draggable split layout. First pane is controlled (persisted fraction),
// second pane fills the rest. Double-click the splitter to reset.
import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from 'react'

interface Props {
  dir: 'h' | 'v'
  storageKey: string
  initial?: number
  min?: number
  max?: number
  a: ReactNode
  b: ReactNode
  className?: string
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

export default function Split({ dir, storageKey, initial = 0.55, min = 0.15, max = 0.85, a, b, className }: Props) {
  const saved = (() => {
    try {
      const v = localStorage.getItem(storageKey)
      return v !== null ? clamp(parseFloat(v), min, max) : initial
    } catch {
      return initial
    }
  })()
  const [frac, setFrac] = useState(saved)
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const apply = useCallback(
    (clientX: number, clientY: number) => {
      const el = ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const f = dir === 'h' ? (clientX - r.left) / r.width : (clientY - r.top) / r.height
      setFrac(clamp(f, min, max))
    },
    [dir, min, max],
  )

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging) apply(e.clientX, e.clientY)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging) return
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    setDragging(false)
    try {
      localStorage.setItem(storageKey, String(frac))
    } catch {
      /* private mode */
    }
  }

  const reset = () => {
    setFrac(initial)
    try {
      localStorage.removeItem(storageKey)
    } catch {
      /* ignore */
    }
  }

  const paneStyle: CSSProperties =
    dir === 'h' ? { width: `${frac * 100}%` } : { height: `${frac * 100}%` }

  return (
    <div ref={ref} className={`split split-${dir} ${className ?? ''}`}>
      <div className="pane" style={paneStyle}>
        {a}
      </div>
      <div
        className={`splitter ${dragging ? 'dragging' : ''}`}
        role="separator"
        aria-orientation={dir === 'h' ? 'vertical' : 'horizontal'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={reset}
        title="Drag to resize · double-click to reset"
      />
      <div className="pane" style={{ flex: 1 }}>
        {b}
      </div>
    </div>
  )
}
