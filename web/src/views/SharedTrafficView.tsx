import { useCallback, useEffect, useState } from 'react'
import type { Flow } from '../types'
import type { TrafficShare } from '../api'
import FlowSnapshot from '../components/FlowSnapshot'

export default function SharedTrafficView() {
  const [data, setData] = useState<{ share: TrafficShare; flow: Flow } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const path = location.pathname
  const decodeShared = useCallback(
    async (side: 'request' | 'response', body: string | null | undefined) => {
      if (!body) return ''
      try {
        const response = await fetch(path + '/decode?side=' + side, { cache: 'no-store' })
        if (!response.ok) throw new Error('decode unavailable')
        const data = (await response.json()) as { body: string }
        return new TextDecoder().decode(Uint8Array.from(atob(data.body), (char) => char.charCodeAt(0)))
      } catch {
        return new TextDecoder().decode(Uint8Array.from(atob(body), (char) => char.charCodeAt(0)))
      }
    },
    [path],
  )
  useEffect(() => {
    document.documentElement.dataset.theme = 'linear'
    const controller = new AbortController()
    const load = async () => {
      try {
        const response = await fetch(path + '/data', {
          signal: controller.signal,
          cache: 'no-store',
        })
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? 'This share has expired, was revoked, or is unavailable.'
              : 'Could not load this share. Reload to retry.',
          )
        setData(await response.json())
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message)
      }
    }
    void load()
    const notify = (e: Event) => setNotice((e as CustomEvent).detail.text)
    window.addEventListener('pulse:notify', notify)
    return () => {
      controller.abort()
      window.removeEventListener('pulse:notify', notify)
    }
  }, [path])
  return (
    <main className="shared-traffic">
      <header className="shared-header">
        <div className="shared-title">
          <span className="faint">PULSE · SHARED TRAFFIC</span>
          <h1>{data ? data.flow.request.method : 'Traffic snapshot'}</h1>
          {data && (
            <code className="shared-url" title={data.flow.request.url}>
              {data.flow.request.url}
            </code>
          )}
        </div>
        {data && (
          <a className="btn" href={path + '/data?download'} download="pulse-share.json">
            Download complete snapshot
          </a>
        )}
      </header>
      {error ? (
        <p role="alert">{error}</p>
      ) : data ? (
        <>
          <div className="share-actions">
            <span>Expires {new Date(data.share.expiresAt).toLocaleString()}</span>
            <span className="faint">
              {data.flow.response
                ? 'Full captured request and response'
                : 'Request only · no response captured'}{' '}
              · right-click for cURL / Python · search each pane
            </span>
          </div>
          {(data.flow.request.truncated ||
            data.flow.response?.truncated ||
            data.flow.response?.bodyDropped) && (
            <p className="share-warning">
              The source capture marked a body as truncated or discarded. This share includes everything
              available in that capture.
            </p>
          )}
          <FlowSnapshot flow={data.flow} decode={decodeShared} />
          {!!data.flow.ws?.length && (
            <details>
              <summary>WebSocket messages ({data.flow.ws.length})</summary>
              <pre className="code-view">{JSON.stringify(data.flow.ws, null, 2)}</pre>
            </details>
          )}
        </>
      ) : (
        <p role="status">Loading traffic…</p>
      )}
      <div role="status" className="snapshot-notice">
        {notice}
      </div>
    </main>
  )
}
