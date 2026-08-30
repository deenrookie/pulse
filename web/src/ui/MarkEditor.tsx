// Small popover to set a tab mark: free-text label + one of the default
// colors. Marks are frontend-only, persisted per browser.
import { useEffect, useState } from 'react'
import Icon from './Icon'
import { MARK_COLORS } from './palette'

export interface Mark {
  text: string
  color: string
}

export default function MarkEditor({
  initial,
  x,
  y,
  onSave,
  onClose,
}: {
  initial: Mark | null
  x: number
  y: number
  onSave: (mark: Mark | null) => void
  onClose: () => void
}) {
  const [text, setText] = useState(initial?.text ?? '')
  const [color, setColor] = useState(initial?.color ?? '#fb923c')

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

  return (
    <div
      className="popover mark-editor"
      style={{ left: Math.max(8, Math.min(x, window.innerWidth - 340)), top: Math.max(8, Math.min(y, window.innerHeight - 260)), width: 320 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <h4>
        <Icon name="tag" size={14} />
        Mark tab
      </h4>
      <div className="sub">Label optional — a color alone works as an eye-catching marker.</div>
      <input
        className="input"
        style={{ width: '100%' }}
        placeholder="Label (e.g. auth bypass found)"
        value={text}
        spellCheck={false}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave(text.trim() ? { text: text.trim(), color } : null)
        }}
      />
      <div className="swatch-picker" style={{ margin: '12px 0 4px' }}>
        {MARK_COLORS.map((c) => (
          <button
            key={c.id}
            className={`swatch ${color === c.value ? 'on' : ''}`}
            style={{ background: c.value }}
            title={c.label}
            onClick={() => setColor(c.value)}
          />
        ))}
      </div>
      <div className="row2">
        {initial && (
          <button
            className="btn ghost sm"
            onClick={() => onSave(null)}
            style={{ marginRight: 'auto' }}
          >
            Clear mark
          </button>
        )}
        <button className="btn sm" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary sm" onClick={() => onSave({ text: text.trim(), color })}>
          Save mark
        </button>
      </div>
    </div>
  )
}
