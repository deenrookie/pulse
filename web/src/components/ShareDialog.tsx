import { useEffect, useRef, useState } from 'react'
import { copyToClipboard, createShare, previewShare, type TrafficShare, type ShareSource } from '../api'
import type { Flow } from '../types'
import FlowSnapshot from './FlowSnapshot'

export default function ShareDialog({ source, onClose }: { source: ShareSource; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [ttl, setTTL] = useState(10080)
  const [preview, setPreview] = useState<Flow | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [share, setShare] = useState<TrafficShare | null>(null)
  const [notice, setNotice] = useState('')
  const sourceKey = JSON.stringify(source)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    const notify = (e: Event) => setNotice((e as CustomEvent).detail.text)
    window.addEventListener('pulse:notify', notify)
    return () => {
      dialog.current?.close()
      previous?.focus()
      window.removeEventListener('pulse:notify', notify)
    }
  }, [])
  useEffect(() => {
    let active = true
    setPreview(null)
    setError('')
    previewShare(source)
      .then((v) => {
        if (active) setPreview(v)
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [sourceKey])
  const create = async () => {
    setBusy(true)
    setError('')
    try {
      setShare(await createShare(source, ttl))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="share-dialog share-dialog-wide"
      aria-labelledby="share-title"
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) onClose()
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="share-heading">
        <h2 id="share-title">Share complete traffic</h2>
        <button className="btn sm" disabled={busy} onClick={onClose} autoFocus>
          Close
        </button>
      </div>
      <p className="sub">
        Full captured request and, when available, its response. Anyone with the link can read and copy them.
      </p>
      {share ? (
        <>
          <p role="status">
            Link created · expires {new Date(share.expiresAt).toLocaleString()} · survives Pulse restarts
          </p>
          <label className="share-field">
            Share link
            <input className="input mono" readOnly value={share.url} onFocus={(e) => e.target.select()} />
          </label>
          <div className="share-actions">
            <button
              className="btn primary"
              onClick={() => void copyToClipboard(share.url, { label: 'share link' })}
            >
              Copy link
            </button>
            <a className="btn" href={share.url} target="_blank" rel="noreferrer">
              Open snapshot
            </a>
            <span className="sub">Revoke in Settings → Temporary sharing.</span>
          </div>
        </>
      ) : (
        <div className="share-actions">
          <label>
            Expires in{' '}
            <select
              className="input"
              value={ttl}
              disabled={busy}
              onChange={(e) => setTTL(Number(e.target.value))}
            >
              <option value={60}>1 hour</option>
              <option value={1440}>1 day</option>
              <option value={10080}>7 days</option>
              <option value={43200}>30 days</option>
              <option value={129600}>90 days</option>
              <option value={525600}>1 year</option>
            </select>
          </label>
          <button className="btn primary" disabled={!preview || busy} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create share link'}
          </button>
        </div>
      )}
      {error && (
        <p className="err-inline" role="alert">
          {error}{' '}
          <a href="#/settings" onClick={onClose}>
            Open Settings
          </a>
        </p>
      )}
      {preview ? <FlowSnapshot flow={preview} /> : !error && <p role="status">Loading complete snapshot…</p>}
      <div role="status">{notice}</div>
    </dialog>
  )
}
