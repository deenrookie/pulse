import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../ui/Icon'
import Empty from '../ui/Empty'
import Split from '../ui/Split'
import { confirm } from '../ui/Confirm'
import RawEditor, { rawToRequest } from '../components/RawEditor'
import FlowSnapshot, { snapshotMenu } from '../components/FlowSnapshot'
import ContextMenu, { type MenuItem } from '../components/ContextMenu'
import ShareDialog from '../components/ShareDialog'
import {
  attackPlan,
  bodySize,
  countPositions,
  grepHitsFor,
  payloadLines,
  templateBaseURL,
  type AttackMode,
} from '../intruder'
import * as api from '../api'
import type { PulseState } from '../state'
import type { Attack, AttackResult } from '../types'

const TEMPLATE = ['GET /login?user=§admin§ HTTP/1.1', 'Host: example.com', '', ''].join(
  String.fromCharCode(10),
)
const draftKey = (id: string) => 'pulse.intruder.draft.' + id
type Draft = {
  raw: string
  payloads: string
  payloadSets: string[]
  grep: string
  mode: AttackMode
  targetURL: string
}
const emptyDraft: Draft = {
  raw: TEMPLATE,
  payloads: 'admin' + String.fromCharCode(10) + 'guest',
  payloadSets: [],
  grep: '',
  mode: 'sniper',
  targetURL: 'http://example.com',
}

