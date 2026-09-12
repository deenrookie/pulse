// Global deep search (Ctrl+Shift+F or the toolbar button): one keyword,
// everything Pulse has captured — traffic requests/responses and Repeater
// records. Floating Decoder-style windows; several can coexist (one per
// footer history tab, plus fresh ones from the top entry). Dragging,
// resizing, pin/ghost and the preview pane (click a hit to see it with
// every match highlighted — nothing navigates away) behave like Decoder.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon'
import { deepSearch, getFlow, listRepeater, rawOfMessage, bodyToText } from '../api'
import type { SearchOptions } from '../api'
import { pushSearchHistory, renameSearchHistory } from './searchHistory'
import { getSelected, setSelected } from './searchSel'
import type { SearchHit, Flow, RepeaterTab } from '../types'

const WIN_KEY = 'pulse.gsearch.win'

interface WinState {
  x: number
  y: number
  w: number
  h: number
  mode: 'top' | 'ghost'
}
const WIN_DEFAULTS: WinState = { x: 170, y: 90, w: 880, h: 540, mode: 'top' }

function loadWin(): WinState {
  try {
    const raw = JSON.parse(localStorage.getItem(WIN_KEY) ?? 'null')
    if (raw && typeof raw.x === 'number') return { ...WIN_DEFAULTS, ...raw }
  } catch {
    /* corrupted */
  }
  return { ...WIN_DEFAULTS }
}

function persistWin(w: WinState) {
  try {
    localStorage.setItem(WIN_KEY, JSON.stringify(w))
  } catch {
    /* storage unavailable */
  }
}

// last-used Burp-style options, shared by every search window
const OPTS_KEY = 'pulse.gsearch.opts'

function loadOpts(): SearchOptions {
  try {
    const raw = JSON.parse(localStorage.getItem(OPTS_KEY) ?? 'null')
    if (raw && typeof raw === 'object') {
      const o = raw as SearchOptions
      if (o.side === 'request' || o.side === 'response') return { side: o.side, cs: !!o.cs, re: !!o.re }
      return { cs: !!o.cs, re: !!o.re }
    }
  } catch {
    /* corrupted */
  }
  return {}
}

function persistOpts(o: SearchOptions) {
  try {
    localStorage.setItem(OPTS_KEY, JSON.stringify(o))
  } catch {
    /* storage unavailable */
  }
}

/** the full message pair behind a hit, for the preview pane */
interface HitDetail {
  hit: SearchHit
  requestText: string
  responseText: string | null
}

async function loadDetail(hit: SearchHit): Promise<HitDetail> {
  if (hit.source === 'traffic') {
    const fl: Flow = await getFlow(hit.id)
    const req = rawOfMessage(
      `${fl.request.method} ${fl.request.url}`,
      fl.request.headers ?? [],
      bodyToText(fl.request.body),
    )
    const resp = fl.response
      ? rawOfMessage(`${fl.response.statusCode} ${fl.response.reason ?? ''}`, fl.response.headers ?? [], bodyToText(fl.response.body))
      : null
    return { hit, requestText: req, responseText: resp }
  }
  const { tabs } = await listRepeater()
  const tab: RepeaterTab | undefined = tabs.find((t) => t.id === hit.id)
  const req = tab
    ? rawOfMessage(`${tab.request.method} ${tab.request.url}`, tab.request.headers ?? [], bodyToText(tab.request.body))
    : '(repeater tab gone)'
  const resp = tab?.lastResponse
    ? rawOfMessage(`${tab.lastResponse.statusCode} ${tab.lastResponse.reason ?? ''}`, tab.lastResponse.headers ?? [], bodyToText(tab.lastResponse.body))
    : null
  return { hit, requestText: req, responseText: resp }
}

