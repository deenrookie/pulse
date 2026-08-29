import { useEffect, useState } from 'react'
import RequestEditor, { editorStateFrom, editorToRequest, type EditorState } from '../components/RequestEditor'
import { ResponseInspector } from '../components/MessageViewer'
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
    await pulse.repeaterDelete(currentId)
    setSelected(null)
  }

  return (
    <div className="view" style={{ padding: 10, gap: 10 }}>
      <div className="panel side-list">
        <div className="panel-head">
          <span className="title">Tabs</span>
          <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-faint)' }}>{tabs.length}</span>
          <div className="spacer" />
        </div>
        <div className="panel-body">
          {tabs.length === 0 ? (
            <div className="empty">
              <div className="big">⟳</div>
              <div>
                No Repeater tabs.
                <br />
                Pick a flow in Proxy and press “Send to Repeater”.
              </div>
              <button className="btn sm" onClick={goProxy}>
                Go to Proxy
              </button>
            </div>
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
                  <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>{t.id.replace('tab-', '')}</span>
                </div>
                <div className="l2" title={t.title}>
                  {t.title}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="split-v" style={{ flex: 1, gap: 10 }}>
        <div className="panel" style={{ flex: '1 1 52%' }}>
          <div className="panel-head">
            <span className="title">Request</span>
            {tab && (
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-muted)' }}>{tab.id}</span>
            )}
            <div className="spacer" />
            {err && <span style={{ color: 'var(--danger)', fontSize: 12 }}>{err}</span>}
            <button className="btn danger sm" disabled={!tab} onClick={remove}>
              Delete tab
            </button>
            <button className="btn primary" disabled={!tab || busy} onClick={send} title="Ctrl+Enter">
              {busy ? <span className="spinner" /> : '▶'} Send
            </button>
          </div>
          <div
            className="panel-body"
            style={{ display: 'flex', flexDirection: 'column' }}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault()
                send()
              }
            }}
          >
            {editor ? (
              <RequestEditor
                state={editor}
                onChange={(next) => setEditor(withId(next, currentId))}
                note="Ctrl+Enter to send. Sent flows also appear in the Proxy history (source: rptr)."
              />
            ) : (
              <div className="empty">
                <div className="big">⟳</div>
                <div>Create a tab from Proxy history first.</div>
              </div>
            )}
          </div>
        </div>
        <div style={{ flex: '1 1 48%', minHeight: 0, display: 'flex' }}>
          <ResponseInspector resp={tab?.lastResponse} />
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
