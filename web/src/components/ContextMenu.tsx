import { useEffect, useRef, useState } from 'react'

export interface MenuItem {
  label: string
  onClick: () => void | Promise<void>
  danger?: boolean
  disabled?: boolean
  separatorAfter?: boolean
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

// Lightweight right-click menu: closes on click-away / Escape / scroll.
export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let left = x
    let top = y
    if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8
    if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8
    setPos({ left, top })
  }, [x, y])

  useEffect(() => {
    const onDoc = () => onClose()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onScroll = () => onClose()
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('wheel', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('wheel', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => (
        <div key={i} className="ctx-sep-wrap">
          <button
            className={`ctx-item ${item.danger ? 'danger' : ''}`}
            disabled={item.disabled}
            onMouseUp={(e) => {
              e.stopPropagation()
              if (item.disabled) return
              onClose()
              void item.onClick()
            }}
          >
            {item.label}
          </button>
          {item.separatorAfter && <div className="ctx-sep" />}
        </div>
      ))}
    </div>
  )
}
