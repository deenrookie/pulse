import { useEffect, useMemo, useState } from 'react'
import { rawToRequest, requestToRaw } from '../components/RawEditor'
import { RequestInspector } from '../components/MessageViewer'
import { ResponseInspector } from '../components/MessageViewer'
import Split from '../ui/Split'
import Icon from '../ui/Icon'
import Empty from '../ui/Empty'
import ContextMenu, { type MenuItem } from '../components/ContextMenu'
import MarkEditor, { type Mark } from '../ui/MarkEditor'
import { colorTriplet } from '../ui/palette'
import { copyToClipboard, createRepeaterTab, listRepeater } from '../api'
import type { PulseState } from '../state'
import type { RepeaterTab } from '../types'

const MARKS_KEY = 'pulse.marks'

function loadMarks(): Record<string, Mark> {
  try {
    const raw = JSON.parse(localStorage.getItem(MARKS_KEY) ?? '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

/** view params from the address bar: #/repeater?tab=tab-3 */
function viewParam(name: string): string | null {
  const h = window.location.hash
  const q = h.includes('?') ? h.slice(h.indexOf('?') + 1) : ''
  return new URLSearchParams(q).get(name)
}

export default function RepeaterView({ pulse, goProxy }: { pulse: PulseState; goProxy: () => void }) {
  const [tabsMirror, setRepeaterTabsDirect] = useState<RepeaterTab[] | null>(null)
  const tabs = tabsMirror ?? pulse.repeaterTabs
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [marks, setMarks] = useState<Record<string, Mark>>(loadMarks)
  const [menu, setMenu] = useState<{ x: number; y: number; tab: RepeaterTab } | null>(null)
  const [markFor, setMarkFor] = useState<{ x: number; y: number; tab: RepeaterTab } | null>(null)

  const currentId = selected ?? tabs[0]?.id ?? null
  const tab = tabs.find((t) => t.id === currentId) ?? null

  // raw request buffer, tagged with the tab it belongs to so switching tabs
  // reloads it while typing in the same tab does not
  const [raw, setRaw] = useState<{ text: string; __id: string | null } | null>(null)
  // response history navigation (Burp-style): index into tab.history; null = latest
  const [histIdx, setHistIdx] = useState<number | null>(null)
  const [sentAt, setSentAt] = useState<number>(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const saveMarks = (next: Record<string, Mark>) => {
    setMarks(next)
    try {
      localStorage.setItem(MARKS_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }

  // keep the mirror in sync; pulse updates (delete/send) reset it
  useEffect(() => {
    setRepeaterTabsDirect((m) => (m && m.length !== pulse.repeaterTabs.length ? null : m))
  }, [pulse.repeaterTabs])

  // deep link: #/repeater?tab=<id>
  useEffect(() => {
    const apply = () => {
      const id = viewParam('tab')
      if (id) setSelected(id)
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [])

  // entering the Repeater view: if a send-to-repeater happened since the last
  // visit, focus the newest tab; otherwise restore the last-operated one
  useEffect(() => {
    let jump = false
    try {
      jump = localStorage.getItem('pulse.repeater.jumpNewest') === '1'
      if (jump) localStorage.removeItem('pulse.repeater.jumpNewest')
    } catch {
      /* ignore */
    }
    if (viewParam('tab')) return // explicit deep link wins
    if (tabs.length === 0) return
    if (jump) {
      const newest = tabs.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b))
      setSelected(newest.id)
      return
    }
    try {
      const saved = localStorage.getItem('pulse.repeater.selected')
      if (saved && tabs.some((t) => t.id === saved)) {
        setSelected(saved)
        return
      }
    } catch {
      /* ignore */
    }
    setSelected(null) // falls back to tabs[0]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // remember the operated tab so a plain revisit restores it
  useEffect(() => {
    if (currentId) {
      try {
        localStorage.setItem('pulse.repeater.selected', currentId)
      } catch {
        /* ignore */
      }
    }
  }, [currentId])

  // address bar mirrors the selected tab (replaceState fires no hashchange)
  useEffect(() => {
    const base = '#/repeater'
    const next = currentId ? `${base}?tab=${currentId}` : base
    if (window.location.hash !== next) window.history.replaceState(null, '', next)
  }, [currentId])

  useEffect(() => {
    setHistIdx(null)
    if (!tab) {
      setRaw(null)
      return
    }
    setRaw((prev) => (prev && prev.__id === currentId ? prev : { text: requestToRaw(tab.request), __id: currentId }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, tab?.updatedAt])

  const filteredTabs = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return tabs
    return tabs.filter((t) => {
      const mark = marks[t.id]
      return `${t.request.method} ${t.request.url} ${t.title} ${mark ? mark.text : ''}`.toLowerCase().includes(needle)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, search, marks])

  const send = async () => {
    if (!currentId || !raw || !tab) return
    const req = rawToRequest(raw.text, tab.request.url)
    setBusy(true)
    setErr(null)
    setSentAt(Date.now())
    try {
      await pulse.repeaterSend(currentId, req)
      setHistIdx(null) // follow the newest response
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // quick delete: no confirmation — the tab list is long and deletes are frequent
  const remove = async (id: string) => {
    await pulse.repeaterDelete(id)
    pulse.notify('Tab deleted')
    if (selected === id) setSelected(null)
  }

  const duplicateCurrent = async () => {
    if (!raw || !tab) return
    const parsed = rawToRequest(raw.text, tab.request.url)
    const t = await createRepeaterTab({ request: parsed })
    const r = await listRepeater()
    setRepeaterTabsDirect(r.tabs)
    setSelected(t.id)
    pulse.notify(`Duplicated to ${t.id}`)
  }

  // Ctrl/Cmd+Enter sends; Ctrl+R (and the raw context menu) duplicate the tab
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        void send()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r' && raw && tab) {
        e.preventDefault()
        e.stopPropagation()
        void duplicateCurrent()
      }
    }
    const onSend = () => void duplicateCurrent()
    window.addEventListener('keydown', onKey, true) // capture: wins over the global handler
    window.addEventListener('pulse:send-to-repeater', onSend)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pulse:send-to-repeater', onSend)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, raw, busy, tab])

  const markPosOf = (id: string) => {
    const el = document.querySelector(`[data-tab-id="${id}"]`)
    if (!el) return { x: 300, y: 300 }
    const r = el.getBoundingClientRect()
    return { x: r.right + 8, y: r.top }
  }

  const tabMenu = (t: RepeaterTab): MenuItem[] => [
    {
      icon: 'play',
      label: 'Send now',
      disabled: t.id !== currentId,
      hint: '⌃↵',
      onClick: () => {
        setSelected(t.id)
        void send()
      },
    },
    {
      icon: 'tag',
      label: marks[t.id] ? 'Edit mark' : 'Mark…',
      separatorAfter: true,
      onClick: () => setMarkFor({ ...markPosOf(t.id), tab: t }),
    },
    ...(marks[t.id]
      ? [
          {
            icon: 'x' as const,
            label: 'Clear mark',
            onClick: () => {
              const next = { ...marks }
              delete next[t.id]
              saveMarks(next)
            },
          } as MenuItem,
        ]
      : []),
    {
      icon: 'copy',
      label: 'Copy URL',
      separatorAfter: true,
      onClick: async () => {
        await copyToClipboard(t.request.url, { label: 'URL' })
      },
    },
    {
      icon: 'link',
      label: 'Copy link to this tab',
      onClick: async () => {
        await copyToClipboard(`${location.origin}/#/repeater?tab=${t.id}`, { label: 'link' })
      },
    },
    {
      icon: 'trash',
      label: 'Delete tab',
      danger: true,
      separatorAfter: true,
      onClick: () => void remove(t.id),
    },
  ]

  const hist = tab?.history ?? []
  const shownIdx = histIdx === null ? hist.length - 1 : histIdx
  const entry = hist.length > 0 ? hist[shownIdx] : null
  const resp = entry ? entry.response : tab?.lastResponse
  const respError = entry && !entry.response ? entry.error : undefined
  const currentMark = currentId ? marks[currentId] : undefined

  // parse the edited raw into a request-like object for the shared inspector
  const reqView = useMemo(() => {
    if (!raw || !tab) return tab ? tab.request : null
    const parsed = rawToRequest(raw.text, tab.request.url)
    if ('error' in parsed) return tab.request // fall back to the saved shape while typing
    return {
      method: parsed.method,
      url: parsed.url,
      httpVersion: parsed.httpVersion,
      headers: parsed.headers,
      body: parsed.body,
      truncated: false,
      timestamp: tab.request.timestamp,
      id: tab.request.id,
      source: tab.request.source,
    }
  }, [raw, tab])

  return (
    <div className="view padded row">
      <Split
        dir="h"
        storageKey="pulse.split.reptrail"
        initial={0.17}
        min={0.08}
        max={0.45}
        a={
          <div className="panel" style={{ flex: 1 }}>
            <div className="panel-head">
              <span className="title">Tabs</span>
              <span className="badge">{tabs.length || ''}</span>
              <div className="spacer" />
              <button
                className="btn ghost sm icon-btn"
                title="New blank request tab"
                onClick={() => {
                  void pulse.newRepeaterTab().then((id) => {
                    if (id) setSelected(id)
                  })
                }}
              >
                <Icon name="plus" size={14} />
              </button>
            </div>
            <div className="side-search">
              <div className="search-box" style={{ display: 'flex', flex: 1 }}>
                <Icon name="search" size={12} />
                <input
                  className="input"
                  style={{ width: '100%', paddingLeft: 26, paddingRight: 26, fontSize: 12 }}
                  placeholder="Filter tabs…"
                  value={search}
                  spellCheck={false}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button className="clear-btn" title="Clear filter" onClick={() => setSearch('')}>
                    <Icon name="x" size={11} />
                  </button>
                )}
              </div>
            </div>
            <div className="panel-body">
              {tabs.length === 0 ? (
                <Empty icon="repeat" title="No Repeater tabs">
                  Pick a flow in Live Traffic and use
                  <br />
                  “Send to Repeater”, or start a blank tab.
                  <button className="btn sm" style={{ marginTop: 6 }} onClick={goProxy}>
                    <Icon name="waves" size={13} />
                    Go to traffic
                  </button>
                </Empty>
              ) : filteredTabs.length === 0 ? (
                <Empty icon="search" title="No matching tabs" />
              ) : (
                filteredTabs.map((t) => {
                  const mark = marks[t.id]
                  return (
                    <div
                      key={t.id}
                      data-tab-id={t.id}
                      className={`side-item ${currentId === t.id ? 'selected' : ''}`}
                      style={
                        mark
                          ? ({
                              '--hl-bar': mark.color,
                              background: `rgb(${colorTriplet(mark.color)} / ${mark.text ? 0.1 : 0.22})`,
                            } as React.CSSProperties)
                          : undefined
                      }
                      onClick={() => setSelected(t.id)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setSelected(t.id)
                        setMenu({ x: e.clientX, y: e.clientY, tab: t })
                      }}
                      title={`${t.request.url} — right-click for actions`}
                    >
                      <div className="l1">
                        {mark ? (
                          <Icon name="tag" size={11} className="lead-icon marked" style={{ color: mark.color }} />
                        ) : (
                          <Icon name="file" size={11} className="lead-icon" />
                        )}
                        <span className={`method-${t.request.method}`}>{t.request.method}</span>
                        {t.lastResponse && (
                          <span className={`status${Math.floor(t.lastResponse.statusCode / 100)}`} style={{ fontWeight: 700 }}>
                            {t.lastResponse.statusCode}
                          </span>
                        )}
                        <span className="grow" />
                        {mark && (
                          <span className="mark-mini" title={mark.text || 'marked'}>
                            <span className="hl-dot" style={{ background: mark.color, margin: 0 }} />
                            {mark.text}
                          </span>
                        )}
                        <span className="id">{t.id.replace('tab-', '')}</span>
                        <button
                          className="tab-x"
                          title="Delete tab"
                          onClick={(e) => {
                            e.stopPropagation()
                            void remove(t.id)
                          }}
                        >
                          <Icon name="x" size={11} />
                        </button>
                      </div>
                      <div className="l2" title={t.title}>
                        {t.title}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        }
        b={
          <div className="panel" style={{ flex: 1 }}>
            <div className="panel-head">
              {/* common actions live left, next to the title */}
              <button className="btn primary" disabled={!tab || busy} onClick={send} title="Ctrl+Enter">
                {busy ? <span className="spinner" /> : <Icon name="play" size={13} />}
                Send
                <kbd>⌃↵</kbd>
              </button>
              <button className="btn danger sm" disabled={!tab} onClick={() => currentId && remove(currentId)}>
                <Icon name="trash" size={13} />
                Delete
              </button>
              {currentMark && (
                <span
                  className="mark-chip"
                  style={{
                    background: `rgb(${colorTriplet(currentMark.color)} / 0.22)`,
                    border: `1px solid ${currentMark.color}`,
                  }}
                  title={currentMark.text || 'marked'}
                >
                  <span className="hl-dot" style={{ background: currentMark.color, margin: 0 }} />
                  {currentMark.text || 'marked'}
                </span>
              )}
              <div className="spacer" />
              {err && (
                <span className="err-inline" title={err}>
                  <Icon name="alert" size={13} />
                  {err}
                </span>
              )}
              <span className="meta">{tab ? tab.id : ''}</span>
              {hist.length > 0 && (
                <span className="hist-nav" key={sentAt}>
                  <button
                    className="btn ghost sm icon-btn"
                    title="Previous response"
                    disabled={shownIdx <= 0}
                    onClick={() => setHistIdx(Math.max(0, shownIdx - 1))}
                  >
                    <Icon name="chevronsLeft" size={12} />
                  </button>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
                    {shownIdx + 1}/{hist.length}
                  </span>
                  <button
                    className="btn ghost sm icon-btn"
                    title="Next response"
                    disabled={histIdx === null}
                    onClick={() => setHistIdx(shownIdx + 1 >= hist.length ? null : shownIdx + 1)}
                  >
                    <Icon name="chevronRight" size={12} />
                  </button>
                </span>
              )}
              {tab && (
                <button
                  className="btn ghost sm icon-btn"
                  title="Copy a link that opens this tab selected"
                  onClick={() => {
                    void copyToClipboard(`${location.origin}/#/repeater?tab=${tab.id}`, { label: 'link' })
                  }}
                >
                  <Icon name="link" size={13} />
                </button>
              )}
            </div>
            <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', padding: 0 }}>
              {raw ? (
                <Split
                  dir="v"
                  storageKey="pulse.split.repeater"
                  initial={0.55}
                  a={
                    reqView ? (
                      <RequestInspector
                        req={reqView}
                        raw={raw.text}
                        onRawChange={(text) => setRaw({ text, __id: currentId })}
                      />
                    ) : null
                  }
                  b={<ResponseInspector resp={resp} error={respError} />}
                />
              ) : (
                <Empty icon="repeat" title="Create a tab first">
                  Send a flow here from Live Traffic, or press + for a blank request.
                </Empty>
              )}
            </div>
          </div>
        }
      />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={tabMenu(menu.tab)} onClose={() => setMenu(null)} />}
      {markFor && (
        <MarkEditor
          initial={marks[markFor.tab.id] ?? null}
          x={markFor.x}
          y={markFor.y}
          onSave={(mark) => {
            const next = { ...marks }
            if (mark) next[markFor.tab.id] = mark
            else delete next[markFor.tab.id]
            saveMarks(next)
            setMarkFor(null)
          }}
          onClose={() => setMarkFor(null)}
        />
      )}
    </div>
  )
}
