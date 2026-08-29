import { useEffect, useState } from 'react'
import RequestEditor, { editorStateFrom, editorToRequest, type EditorState } from '../components/RequestEditor'
import * as api from '../api'
import type { PulseState } from '../state'
import type { HttpRequest } from '../types'

export default function InterceptView({ pulse }: { pulse: PulseState }) {
  const pending = pulse.intercept.pending
  const [selectedPending, setSelectedPending] = useState<string | null>(null)
  const [heldFull, setHeldFull] = useState<HttpRequest | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const currentId = selectedPending ?? pending[0]?.id ?? null

  useEffect(() => {
    if (!currentId) {
      setHeldFull(null)
      setEditor(null)
      return
    }
    let alive = true
    api
      .getHeldRequest(currentId)
      .then((req) => {
        if (!alive) return
        setHeldFull(req)
        setEditor(editorStateFrom(req))
        setErr(null)
      })
      .catch((e) => alive && setErr(String(e)))
    return () => {
      alive = false
    }
  }, [currentId, pulse.intercept.pending.length])

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      setSelectedPending(null)
      setHeldFull(null)
      setEditor(null)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const onForward = () => {
    if (!currentId || !editor) return
    const req = editorToRequest(editor)
    if ('error' in req) {
      setErr(req.error)
      return
    }
    act(() => pulse.forwardPending(currentId, req))
  }

  const onDrop = () => {
    if (!currentId) return
    act(() => pulse.dropPending(currentId))
  }

  return (
    <div className="view" style={{ padding: 10, gap: 10 }}>
      <div className="panel side-list">
        <div className="panel-head">
          <span className="title">Held requests</span>
          <span className="badge" style={{ background: pending.length ? 'var(--danger)' : 'transparent', color: pending.length ? '#0b0e13' : 'var(--text-faint)' }}>
            {pending.length}
          </span>
          <div className="spacer" />
        </div>
        <div className="panel-body">
          {pending.length === 0 ? (
            <div className="empty">
              <div className="big">{pulse.intercept.enabled ? '⏸️' : '💤'}</div>
              <div>
                {pulse.intercept.enabled
                  ? 'Intercept is on.\nBrowse something — requests will be held here.'
                  : 'Intercept is off.\nToggle it in the header to start holding requests.'}
              </div>
            </div>
          ) : (
            pending.map((p) => (
              <div
                key={p.id}
                className={`side-item ${currentId === p.id ? 'selected' : ''}`}
                onClick={() => setSelectedPending(p.id)}
              >
                <div className="l1">
                  <span className={`method-${p.method}`}>{p.method}</span>
                  <span style={{ color: 'var(--text-faint)' }}>{p.id.replace('req-', '')}</span>
                </div>
                <div className="l2" title={p.url}>
                  {p.url}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="panel" style={{ flex: 1 }}>
        <div className="panel-head">
          <span className="title">Intercepted request</span>
          {heldFull && (
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-muted)' }}>{heldFull.id}</span>
          )}
          <div className="spacer" />
          {err && <span style={{ color: 'var(--danger)', fontSize: 12 }}>{err}</span>}
          <button className="btn danger" disabled={!currentId || busy} onClick={onDrop}>
            ✕ Drop
          </button>
          <button className="btn primary" disabled={!currentId || busy} onClick={onForward}>
            {busy ? <span className="spinner" /> : '▶'} Forward
          </button>
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column' }}>
          {editor ? (
            <RequestEditor
              state={editor}
              onChange={setEditor}
              note="Edits are sent upstream when you press Forward; Drop answers the client with 502."
            />
          ) : (
            <div className="empty">
              <div className="big">🚧</div>
              <div>Nothing is being held right now.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
