// Promise-based confirm dialog replacing window.confirm.
// Esc / overlay click = cancel, Enter = confirm. Focus starts on the
// destructive/primary action so Enter never fires the wrong choice.
import { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import Icon from './Icon'

export interface ConfirmOptions {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const holder = document.createElement('div')
    document.body.appendChild(holder)
    const done = (v: boolean) => {
      root.unmount()
      holder.remove()
      resolve(v)
    }
    const root = ReactDOM.createRoot(holder)
    root.render(<ConfirmDialog opts={opts} done={done} />)
  })
}

function ConfirmDialog({ opts, done }: { opts: ConfirmOptions; done: (v: boolean) => void }) {
  const [leaving, setLeaving] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)

  // let the exit transition play before resolving
  const close = (v: boolean) => {
    if (leaving) return
    setLeaving(true)
    window.setTimeout(() => done(v), 140)
  }

  useEffect(() => {
    confirmRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close(false)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        close(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving])

  return (
    <div
      className={`modal-overlay ${leaving ? 'leaving' : ''}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close(false)
      }}
    >
      <div className="modal" role="alertdialog" aria-label={opts.title}>
        <h3>
          <Icon name="alert" size={17} />
          {opts.title}
        </h3>
        <p>{opts.message}</p>
        <div className="row">
          <button className="btn" onClick={() => close(false)} autoFocus={false}>
            {opts.cancelLabel ?? 'Cancel'}
          </button>
          <button ref={confirmRef} className={`btn ${opts.danger ? 'danger' : 'primary'}`} onClick={() => close(true)}>
            {opts.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}
