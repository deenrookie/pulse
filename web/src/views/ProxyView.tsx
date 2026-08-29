import { useMemo, useState } from 'react'
import FlowTable from '../components/FlowTable'
import { RequestInspector, ResponseInspector } from '../components/MessageViewer'
import type { PulseState } from '../state'

export default function ProxyView({ pulse }: { pulse: PulseState }) {
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    if (!q.trim()) return pulse.flows
    const needle = q.trim().toLowerCase()
    return pulse.flows.filter((m) =>
      `${m.method} ${m.host} ${m.path} ${m.statusCode} ${m.state}`.toLowerCase().includes(needle),
    )
  }, [pulse.flows, q])

  const fl = pulse.selectedFlow

  return (
    <div className="split-v" style={{ padding: 10, gap: 10 }}>
      <div style={{ flex: '1 1 55%', minHeight: 0, display: 'flex' }}>
        <div className="panel" style={{ flex: 1 }}>
          <div className="toolbar">
            <input
              className="input search"
              placeholder="Filter (method, host, path, status…)"
              value={q}
              spellCheck={false}
              onChange={(e) => setQ(e.target.value)}
            />
            <div style={{ flex: 1 }} />
            <button className="btn danger" onClick={pulse.clearAllFlows}>
              Clear history
            </button>
          </div>
          <FlowTable
            flows={filtered}
            selectedId={pulse.selectedId}
            onSelect={pulse.selectFlow}
            onDelete={pulse.removeFlow}
            onSendToRepeater={pulse.sendToRepeater}
            notify={pulse.notify}
          />
        </div>
      </div>
      <div style={{ flex: '1 1 45%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="toolbar" style={{ borderRadius: '8px 8px 0 0' }}>
          <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-muted)' }}>
            {fl ? `${fl.id} · ${fl.request.method} ${fl.request.url}` : 'No flow selected'}
          </span>
          <div style={{ flex: 1 }} />
          <button
            className="btn sm"
            disabled={!fl}
            title="Copy this request into a new Repeater tab"
            onClick={() => fl && pulse.sendToRepeater(fl.id)}
          >
            ⟳ Send to Repeater
          </button>
        </div>
        <div className="inspector" style={{ flex: 1, padding: 0, gap: 10 }}>
          {fl ? (
            <>
              <RequestInspector req={fl.request} />
              <ResponseInspector resp={fl.response} error={fl.error} />
            </>
          ) : (
            <div className="panel" style={{ flex: 1 }}>
              <div className="empty">
                <div className="big">🔎</div>
                <div>Select a row to inspect the request and response.</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