export default function IntruderView({
  pulse,
  openSeed,
  onSeedConsumed,
}: {
  pulse: PulseState
  openSeed?: { raw: string; targetURL?: string; n: number } | null
  onSeedConsumed?: () => void
}) {
  const [attacks, setAttacks] = useState<Attack[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [tab, setTab] = useState<'positions' | 'payloads' | 'results'>('positions')
  const [running, setRunning] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [saving, setSaving] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [results, setResults] = useState<AttackResult[]>([])
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<{
    key: 'index' | 'payload' | 'statusCode' | 'length' | 'ms'
    dir: 1 | -1
  }>({ key: 'index', dir: 1 })
  const [menu, setMenu] = useState<{
    x: number
    y: number
    index: number
  } | null>(null)
  const [attackMenuState, setAttackMenuState] = useState<{ x: number; y: number; attack: Attack } | null>(
    null,
  )
  const [shareFlow, setShareFlow] = useState<string | null>(null)
  const [setIndex, setSetIndex] = useState(0)
  const run = useRef({ active: false, stop: false })
  const seedHandled = useRef<number | null>(null)
  const mounted = useRef(true)
  const importRef = useRef<HTMLInputElement>(null)
  const patch = (value: Partial<Draft>) => setDraft((d) => ({ ...d, ...value }))

  const refresh = async () => {
    const r = await api.listAttacks()
    setAttacks(r.attacks)
    return r.attacks
  }
  const open = (attack: Attack) => {
    if (run.current.active) return
    let next: Draft = {
      raw: attack.raw,
      payloads: attack.payloads,
      payloadSets: attack.payloadSets ?? [],
      grep: attack.grep ?? '',
      mode: attack.mode ?? (attack.payloadSets?.length ? 'pitchfork' : 'battering-ram'),
      targetURL: attack.targetURL || templateBaseURL(attack.raw),
    }
    try {
      const saved = localStorage.getItem(draftKey(attack.id))
      if (saved) {
        const d = JSON.parse(saved)
        if (
          d &&
          ['raw', 'payloads', 'grep', 'targetURL'].every((key) => typeof d[key] === 'string') &&
          ['sniper', 'battering-ram', 'pitchfork'].includes(d.mode) &&
          Array.isArray(d.payloadSets) &&
          d.payloadSets.every((value: unknown) => typeof value === 'string')
        )
          next = d
      }
    } catch {
      /* storage unavailable */
    }
    setCurrentId(attack.id)
    setDraft(next)
    const savedResults: AttackResult[] = (attack.results ?? []).map((result) => ({ ...result, flow: null }))
    setResults(savedResults)
    setSelectedIdx(savedResults.length ? 0 : null)
    setError('')
    setStatus('')
    setTab(savedResults.length ? 'results' : 'positions')
    setSetIndex(0)
    history.replaceState(null, '', '#/intruder?attack=' + encodeURIComponent(attack.id))
  }
  useEffect(() => {
    mounted.current = true
    void refresh()
      .then((list) => {
        if (openSeed?.raw) return
        const id = new URLSearchParams(location.hash.split('?')[1]).get('attack')
        const found = list.find((a) => a.id === id) ?? list[0]
        if (found) open(found)
      })
      .catch((e) => setError(e.message))
    return () => {
      mounted.current = false
      run.current.stop = true
    }
  }, [])
  useEffect(() => {
    if (!openSeed?.raw || seedHandled.current === openSeed.n) return
    seedHandled.current = openSeed.n
    void api
      .createAttack({
        ...emptyDraft,
        raw: openSeed.raw,
        targetURL: openSeed.targetURL || templateBaseURL(openSeed.raw),
        payloads: '',
      })
      .then(async (a) => {
        await refresh()
        open(a)
        onSeedConsumed?.()
      })
      .catch((e) => setError(e.message))
  }, [openSeed?.n])
  useEffect(() => {
    if (!currentId) return
    try {
      localStorage.setItem(draftKey(currentId), JSON.stringify(draft))
    } catch {
      setError('Draft could not be saved in this browser. Use Save before leaving.')
    }
  }, [currentId, draft])

  const save = async () => {
    if (!currentId) return
    setSaving(true)
    setError('')
    try {
      await api.updateAttack(currentId, draft)
      await refresh()
      setStatus('Attack saved')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  const create = async () => {
    try {
      const a = await api.createAttack(emptyDraft)
      await refresh()
      open(a)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const remove = async () => currentId && removeAttack(currentId)
  const plan = useMemo(() => {
    try {
      return {
        value: attackPlan(draft.raw, draft.mode, draft.payloads, draft.payloadSets),
        error: '',
      }
    } catch (e) {
      return { value: null, error: (e as Error).message }
    }
  }, [draft])
  const start = async () => {
    if (run.current.active) return
    setStatus('')
    if (!plan.value) {
      setError(plan.error)
      return
    }
    const target = (() => {
      try {
        return new URL(draft.targetURL)
      } catch {
        return null
      }
    })()
    if (!target || !['http:', 'https:'].includes(target.protocol)) {
      setError('Set an HTTP or HTTPS target URL.')
      return
    }
    const schedule = plan.value,
      snapshot = { ...draft },
      keywords = payloadLines(draft.grep)
    run.current = { active: true, stop: false }
    setRunning(true)
    setStopping(false)
    setResults([])
    setSelectedIdx(null)
    setProgress({ done: 0, total: schedule.count })
    setTab('results')
    setError('')
    setStatus('')
    const out: AttackResult[] = []
    try {
      for (let index = 0; index < schedule.count; index++) {
        if (run.current.stop) break
        const round = schedule.round(index)
        try {
          const { flow } = await api.fireAttack({
            request: rawToRequest(round.raw, snapshot.targetURL),
          })
          out.push({
            payload: round.payload,
            position: round.position,
            statusCode: flow.response?.statusCode ?? 0,
            reason: flow.error || flow.response?.reason || '',
            length: bodySize(flow),
            ms: flow.response?.durationMs ?? 0,
            flow,
            flowId: flow.id,
            grepHits: await grepHitsFor(flow, keywords),
          })
        } catch (e) {
          out.push({
            payload: round.payload,
            position: round.position,
            statusCode: 0,
            reason: (e as Error).message,
            length: 0,
            ms: 0,
            flow: null,
            grepHits: [],
          })
        }
        if (!mounted.current) break
        setResults([...out])
        setProgress({ done: out.length, total: schedule.count })
      }
    } finally {
      run.current.active = false
      if (currentId) {
        try {
          await api.saveAttackResults(currentId, out)
          if (mounted.current) await refresh()
        } catch (e) {
          if (mounted.current) setError('Results finished but could not be saved: ' + (e as Error).message)
        }
      }
      if (mounted.current) {
        setRunning(false)
        setStopping(false)
        setStatus((run.current.stop ? 'Stopped' : 'Finished') + ' · ' + out.length + ' requests')
        pulse.notify(run.current.stop ? 'Attack stopped' : 'Attack finished')
        if (out.length) setSelectedIdx(0)
      }
    }
  }
  const positions = countPositions(draft.raw)
  const selectedSet = Math.min(setIndex, Math.max(positions - 1, 0))
  const payloadText = draft.mode === 'pitchfork' ? (draft.payloadSets[selectedSet] ?? '') : draft.payloads
  const setPayloadText = (text: string) => {
    if (draft.mode === 'pitchfork') {
      const next = [...draft.payloadSets]
      next[selectedSet] = text
      patch({ payloadSets: next })
    } else patch({ payloads: text })
  }
  const keywords = payloadLines(draft.grep)
  const visible = results
    .map((r, index) => ({ ...r, index }))
    .filter((r) =>
      [r.payload, r.position, r.statusCode, r.reason, r.flow?.request.url, ...r.grepHits]
        .join(' ')
        .toLowerCase()
        .includes(filter.toLowerCase()),
    )
    .sort((a, b) => {
      const av = a[sort.key] ?? '',
        bv = b[sort.key] ?? ''
      return (
        (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))) *
        sort.dir
      )
    })
  const sortBy = (key: typeof sort.key) =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === 1 ? -1 : 1 }))
  const selected = selectedIdx === null ? null : results[selectedIdx]
  useEffect(() => {
    if (selectedIdx === null) return
    const result = results[selectedIdx]
    if (!result || result.flow || !result.flowId) return
    let active = true
    void api
      .getFlow(result.flowId)
      .then((flow) => {
        if (!active) return
        setResults((current) =>
          current.map((item, index) => (index === selectedIdx ? { ...item, flow } : item)),
        )
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [selectedIdx, results])
  const resultMenu = (index: number): MenuItem[] => {
    const flow = results[index]?.flow
    if (!flow) return []
    return [
      {
        label: 'Send to Repeater',
        icon: 'send',
        onClick: async () => {
          try {
            await pulse.sendRequestToRepeater({ ...flow.request, body: flow.request.body ?? '' })
            location.hash = '#/repeater'
          } catch (e) {
            setError((e as Error).message)
          }
        },
      },
      {
        label: 'Share complete traffic',
        icon: 'link',
        onClick: () => setShareFlow(flow.id),
      },
      ...snapshotMenu(flow),
    ]
  }

  const removeAttack = async (id: string, confirmFirst = true) => {
    if (
      running ||
      (confirmFirst &&
        !(await confirm({
          title: 'Delete attack?',
          message: 'Remove this attack and its saved results.',
          confirmLabel: 'Delete',
          danger: true,
        })))
    )
      return
    try {
      await api.deleteAttack(id)
      localStorage.removeItem(draftKey(id))
      const next = (await refresh()).filter((attack) => attack.id !== id)
      if (currentId === id) {
        if (next[0]) open(next[0])
        else setCurrentId(null)
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const attackMenu = (attack: Attack): MenuItem[] => [
    { label: 'Open attack', icon: 'file', onClick: () => open(attack) },
    {
      label: 'Send template to Repeater',
      icon: 'send',
      onClick: async () => {
        try {
          const request = rawToRequest(attack.raw, attack.targetURL || templateBaseURL(attack.raw))
          await pulse.sendRequestToRepeater(request)
          location.hash = '#/repeater'
        } catch (e) {
          setError((e as Error).message)
        }
      },
    },
    {
      label: 'Delete attack',
      icon: 'trash',
      danger: true,
      separatorAfter: true,
      onClick: () => void removeAttack(attack.id),
    },
  ]

  return (
    <div className="view intruder-view">
      <aside className="side-list">
        <div className="side-head">
          <span>Attacks</span>
          <button className="btn sm" disabled={running} onClick={() => void create()} aria-label="New attack">
            <Icon name="plus" size={13} />
          </button>
        </div>
        {attacks.map((a) => (
          <div
            className={'side-item ' + (a.id === currentId ? 'selected' : '')}
            key={a.id}
            role="button"
            tabIndex={running ? -1 : 0}
            onClick={() => open(a)}
            onKeyDown={(e) => e.key === 'Enter' && open(a)}
            onContextMenu={(e) => {
              e.preventDefault()
              setAttackMenuState({ x: e.clientX, y: e.clientY, attack: a })
            }}
            title="Right-click for actions"
          >
            <div className="l1">
              <Icon name="bolt" size={11} className="lead-icon" />
              <span className="t mono">{a.raw.split(String.fromCharCode(10))[0]}</span>
              <span className="grow" />
              <span className="id">{a.id.replace('atk-', '')}</span>
              <button
                className="tab-x"
                aria-label={'Delete attack ' + a.id}
                disabled={running}
                onClick={(e) => {
                  e.stopPropagation()
                  void removeAttack(a.id, false)
                }}
              >
                <Icon name="x" size={11} />
              </button>
            </div>
            <div className="l2">
              {a.mode ?? 'battering-ram'} · {countPositions(a.raw)} positions
              {a.results?.length ? ' · ' + a.results.length + ' results' : ''}
            </div>
          </div>
        ))}
        {!attacks.length && (
          <p className="side-empty">Create an attack or send a request from Live Traffic / Repeater.</p>
        )}
      </aside>
      <div className="intruder-main">
        {error && (
          <div className="intruder-error" role="alert">
            {error}
          </div>
        )}
        {!currentId ? (
          <Empty icon="bolt" title="No attack selected">
            <span>Start with a blank request, or send one from Live Traffic / Repeater.</span>
            <button className="btn primary sm" onClick={() => void create()}>
              <Icon name="plus" size={13} /> New attack
            </button>
          </Empty>
        ) : (
          <>
            <div className="panel-head">
              <span className="title mono">{draft.raw.split(String.fromCharCode(10))[0]}</span>
              <div className="spacer" />
              <button className="btn sm" disabled={running || saving} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button className="btn danger sm" disabled={running || saving} onClick={() => void remove()}>
                Delete
              </button>
              {running ? (
                <button
                  className="btn danger"
                  disabled={stopping}
                  onClick={() => {
                    run.current.stop = true
                    setStopping(true)
                  }}
                >
                  {stopping ? 'Stopping after current request…' : 'Stop attack'}
                </button>
              ) : (
                <button className="btn primary" onClick={() => void start()}>
                  Start attack
                </button>
              )}
            </div>
            <div className="intruder-tabs" role="tablist" aria-label="Attack configuration">
              {(['positions', 'payloads', 'results'] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  className={tab === t ? 'subtab active' : 'subtab'}
                  onClick={() => setTab(t)}
                >
                  {t[0].toUpperCase() + t.slice(1)}
                  {t === 'results' && results.length ? ' (' + results.length + ')' : ''}
                </button>
              ))}
              <span className="faint">
                {positions} positions · {plan.value?.count ?? 0} requests
              </span>
            </div>
            {running && (
              <div className="intruder-progress" role="status">
                <progress max={progress.total} value={progress.done} />
                <span>
                  {progress.done}/{progress.total} completed
                </span>
              </div>
            )}
            {status && (
              <div className="intruder-status" role="status">
                {status}
              </div>
            )}
            {tab === 'positions' && (
              <div className="intruder-position-panel">
                <div className="intruder-options">
                  <label>
                    Target URL
                    <input
                      className="input mono"
                      disabled={running}
                      value={draft.targetURL}
                      onChange={(e) => patch({ targetURL: e.target.value })}
                    />
                  </label>
                  <label>
                    Attack type
                    <select
                      className="input"
                      disabled={running}
                      value={draft.mode}
                      onChange={(e) => patch({ mode: e.target.value as AttackMode })}
                    >
                      <option value="sniper">Sniper</option>
                      <option value="battering-ram">Battering ram</option>
                      <option value="pitchfork">Pitchfork</option>
                    </select>
                  </label>
                </div>
                <p className="sub">
                  {draft.mode === 'sniper'
                    ? 'Replace one position at a time; keep other values unchanged.'
                    : draft.mode === 'battering-ram'
                      ? 'Use the same payload in every marked position for each request.'
                      : 'Use one payload set per position, advancing them together.'}{' '}
                  Host header sets the destination host; Target URL preserves HTTP / HTTPS.
                </p>
                <RawEditor
                  value={draft.raw}
                  onChange={(raw) => patch({ raw })}
                  markPositions
                  readOnly={running}
                />
              </div>
            )}
            {tab === 'payloads' && (
              <div className="intruder-payload-panel">
                <div className="cfg-col">
                  <div className="share-actions">
                    <label>
                      Payload set{' '}
                      <select
                        className="input"
                        aria-label="Payload set"
                        disabled={running || draft.mode !== 'pitchfork'}
                        value={selectedSet}
                        onChange={(e) => setSetIndex(Number(e.target.value))}
                      >
                        {Array.from(
                          {
                            length: draft.mode === 'pitchfork' ? Math.max(positions, 1) : 1,
                          },
                          (_, i) => (
                            <option key={i} value={i}>
                              {i + 1}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <span>{payloadLines(payloadText).length} payloads</span>
                    <button className="btn sm" disabled={running} onClick={() => importRef.current?.click()}>
                      Load file
                    </button>
                    <input
                      ref={importRef}
                      type="file"
                      hidden
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        if (file) {
                          try {
                            setPayloadText(await file.text())
                          } catch (err) {
                            setError((err as Error).message)
                          }
                        }
                        e.target.value = ''
                      }}
                    />
                    <button
                      className="btn sm"
                      disabled={running}
                      onClick={() =>
                        setPayloadText([...new Set(payloadLines(payloadText))].join(String.fromCharCode(10)))
                      }
                    >
                      Deduplicate
                    </button>
                  </div>
                  <textarea
                    className="cfg-src"
                    aria-label="Payload values"
                    disabled={running}
                    value={payloadText}
                    onChange={(e) => setPayloadText(e.target.value)}
                    placeholder="One payload per line"
                  />
                  <p className="sub">
                    Whitespace in payloads is preserved. Empty lines are ignored. {plan.value?.warning}
                  </p>
                </div>
                <div className="cfg-col">
                  <label className="cfg-label" htmlFor="intruder-grep">
                    Grep match
                  </label>
                  <textarea
                    id="intruder-grep"
                    className="cfg-src"
                    disabled={running}
                    value={draft.grep}
                    onChange={(e) => patch({ grep: e.target.value })}
                    placeholder="One response keyword per line"
                  />
                  <p className="sub">
                    Case-insensitive matches against status, headers and decoded text bytes.
                  </p>
                </div>
              </div>
            )}
            {tab === 'results' && (
              <div className="intruder-results">
                <div className="panel-head">
                  <input
                    className="input"
                    aria-label="Search results"
                    placeholder="Search payload, URL, status or error…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                  <span className="meta">
                    {visible.length}/{results.length} shown · first result is baseline
                  </span>
                </div>
                {!results.length ? (
                  <Empty icon="bolt" title={running ? 'Waiting for first result…' : 'No results yet'}>
                    Configure positions and payloads, then start the attack.
                  </Empty>
                ) : (
                  <Split
                    dir="v"
                    storageKey="pulse.split.intruder.results"
                    initial={0.4}
                    a={
                      <div className="intruder-result-table">
                        <table className="rules-table intruder-table">
                          <thead>
                            <tr>
                              {(
                                [
                                  ['index', '#'],
                                  ['payload', 'Payload'],
                                  ['statusCode', 'Status'],
                                  ['length', 'Length'],
                                  ['ms', 'Time'],
                                ] as const
                              ).map(([key, label]) => (
                                <th
                                  key={key}
                                  aria-sort={
                                    sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'
                                  }
                                >
                                  <button onClick={() => sortBy(key)}>
                                    {label}
                                    {sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
                                  </button>
                                </th>
                              ))}
                              <th>Position</th>
                              {keywords.map((k, i) => (
                                <th key={i}>{k}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {visible.map((r) => (
                              <tr
                                key={r.index}
                                tabIndex={0}
                                aria-selected={selectedIdx === r.index}
                                className={
                                  selectedIdx === r.index
                                    ? 'selected'
                                    : r.statusCode !== results[0].statusCode || r.length !== results[0].length
                                      ? 'deviates'
                                      : ''
                                }
                                onClick={() => setSelectedIdx(r.index)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') setSelectedIdx(r.index)
                                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                                    e.preventDefault()
                                    const i = visible.findIndex((v) => v.index === r.index)
                                    const next = visible[i + (e.key === 'ArrowDown' ? 1 : -1)]
                                    if (next) {
                                      setSelectedIdx(next.index)
                                      const row =
                                        e.key === 'ArrowDown'
                                          ? e.currentTarget.nextElementSibling
                                          : e.currentTarget.previousElementSibling
                                      ;(row as HTMLElement | null)?.focus()
                                    }
                                  }
                                }}
                                onContextMenu={(e) => {
                                  e.preventDefault()
                                  setSelectedIdx(r.index)
                                  setMenu({
                                    x: e.clientX,
                                    y: e.clientY,
                                    index: r.index,
                                  })
                                }}
                                title={r.reason}
                              >
                                <td>{r.index + 1}</td>
                                <td className="mono">{r.payload}</td>
                                <td>{r.statusCode || 'Error'}</td>
                                <td>{r.length}</td>
                                <td>{r.ms}ms</td>
                                <td>{r.position}</td>
                                {keywords.map((k, i) => (
                                  <td key={i}>{r.grepHits.includes(k) ? '✓' : ''}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    }
                    b={
                      selected?.flow ? (
                        <FlowSnapshot flow={selected.flow} extraMenu={resultMenu(selectedIdx!).slice(0, 2)} />
                      ) : (
                        <Empty icon="eye" title={selected?.reason || 'Select a result'}>
                          Inspect the sent request and received response side by side.
                        </Empty>
                      )
                    }
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={resultMenu(menu.index)} onClose={() => setMenu(null)} />
      )}
      {attackMenuState && (
        <ContextMenu
          x={attackMenuState.x}
          y={attackMenuState.y}
          items={attackMenu(attackMenuState.attack)}
          onClose={() => setAttackMenuState(null)}
        />
      )}
      {shareFlow && <ShareDialog source={{ flowId: shareFlow }} onClose={() => setShareFlow(null)} />}
    </div>
  )
}
