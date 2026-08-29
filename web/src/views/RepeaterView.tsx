import { useEffect, useState } from 'react'
import RequestEditor, { editorStateFrom, editorToRequest, type EditorState } from '../components/RequestEditor'
import { ResponseInspector } from '../components/MessageViewer'
import Split from '../ui/Split'
import Icon from '../ui/Icon'
import Empty from '../ui/Empty'
import { confirm } from '../ui/Confirm'
import type { PulseState } from '../state'

export default function RepeaterView({ pulse, goProxy }: { pulse: PulseState; goProxy: () => void }) {
  const tabs = pulse.repeaterTabs
  const [selected, setSelected] = useState<string | null>(null)
  const currentId = selected ?? tabs[0]?.id ?? null
  const tab = tabs.find((t) => t.id === currentId) ?? null

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

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

  const remove = async () => {
    if (!currentId) return
    const t = tabs.find((x) => x.id === currentId)
    const ok = await confirm({
      title: 'Delete Repeater tab?',
      message: `Removes the saved request ${t ? `«${t.title}»` : ''} and its last response.`,
      confirmLabel: 'Delete tab',
      danger: true,
    })
    if (!ok) return
    await pulse.repeaterDelete(currentId)
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

  const resp = tab?.lastResponse

  return (
    <div className="view padded row">
      <div className="panel side-list">
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
          ) : (
            tabs.map((t) => (
              <div
                key={t.id}
                className={`side-item ${currentId === t.id ? 'selected' : ''}`}
                onClick={() => setSelected(t.id)}
                title={t.request.url}
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
              </div>
            ))
          )}
        </div>
      </div>

      <div className="panel" style={{ flex: 1 }}>
        <div className="panel-head">
          <span className="title">Request</span>
          {tab && <span className="meta">{tab.id}</span>}
          <div className="spacer" />
          {err && (
            <span className="err-inline" title={err}>
              <Icon name="alert" size={13} />
              {err}
            </span>
          )}
          <button className="btn danger sm" disabled={!tab} onClick={remove}>
            <Icon name="trash" size={13} />
            Delete
          </button>
          <button className="btn primary" disabled={!tab || busy} onClick={send} title="Ctrl+Enter">
            {busy ? <span className="spinner" /> : <Icon name="play" size={13} />}
            Send
            <kbd>⌃↵</kbd>
          </button>
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 0 }}>
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
    </div>
  )
}

// tiny helper: tag editor state with the tab it belongs to so switching tabs
// reloads content while typing in the same tab does not
type TaggedEditor = EditorState & { __id?: string | null }
function withId(st: EditorState, id: string | null): TaggedEditor {
  return { ...st, __id: id }
}
