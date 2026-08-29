import { useEffect, useMemo, useState } from 'react'
import RequestEditor, { editorStateFrom, editorToRequest, type EditorState } from '../components/RequestEditor'
import { ResponseInspector } from '../components/MessageViewer'
import Split from '../ui/Split'
import Icon from '../ui/Icon'
import Empty from '../ui/Empty'
import { confirm } from '../ui/Confirm'
import ContextMenu, { type MenuItem } from '../components/ContextMenu'
import MarkEditor, { type Mark } from '../ui/MarkEditor'
import { colorTriplet } from '../ui/palette'
import { copyToClipboard } from '../api'
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
  const tabs = pulse.repeaterTabs
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [marks, setMarks] = useState<Record<string, Mark>>(loadMarks)
  const [menu, setMenu] = useState<{ x: number; y: number; tab: RepeaterTab } | null>(null)
  const [markFor, setMarkFor] = useState<{ x: number; y: number; tab: RepeaterTab } | null>(null)

  const currentId = selected ?? tabs[0]?.id ?? null
  const tab = tabs.find((t) => t.id === currentId) ?? null

  const [editor, setEditor] = useState<EditorState | null>(null)
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

  useEffect(() => {
    if (!tab) {
      setEditor(null)
      return
    }
    // load editor from the tab unless we're already editing this tab
    setEditor((prev: TaggedEditor | null) =>
      prev && currentId === prev.__id ? prev : withId(editorStateFrom(tab.request), currentId),
    )
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
    if (!currentId || !editor) return
    const req = editorToRequest(editor)
    if ('error' in req) {
      setErr(req.error)
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await pulse.repeaterSend(currentId, req)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    const t = tabs.find((x) => x.id === id)
    const ok = await confirm({
      title: 'Delete Repeater tab?',
      message: `Removes the saved request ${t ? `«${t.title}»` : ''} and its last response.`,
      confirmLabel: 'Delete tab',
      danger: true,
    })
    if (!ok) return
    await pulse.repeaterDelete(id)
    setSelected(null)
  }

  // Ctrl/Cmd+Enter sends from anywhere in this view
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        void send()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, editor, busy])

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
      onClick: () => setMarkFor({ ...menuPosOf(t.id), tab: t }),
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
        if (await copyToClipboard(t.request.url)) pulse.notify('URL copied')
      },
    },
    {
      icon: 'link',
      label: 'Copy link to this tab',
      onClick: async () => {
        if (await copyToClipboard(`${location.origin}/#/repeater?tab=${t.id}`)) pulse.notify('Link copied')
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

  // position helper for the mark editor: open near the tab row
  const menuPosOf = (id: string) => {
    const el = document.querySelector(`[data-tab-id="${id}"]`)
    if (!el) return { x: 300, y: 300 }
    const r = el.getBoundingClientRect()
    return { x: r.right + 8, y: r.top }
  }

  const resp = tab?.lastResponse
  const currentMark = currentId ? marks[currentId] : undefined

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
                  style={{ width: '100%', paddingLeft: 26, paddingRight: 8, fontSize: 12 }}
                  placeholder="Filter tabs…"
                  value={search}
                  spellCheck={false}
                  onChange={(e) => setSearch(e.target.value)}
                />
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
                              background: `rgb(${colorTriplet(mark.color)} / 0.08)`,
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
                        <span className={`method-${t.request.method}`}>{t.request.method}</span>
                        {t.lastResponse && (
                          <span className={`status${Math.floor(t.lastResponse.statusCode / 100)}`} style={{ fontWeight: 700 }}>
                            {t.lastResponse.statusCode}
                          </span>
                        )}
                        <span className="id">{t.id.replace('tab-', '')}</span>
                      </div>
                      <div className="l2" title={t.title}>
                        {t.title}
                      </div>
                      {mark && (
                        <div className="l2" style={{ paddingTop: 2 }}>
                          <span
                            className="mark-chip"
                            style={{
                              color: mark.color,
                              background: `rgb(${colorTriplet(mark.color)} / 0.12)`,
                              border: `1px solid rgb(${colorTriplet(mark.color)} / 0.35)`,
                            }}
                          >
                            <span className="hl-dot" style={{ background: mark.color, margin: 0 }} />
                            {mark.text}
                          </span>
                        </div>
                      )}
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
                    color: currentMark.color,
                    background: `rgb(${colorTriplet(currentMark.color)} / 0.12)`,
                    border: `1px solid rgb(${colorTriplet(currentMark.color)} / 0.35)`,
                  }}
                  title="Tab mark"
                >
                  <span className="hl-dot" style={{ background: currentMark.color, margin: 0 }} />
                  {currentMark.text}
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
              {tab && (
                <button
                  className="btn ghost sm icon-btn"
                  title="Copy a link that opens this tab selected"
                  onClick={() => {
                    void copyToClipboard(`${location.origin}/#/repeater?tab=${tab.id}`).then(
                      (ok) => ok && pulse.notify('Link copied'),
                    )
                  }}
                >
                  <Icon name="link" size={13} />
                </button>
              )}
            </div>
            <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', padding: 0 }}>
              {editor ? (
                <Split
                  dir="v"
                  storageKey="pulse.split.repeater"
                  initial={0.55}
                  a={<RequestEditor state={editor} onChange={(next) => setEditor(withId(next, currentId))} />}
                  b={<ResponseInspector resp={resp} />}
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

// tiny helper: tag editor state with the tab it belongs to so switching tabs
// reloads content while typing in the same tab does not
type TaggedEditor = EditorState & { __id?: string | null }
function withId(st: EditorState, id: string | null): TaggedEditor {
  return { ...st, __id: id }
}
