// Intruder — Burp-style batch fuzzing. An attack is a raw request template
// where §payload§ marks positions plus a payload list; Start substitutes
// each payload into every position (single-set mode) and fires the requests
// one by one, collecting status/length/time for comparison against the
// baseline (first result). Attack plans persist in the backend.
import { useEffect, useRef, useState } from 'react'
import Icon from '../ui/Icon'
import Empty from '../ui/Empty'
import Split from '../ui/Split'
import { confirm } from '../ui/Confirm'
import { ResponseInspector } from '../components/MessageViewer'
import { rawToRequest } from '../components/RawEditor'
import * as api from '../api'
import type { PulseState } from '../state'
import type { Attack, AttackResult, Flow } from '../types'

const TEMPLATE_HINT = `GET /login?user=§admin§ HTTP/1.1
Host: example.com

§body§`

export default function IntruderView({ pulse, openSeed }: { pulse: PulseState; openSeed?: { raw: string; n: number } | null }) {
  const [attacks, setAttacks] = useState<Attack[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  // draft editor state (saved on demand)
  const [title, setTitle] = useState('')
  const [raw, setRaw] = useState(TEMPLATE_HINT)
  const [payloads, setPayloads] = useState('admin\nroot\nguest')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [results, setResults] = useState<AttackResult[]>([])
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const stopRef = useRef(false)

  const refresh = () => api.listAttacks().then((r) => setAttacks(r.attacks)).catch(() => {})
  useEffect(() => {
    refresh()
  }, [])

  // "Send to Intruder" from Live Traffic / Repeater: App hands the request's
  // raw form over as a seed prop (the event fires before this view mounts)
  useEffect(() => {
    if (!openSeed?.raw) return
    void (async () => {
      try {
        const a = await api.createAttack({ title: '', raw: openSeed.raw, payloads: '' })
        await refresh()
        open(a)
        pulse.notify('Sent to Intruder — mark positions with §…§ and add payloads')
      } catch (err) {
        pulse.notify((err as Error).message, 'err')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSeed?.n])

  // deep link: #/intruder?attack=atk-1
  useEffect(() => {
    const apply = () => {
      const h = location.hash
      const i = h.indexOf('?')
      if (i < 0) return
      const id = new URLSearchParams(h.slice(i + 1)).get('attack')
      if (id) void load(id)
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [attacks])

  const open = (a: Attack) => {
    setCurrentId(a.id)
    setTitle(a.title)
    setRaw(a.raw)
    setPayloads(a.payloads)
    setResults([])
    setSelectedIdx(null)
  }

  const load = async (id: string) => {
    const found = attacks.find((a) => a.id === id) ?? (await api.listAttacks().then((r) => r.attacks.find((a) => a.id === id)))
    if (found) open(found)
  }

  const create = async () => {
    const a = await api.createAttack({ title: '', raw: TEMPLATE_HINT, payloads: '' })
    await refresh()
    open(a)
  }

  const save = async () => {
    if (!currentId) return
    try {
      await api.updateAttack(currentId, { title: title.trim() || autoTitle(), raw, payloads })
      await refresh()
      pulse.notify('Attack saved')
    } catch (e) {
      pulse.notify((e as Error).message, 'err')
    }
  }

  const remove = async () => {
    if (!currentId) return
    const ok = await confirm({ title: 'Delete attack?', message: 'The saved template and payload list are removed.', confirmLabel: 'Delete', danger: true })
    if (!ok) return
    await api.deleteAttack(currentId)
    setCurrentId(null)
    await refresh()
  }

  const autoTitle = () => {
    const first = raw.split('\n')[0] ?? ''
    return first.slice(0, 60)
  }

  // ---- attack execution: substitute every §position§ with each payload ----
  const start = async () => {
    const list = payloads.split('\n').map((p) => p.trim()).filter(Boolean)
    if (!raw.includes('§')) {
      pulse.notify('Mark at least one position with §payload§ in the template', 'err')
      return
    }
    if (list.length === 0) {
      pulse.notify('Add payloads — one per line', 'err')
      return
    }
    stopRef.current = false
    setRunning(true)
    setResults([])
    setSelectedIdx(null)
    const out: AttackResult[] = []
    for (let i = 0; i < list.length; i++) {
      if (stopRef.current) break
      const payload = list[i]
      const substituted = raw.replaceAll('§', '\x00').split('\x00').map((part, idx) => (idx % 2 === 1 ? payload : part)).join('')
      const parsed = rawToRequest(substituted, templateBaseURL(raw))
      if ('error' in parsed) {
        out.push({ payload, statusCode: 0, reason: 'parse: ' + parsed.error, length: 0, ms: 0, flow: null })
        setResults([...out])
        continue
      }
      setProgress(`${i + 1}/${list.length} · ${payload}`)
      try {
        const r = await api.fireAttack({ request: parsed })
        const fl: Flow = r.flow
        out.push({
          payload,
          statusCode: fl.response?.statusCode ?? 0,
          reason: fl.error || fl.response?.reason || '',
          length: fl.response ? bodySize(fl) : 0,
          ms: fl.response?.durationMs ?? 0,
          flow: fl,
        })
      } catch (e) {
        out.push({ payload, statusCode: 0, reason: (e as Error).message, length: 0, ms: 0, flow: null })
      }
      setResults([...out])
    }
    setRunning(false)
    setProgress('')
    pulse.notify(stopRef.current ? 'Attack stopped' : `Attack finished — ${out.length} requests`)
  }

  const stop = () => {
    stopRef.current = true
  }

  const baseline = results[0]
  const selected = selectedIdx !== null ? results[selectedIdx] : null

  return (
    <div className="view">
      <div className="side-list">
        <div className="side-head">
          <span>Attacks</span>
          <button className="btn ghost sm icon-btn" title="New attack" onClick={() => void create()}>
            <Icon name="plus" size={13} />
          </button>
        </div>
        {attacks.length === 0 ? (
          <div className="side-empty">Right-click a flow → “Send to Intruder”, or press + for a blank attack.</div>
        ) : (
          attacks.map((a) => (
            <div
              key={a.id}
              className={`side-item ${currentId === a.id ? 'selected' : ''}`}
              onClick={() => open(a)}
              title={a.title}
            >
              <div className="t mono">{a.title || a.raw.split('\n')[0]?.slice(0, 26)}</div>
              <div className="m faint mono">
                {a.payloads.split('\n').filter(Boolean).length} payloads · {countPositions(a.raw)} positions
              </div>
            </div>
          ))
        )}
      </div>
      <div className="view-fill" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8, position: 'relative' }}>
        {currentId === null ? (
          <Empty icon="bolt" title="No attack selected">
            Pick an attack on the left, right-click any flow → <b>Send to Intruder</b>,
            <br />
            or start a blank template with <b>+</b>.
          </Empty>
        ) : (
          <>
            <div className="panel-head">
              <input
                className="input"
                style={{ width: 260 }}
                placeholder="Attack name (first line of the request is used if empty)"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <div className="spacer" />
              {running ? (
                <button className="btn danger sm" onClick={stop}>
                  <Icon name="x" size={13} />
                  Stop
                </button>
              ) : (
                <button className="btn primary sm" onClick={start} title="Substitute each payload into every §position§ and fire">
                  <Icon name="play" size={13} />
                  Start attack
                </button>
              )}
              {running && <span className="meta mono">{progress}</span>}
              <button className="btn ghost sm" onClick={save}>Save</button>
              <button className="btn danger sm" onClick={remove}>Delete</button>
            </div>
            <Split
              dir="v"
              storageKey="pulse.split.intruder"
              initial={0.5}
              a={
                <div className="intruder-config">
                  <div className="cfg-col">
                    <div className="cfg-label">
                      Request template <span className="faint">— wrap fuzz targets in §…§</span>
                    </div>
                    <textarea
                      className="cfg-src"
                      value={raw}
                      spellCheck={false}
                      onChange={(e) => setRaw(e.target.value)}
                    />
                  </div>
                  <div className="cfg-col" style={{ flex: 0.7 }}>
                    <div className="cfg-label">
                      Payloads <span className="faint">— one per line ({countPositions(raw)} positions, single-set mode)</span>
                    </div>
                    <textarea
                      className="cfg-src"
                      value={payloads}
                      spellCheck={false}
                      onChange={(e) => setPayloads(e.target.value)}
                    />
                  </div>
                </div>
              }
              b={
                <div className="panel-body" style={{ display: 'flex', flexDirection: 'column' }}>
                  {results.length === 0 ? (
                    <Empty icon="bolt" title="No results yet">
                      Press <b>Start attack</b> — each payload is fired once;
                      <br />
                      the first result is the baseline, deviations are highlighted.
                    </Empty>
                  ) : (
                    <>
                      <table className="rules-table intruder-table">
                        <thead>
                          <tr>
                            <th style={{ width: 36 }}>#</th>
                            <th>Payload</th>
                            <th style={{ width: 70 }}>Status</th>
                            <th style={{ width: 80 }}>Length</th>
                            <th style={{ width: 70 }}>Took</th>
                          </tr>
                        </thead>
                        <tbody>
                          {results.map((r, i) => {
                            const deviates = baseline && (r.statusCode !== baseline.statusCode || r.length !== baseline.length)
                            return (
                              <tr
                                key={i}
                                className={selectedIdx === i ? 'selected' : deviates ? 'deviates' : ''}
                                onClick={() => setSelectedIdx(i)}
                                title={r.reason || 'Click to inspect the response'}
                              >
                                <td className="faint">{i + 1}</td>
                                <td className="mono">{r.payload}</td>
                                <td className={`mono ${r.statusCode ? `status${Math.floor(r.statusCode / 100)}` : ''}`}>{r.statusCode || '—'}</td>
                                <td className="mono">{r.length || '—'}</td>
                                <td className="mono faint">{r.ms}ms</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                      {selected && selected.flow?.response && (
                        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border)' }}>
                          <ResponseInspector resp={selected.flow.response} error={selected.flow.error} flowId={selected.flow.id} />
                        </div>
                      )}
                    </>
                  )}
                </div>
              }
            />
          </>
        )}
      </div>
    </div>
  )
}

function countPositions(raw: string): number {
  return Math.floor((raw.split('§').length - 1) / 2)
}

/** rawToRequest needs an absolute URL; the template's Host line provides it */
function templateBaseURL(raw: string): string {
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*Host\s*:\s*(\S+)/i)
    if (m) return 'http://' + m[1]
  }
  return 'http://example.com'
}

function bodySize(fl: Flow): number {
  const b = fl.response?.body ?? ''
  // stored base64 → actual bytes ≈ 3/4 of the encoded length
  return Math.floor((b.length * 3) / 4)
}

