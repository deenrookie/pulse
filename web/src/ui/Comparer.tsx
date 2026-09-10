// Comparer — Burp-style: paste two raw messages, see the word-aware line
// diff. A floating card like the Decoder; inputs persist per browser.
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon'
import { DiffView } from './Diff'

const LS_KEY = 'pulse.comparer'

export default function Comparer({ onClose }: { onClose: () => void }) {
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [showDiff, setShowDiff] = useState(false)

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null')
      if (saved) {
        setA(saved.a ?? '')
        setB(saved.b ?? '')
      }
    } catch {
      /* ignore */
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ a, b }))
    } catch {
      /* ignore */
    }
  }, [a, b])

  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal comparer-modal" role="dialog" aria-label="Comparer">
        <h3>
          <Icon name="arrowDownUp" size={15} />
          Comparer
          <span className="faint" style={{ fontSize: 11, fontWeight: 400, marginLeft: 8 }}>
            two raw messages → word-aware diff
          </span>
        </h3>
        <div className="comparer-inputs">
          <textarea
            className="cfg-src"
            value={a}
            spellCheck={false}
            placeholder="paste the first message…"
            onChange={(e) => setA(e.target.value)}
          />
          <textarea
            className="cfg-src"
            value={b}
            spellCheck={false}
            placeholder="paste the second message…"
            onChange={(e) => setB(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
          <button className="btn primary sm" disabled={!a && !b} onClick={() => setShowDiff(true)}>
            <Icon name="arrowDownUp" size={13} />
            Compare
          </button>
          <button
            className="btn ghost sm"
            onClick={() => {
              setA('')
              setB('')
              setShowDiff(false)
            }}
          >
            Clear
          </button>
          <div className="spacer" style={{ flex: 1 }} />
          <button className="btn ghost sm" onClick={onClose}>
            Close
          </button>
        </div>
        {showDiff && (a || b) && (
          <div className="comparer-diff">
            <DiffView a={a} b={b} labelA="first" labelB="second" />
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
