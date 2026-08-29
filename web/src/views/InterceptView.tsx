import { useEffect, useState } from 'react'
import RequestEditor, { editorStateFrom, editorToRequest, type EditorState } from '../components/RequestEditor'
import * as api from '../api'
import Icon from '../ui/Icon'
import Empty from '../ui/Empty'
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

  // F / D forward & drop the held request — but never while typing
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy || !currentId) return
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) return
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        onForward()
      } else if (e.key === 'd' || e.key === 'D') {
        e.preventDefault()
        onDrop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, currentId, editor])

  return (
    <div className="view padded row">
      <div className="panel side-list">
        <div className="panel-head">
          <span className="title">Held requests</span>
          <span className={`badge ${pending.length ? 'hot' : ''}`}>{pending.length || ''}</span>
          <div className="spacer" />
          {pulse.intercept.enabled ? (
            <span className="meta" style={{ color: 'var(--accent)' }}>● holding</span>
          ) : (
            <span className="meta" style={{ color: 'var(--warn)' }}>● off</span>
          )}
        </div>
        <div className="panel-body">
          {pending.length === 0 ? (
            <Empty icon={pulse.intercept.enabled ? 'hand' : 'circle'} title={pulse.intercept.enabled ? 'Nothing held' : 'Intercept is off'}>
              {pulse.intercept.enabled ? (
                'Browse something — matching requests will pause here.'
              ) : (
                'Every request currently flows straight to the server.'
              )}
              {!pulse.intercept.enabled && (
                <button className="btn primary" style={{ marginTop: 8 }} onClick={() => pulse.toggleIntercept(true)}>
                  <Icon name="hand" size={13} />
                  Turn on Intercept
                </button>
              )}
            </Empty>
          ) : (
            pending.map((p) => (
              <div
                key={p.id}
                className={`side-item ${currentId === p.id ? 'selected' : ''}`}
                onClick={() => setSelectedPending(p.id)}
              >
                <div className="l1">
                  <span className={`method-${p.method}`}>{p.method}</span>
                  <span className="id">{p.id.replace('req-', '')}</span>
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
          {heldFull && <span className="meta">{heldFull.id}</span>}
          <div className="spacer" />
          {err && (
            <span className="err-inline" title={err}>
              <Icon name="alert" size={13} />
              {err}
            </span>
          )}
          <button className="btn danger" disabled={!currentId || busy} onClick={onDrop} title="Drop (D)">
            <Icon name="x" size={13} />
            Drop
            <kbd>D</kbd>
          </button>
          <button className="btn primary" disabled={!currentId || busy} onClick={onForward} title="Forward (F)">
            {busy ? <span className="spinner" /> : <Icon name="play" size={13} />}
            Forward
            <kbd>F</kbd>
          </button>
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column' }}>
          {editor ? (
            <RequestEditor
              state={editor}
              onChange={setEditor}
              note="Edits are sent upstream when you press Forward. Drop answers the client with 502."
            />
          ) : (
            <Empty icon="hand" title="Nothing is being held">
              Enable Intercept, then trigger a request to catch it here.
            </Empty>
          )}
        </div>
      </div>
    </div>
  )
}
