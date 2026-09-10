// Tiny modal prompt (Confirm's sibling) for one-line input — flow notes.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon'

export default function InputDialog({
  title,
  label,
  initial = '',
  submitLabel = 'Save',
  onSubmit,
  onClose,
}: {
  title: string
  label?: string
  initial?: string
  submitLabel?: string
  onSubmit: (value: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const submit = () => {
    onSubmit(value)
    onClose()
  }
  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title} style={{ width: 420 }}>
        <h3>
          <Icon name="tag" size={15} />
          {title}
        </h3>
        {label && <p>{label}</p>}
        <input
          ref={ref}
          className="input mono"
          style={{ width: '100%' }}
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onClose()
          }}
        />
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn sm" onClick={submit}>{submitLabel}</button>
          <button className="btn ghost sm" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