/** clamp huge bodies to a window around the first match, highlight hits */
function Highlighted({ text, needle, opts }: { text: string; needle: string; opts: SearchOptions }) {
  // build one splitter regex honouring the case/regex options; invalid
  // patterns (user still typing) fall back to a plain escaped substring
  const src = opts.re ? `(${needle})` : `(${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`
  let splitter: RegExp
  try {
    splitter = new RegExp(src, opts.cs ? '' : 'i')
  } catch {
    splitter = new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, opts.cs ? '' : 'i')
  }
  let t = text
  if (t.length > 24000) {
    const m = splitter.exec(t)
    const start = Math.max(0, (m ? m.index : 0) - 5000)
    t = (start > 0 ? '…\n' : '') + t.slice(start, start + 18000) + (start + 18000 < text.length ? '\n…' : '')
  }
  const parts = t.split(splitter)
  if (opts.re) {
    // regex mode: re-test each split part instead of comparing literals
    const exact = new RegExp(`^(?:${needle})$`, opts.cs ? '' : 'i')
    return (
      <>
        {parts.map((p, i) => (p && exact.test(p) ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}
      </>
    )
  }
  const lower = needle.toLowerCase()
  return (
    <>
      {parts.map((p, i) =>
        needle && p.toLowerCase() === lower ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>,
      )}
    </>
  )
}

interface Session {
  id: string
  /** keyword identity for "this window is already open" checks ('' = fresh) */
  keyword: string
  /** the footer history tab this window owns ('' = none yet). Windows
   * re-searching a new keyword rename their tab instead of adding one. */
  tabKw: string
  initialQ: string
  autoRun: boolean
  /** only windows opened from the top entry create footer history tabs */
  tracksHistory: boolean
  z: number
  /** cascade offset so stacked windows don't cover each other exactly */
  cascade: number
}

// ---------- one search window ----------

function SearchWindow({
  session,
  onFocus,
  onClose,
  onSearched,
}: {
  session: Session
  onFocus: () => void
  onClose: () => void
  /** report the window's keyword identity so footer tabs focus it */
  onSearched: (q: string) => void
}) {
  const [q, setQ] = useState(session.initialQ)
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [opts, setOpts] = useState<SearchOptions>(loadOpts)
  const needleRef = useRef(session.initialQ)
  const tabKwRef = useRef(session.tabKw)
  const resultsRef = useRef<HTMLDivElement | null>(null)
  const [win, setWin] = useState<WinState>(() => {
    const w = loadWin()
    const off = (session.cascade % 6) * 28
    return { ...w, x: w.x + off, y: w.y + off }
  })
  const [detail, setDetail] = useState<HitDetail | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const setOpt = (patch: SearchOptions) =>
    setOpts((prev) => {
      const next = { ...prev, ...patch }
      persistOpts(next)
      return next
    })

  useEffect(() => {
    if (session.autoRun && session.initialQ) void run(session.initialQ)
    requestAnimationFrame(() => inputRef.current?.focus())
    // keep the window on screen if the viewport shrank while it was closed
    const x = Math.min(Math.max(8, win.x), window.innerWidth - 200)
    const y = Math.min(Math.max(8, win.y), window.innerHeight - 120)
    if (x !== win.x || y !== win.y) setWin((prev) => ({ ...prev, x, y }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function run(needleArg?: string) {
    const needle = (needleArg ?? q).trim()
    if (!needle) return
    needleRef.current = needle
    setBusy(true)
    setDetail(null)
    setErr(null)
    try {
      const r = await deepSearch(needle, opts)
      setHits(r.hits)
      onSearched(needle)
      // footer-tab ownership: first search of a top-entry window creates
      // its one tab; every later search renames it (no tab per keyword)
      const owned = tabKwRef.current
      if (!owned && session.tracksHistory) {
        pushSearchHistory(needle)
        tabKwRef.current = needle
      } else if (owned && owned !== needle) {
        renameSearchHistory(owned, needle)
        tabKwRef.current = needle
      }
      // reopened from a footer history tab → jump back to the record the
      // user last selected for this keyword
      if (session.autoRun) {
        const sel = getSelected(needle)
        const hit = sel ? r.hits.find((h) => `${h.source}:${h.id}` === sel) : undefined
        if (hit) {
          preview(hit)
          requestAnimationFrame(() => {
            resultsRef.current
              ?.querySelector(`[data-key="${hit.source}:${hit.id}"]`)
              ?.scrollIntoView({ block: 'nearest' })
          })
        }
      }
    } catch (e) {
      setHits([])
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const preview = (h: SearchHit) => {
    setSelected(needleRef.current, `${h.source}:${h.id}`)
    setDetail(null)
    setDetailBusy(true)
    loadDetail(h)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setDetailBusy(false))
  }

  const jump = (h: SearchHit) => {
    onClose()
    window.history.replaceState(null, '', h.source === 'traffic' ? `#/proxy?flow=${h.id}` : `#/repeater?tab=${h.id}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }

  // ---- window dragging (Decoder pattern) ----
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const onHeadDown = (e: React.PointerEvent) => {
    onFocus()
    if ((e.target as HTMLElement).closest('button, input')) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { dx: e.clientX - win.x, dy: e.clientY - win.y }
    setDragging(true)
  }
  const onHeadMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    const x = Math.min(Math.max(0, e.clientX - dragRef.current.dx), window.innerWidth - 100)
    const y = Math.min(Math.max(0, e.clientY - dragRef.current.dy), window.innerHeight - 60)
    setWin((prev) => ({ ...prev, x, y }))
  }
  const onHeadUp = () => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    persistWin(win)
  }

  // ---- window resizing ----
  const sizeRef = useRef<{ w: number; h: number; x: number; y: number } | null>(null)
  const [resizing, setResizing] = useState(false)
  const onGripDown = (e: React.PointerEvent) => {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    sizeRef.current = { w: win.w, h: win.h, x: e.clientX, y: e.clientY }
    setResizing(true)
  }
  const onGripMove = (e: React.PointerEvent) => {
    const s = sizeRef.current
    if (!s) return
    const w = Math.min(Math.max(520, s.w + e.clientX - s.x), window.innerWidth - win.x - 8)
    const h = Math.min(Math.max(320, s.h + e.clientY - s.y), window.innerHeight - win.y - 8)
    setWin((prev) => ({ ...prev, w, h }))
  }
  const onGripUp = () => {
    if (!sizeRef.current) return
    sizeRef.current = null
    setResizing(false)
    persistWin(win)
  }

  const shownText =
    detail && (detail.hit.side === 'response' ? detail.responseText : detail.requestText)

  return (
    <div
      className={`gsearch-win ${win.mode === 'ghost' ? 'ghost' : ''} ${dragging || resizing ? 'dragging' : ''}`}
      style={{ left: win.x, top: win.y, width: win.w, height: win.h, zIndex: session.z }}
      onPointerDown={onFocus}
    >
      <div
        className="decoder-head"
        onPointerDown={onHeadDown}
        onPointerMove={onHeadMove}
        onPointerUp={onHeadUp}
        title="Drag to move · corner grip resizes"
      >
        <span className="title">
          <Icon name="search" size={14} />
          Deep search
        </span>
        {session.keyword && <span className="faint mono" style={{ fontSize: 11 }}>{session.keyword}</span>}
        <span className="spacer" />
        <button
          className="btn ghost sm icon-btn"
          title={win.mode === 'top' ? 'Pinned on top — click for ghost mode (fades, hover to focus)' : 'Ghost mode — click to pin on top'}
          onClick={() => {
            const mode = win.mode === 'top' ? 'ghost' : 'top'
            setWin((prev) => ({ ...prev, mode }))
            persistWin({ ...win, mode })
          }}
        >
          <Icon name={win.mode === 'top' ? 'shield' : 'circle'} size={13} />
        </button>
        <button className="btn ghost sm icon-btn" title="Close (size and position are kept)" onClick={onClose}>
          <Icon name="x" size={13} />
        </button>
      </div>

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
            if (e.key === 'Escape') onClose()
          }}
        />
        <button className="btn sm" disabled={busy || !q.trim()} onClick={() => void run()}>
          {busy ? <span className="spinner" /> : <Icon name="search" size={12} />}
          Search
        </button>
        <div className="gsearch-opts" title="Burp-style search options">
          <div className="seg">
            {(['all', 'request', 'response'] as const).map((s) => (
              <button
                key={s}
                className={`mini opt ${(opts.side ?? 'all') === s ? 'on' : ''}`}
                title={s === 'all' ? 'Search request and response' : `Search the ${s} side only`}
                onClick={() => setOpt({ side: s === 'all' ? undefined : s })}
              >
                {s === 'all' ? 'All' : s === 'request' ? 'Req' : 'Resp'}
              </button>
            ))}
          </div>
          <button
            className={`mini opt ${opts.cs ? 'on' : ''}`}
            title="Case sensitive"
            onClick={() => setOpt({ cs: !opts.cs })}
          >
            Aa
          </button>
          <button
            className={`mini opt ${opts.re ? 'on' : ''}`}
            title="Regular expression"
            onClick={() => setOpt({ re: !opts.re })}
          >
            .*
          </button>
        </div>
        {hits !== null && (
          <span className="faint" style={{ fontSize: 11, flex: 'none' }}>
            {hits.length} hit{hits.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="gsearch-main">
        <div className="gsearch-results" ref={resultsRef}>
          {hits === null && !err && <div className="gsearch-empty">Enter a keyword — bodies, headers, URLs and Repeater history are all scanned.</div>}
          {err && <div className="gsearch-empty">Search failed — {err}</div>}
          {!err && hits !== null && hits.length === 0 && <div className="gsearch-empty">No match. Try a shorter keyword.</div>}
          {hits?.map((h) => (
            <button
              key={`${h.source}:${h.id}:${h.side}`}
              data-key={`${h.source}:${h.id}`}
              className={`gsearch-hit ${detail?.hit === h ? 'selected' : ''}`}
              onClick={() => preview(h)}
              title="Preview on the right"
            >
              <span className={`src-tag ${h.source}`}>{h.source}</span>
              <span className="title mono">{h.title}</span>
              <span className={`side-tag ${h.side}`}>{h.side}</span>
              {h.statusCode !== undefined && h.statusCode > 0 && <span className={`mono st-${Math.floor(h.statusCode / 100)}xx`}>{h.statusCode}</span>}
              {h.snippet && <span className="snippet mono">{h.snippet}</span>}
            </button>
          ))}
        </div>

        <div className="gsearch-preview">
          {!detail && !detailBusy && (
            <div className="gsearch-empty">
              Click a result to preview it here — the match is highlighted, nothing navigates away.
            </div>
          )}
          {detailBusy && <div className="gsearch-empty">Loading…</div>}
          {detail && (
            <>
              <div className="gs-preview-head">
                <span className={`src-tag ${detail.hit.source}`}>{detail.hit.source}</span>
                <span className="mono faint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={detail.hit.title}>
                  {detail.hit.title}
                </span>
                {detail.responseText && (
                  <button className={`mini ${detail.hit.side === 'response' ? '' : 'faint'}`} onClick={() => setDetail({ ...detail, hit: { ...detail.hit, side: 'response' } })}>
                    response
                  </button>
                )}
                <button className={`mini ${detail.hit.side === 'request' ? '' : 'faint'}`} onClick={() => setDetail({ ...detail, hit: { ...detail.hit, side: 'request' } })}>
                  request
                </button>
                <button className="btn sm" onClick={() => jump(detail.hit)} title="Navigate to this flow / tab">
                  <Icon name="chevronRight" size={12} />
                  Open
                </button>
              </div>
              {shownText !== null ? (
                <pre className="gs-preview-body mono">
                  <Highlighted text={shownText} needle={q.trim() || detail.hit.title.split(/\s+/)[0]} opts={opts} />
                </pre>
              ) : (
                <div className="gsearch-empty">No response for this hit.</div>
              )}
            </>
          )}
        </div>
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

// ---------- the multi-window host ----------

export default function GlobalSearch() {
  const [sessions, setSessions] = useState<Session[]>([])
  const zCounter = useRef(400)

  useEffect(() => {
    const onOpen = (e: Event) => {
      const prefill = (e as CustomEvent<{ q?: string }>).detail?.q?.trim()
      setSessions((prev) => {
        if (prefill) {
          const existing = prev.find((s) => s.keyword === prefill)
          if (existing) {
            // already open: just raise it above the other windows
            zCounter.current += 1
            return prev.map((s) => (s.id === existing.id ? { ...s, z: zCounter.current } : s))
          }
        }
        zCounter.current += 1
        return [
          ...prev,
          {
            id: crypto.randomUUID(),
            keyword: prefill ?? '',
            tabKw: prefill ?? '', // footer-opened windows own the tab they came from
            initialQ: prefill ?? '',
            autoRun: !!prefill,
            tracksHistory: !prefill,
            z: zCounter.current,
            cascade: prev.length,
          },
        ]
      })
    }
    // a footer history tab was removed → its window goes with it
    const onClose = (e: Event) => {
      const q = (e as CustomEvent<{ q?: string }>).detail?.q?.trim()
      if (!q) return
      setSessions((prev) => prev.filter((s) => s.keyword !== q))
    }
    window.addEventListener('pulse:open-search', onOpen)
    window.addEventListener('pulse:close-search', onClose)
    return () => {
      window.removeEventListener('pulse:open-search', onOpen)
      window.removeEventListener('pulse:close-search', onClose)
    }
  }, [])

  // tell the footer which tab belongs to the focused (topmost) window
  useEffect(() => {
    const top = sessions.length ? sessions.reduce((a, b) => (b.z > a.z ? b : a)) : null
    window.dispatchEvent(new CustomEvent('pulse:search-focus', { detail: { q: top?.keyword ?? '' } }))
  }, [sessions])

  const closeSession = (id: string) => setSessions((prev) => prev.filter((s) => s.id !== id))
  const focusSession = (id: string) =>
    setSessions((prev) => {
      const top = Math.max(...prev.map((s) => s.z))
      const hit = prev.find((s) => s.id === id)
      if (!hit || hit.z === top) return prev
      zCounter.current = Math.max(zCounter.current, top) + 1
      return prev.map((s) => (s.id === id ? { ...s, z: zCounter.current } : s))
    })
  const markSearched = (id: string, q: string) =>
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, keyword: q } : s)))

  if (sessions.length === 0) return null

  return createPortal(
    <>
      {sessions.map((s) => (
        <SearchWindow
          key={s.id}
          session={s}
          onFocus={() => focusSession(s.id)}
          onClose={() => closeSession(s.id)}
          onSearched={(q) => markSearched(s.id, q)}
        />
      ))}
    </>,
    document.body,
  )
}
