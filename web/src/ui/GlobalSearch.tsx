// Global deep search (Ctrl+Shift+F or the toolbar button): one keyword,
// everything Pulse has captured — traffic requests/responses and Repeater
// records. Rendered through a portal (ancestor transforms trap fixed
// overlays); results jump straight to the flow inspector or Repeater tab.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon'
import { deepSearch } from '../api'
import type { SearchHit } from '../types'

export default function GlobalSearch() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onOpen = () => {
      setOpen(true)
      setHits(null)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
    window.addEventListener('pulse:open-search', onOpen)
    return () => window.removeEventListener('pulse:open-search', onOpen)
  }, [])

  const close = () => {
    setOpen(false)
    setQ('')
    setHits(null)
  }

  const run = async () => {
    const needle = q.trim()
    if (!needle) return
    setBusy(true)
    try {
      const r = await deepSearch(needle)
      setHits(r.hits)
    } catch {
      setHits([])
    } finally {
      setBusy(false)
    }
  }

  const jump = (h: SearchHit) => {
    close()
    window.history.replaceState(null, '', h.source === 'traffic' ? `#/proxy?flow=${h.id}` : `#/repeater?tab=${h.id}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }

  if (!open) return null

  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal gsearch-modal" role="dialog" aria-label="Deep search">
        <h4>
          <Icon name="search" size={14} />
          Deep search
          <span className="faint" style={{ fontSize: 11, fontWeight: 400 }}>
            traffic + repeater · requests & responses
          </span>
        </h4>
        <div className="gsearch-bar">
          <input
            ref={inputRef}
            className="input mono"
            placeholder="Keyword — token, header, path, anything…"
            value={q}
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void run()
              if (e.key === 'Escape') close()
            }}
          />
          <button className="btn sm" disabled={busy || !q.trim()} onClick={run}>
            {busy ? <span className="spinner" /> : <Icon name="search" size={12} />}
            Search
          </button>
        </div>
        <div className="gsearch-results">
          {hits === null && <div className="gsearch-empty">Enter a keyword — bodies, headers, URLs and Repeater history are all scanned.</div>}
          {hits !== null && hits.length === 0 && <div className="gsearch-empty">No match. Try a shorter keyword.</div>}
          {hits?.map((h) => (
            <button key={`${h.source}:${h.id}`} className="gsearch-hit" onClick={() => jump(h)} title="Jump to it">
              <span className={`src-tag ${h.source}`}>{h.source}</span>
              <span className="title mono">{h.title}</span>
              <span className={`side-tag ${h.side}`}>{h.side}</span>
              {h.statusCode !== undefined && h.statusCode > 0 && <span className={`mono st-${Math.floor(h.statusCode / 100)}xx`}>{h.statusCode}</span>}
              {h.snippet && <span className="snippet mono">{h.snippet}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}
