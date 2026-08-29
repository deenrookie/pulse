import { useEffect, useState } from 'react'
import * as api from '../api'
import type { PluginInfo, RewriteRule, RewriteZone } from '../types'

const ZONES: [RewriteZone, string][] = [
  ['request_line', 'Request line / URL'],
  ['request_header', 'Request header'],
  ['request_body', 'Request body'],
  ['response_header', 'Response header'],
  ['response_body', 'Response body'],
]

type ExtTab = 'rewrite' | 'plugins'

export default function ExtensionsView({ notify }: { notify: (text: string, kind?: 'ok' | 'err') => void }) {
  const [tab, setTab] = useState<ExtTab>('rewrite')
  return (
    <div className="split-v">
      <div className="ext-tabs">
        <button className={`ext-tab ${tab === 'rewrite' ? 'active' : ''}`} onClick={() => setTab('rewrite')}>
          Match &amp; Replace
        </button>
        <button className={`ext-tab ${tab === 'plugins' ? 'active' : ''}`} onClick={() => setTab('plugins')}>
          Plugins
        </button>
      </div>
      <div className="view" style={{ padding: 10, minHeight: 0 }}>
        {tab === 'rewrite' ? <RewritePanel notify={notify} /> : <PluginsPanel notify={notify} />}
      </div>
    </div>
  )
}

interface Draft {
  enabled: boolean
  zone: RewriteZone
  match: string
  replace: string
  regex: boolean
  comment: string
}

const emptyDraft: Draft = {
  enabled: true,
  zone: 'request_header',
  match: '',
  replace: '',
  regex: false,
  comment: '',
}

function RewritePanel({ notify }: { notify: (text: string, kind?: 'ok' | 'err') => void }) {
  const [rules, setRules] = useState<RewriteRule[]>([])
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = () => api.listRewriteRules().then((r) => setRules(r.rules)).catch(() => {})
  useEffect(() => {
    refresh()
    const t = window.setInterval(refresh, 4000) // keep hit counters fresh
    return () => window.clearInterval(t)
  }, [])

  const submit = async () => {
    if (!draft.match.trim()) {
      notify('Match must not be empty', 'err')
      return
    }
    setBusy(true)
    try {
      if (editingId) {
        await api.updateRewriteRule(editingId, draft)
        notify('Rule updated')
      } else {
        await api.createRewriteRule(draft)
        notify('Rule added')
      }
      setDraft(emptyDraft)
      setEditingId(null)
      await refresh()
    } catch (e) {
      notify((e as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (r: RewriteRule) => {
    try {
      await api.updateRewriteRule(r.id, { ...r, enabled: !r.enabled })
      refresh()
    } catch (e) {
      notify((e as Error).message, 'err')
    }
  }

  const remove = async (r: RewriteRule) => {
    try {
      await api.deleteRewriteRule(r.id)
      if (editingId === r.id) {
        setEditingId(null)
        setDraft(emptyDraft)
      }
      refresh()
    } catch (e) {
      notify((e as Error).message, 'err')
    }
  }

  const edit = (r: RewriteRule) => {
    setEditingId(r.id)
    setDraft({
      enabled: r.enabled,
      zone: r.zone,
      match: r.match,
      replace: r.replace,
      regex: r.regex,
      comment: r.comment,
    })
  }

  return (
    <div className="panel" style={{ flex: 1 }}>
      <div className="panel-head">
        <span className="title">{editingId ? 'Edit rule' : 'Add rule'}</span>
        <span style={{ color: 'var(--text-faint)' }}>
          rules run on proxy traffic after plugins, before interception
        </span>
        <div className="spacer" />
        {editingId && (
          <button
            className="btn ghost sm"
            onClick={() => {
              setEditingId(null)
              setDraft(emptyDraft)
            }}
          >
            Cancel edit
          </button>
        )}
        <button className="btn primary" disabled={busy} onClick={submit}>
          {editingId ? 'Save' : 'Add'}
        </button>
      </div>
      <div className="rule-form">
        <select className="select" value={draft.zone} onChange={(e) => setDraft({ ...draft, zone: e.target.value as RewriteZone })}>
          {ZONES.map(([z, label]) => (
            <option key={z} value={z}>
              {label}
            </option>
          ))}
        </select>
        <input
          className="input"
          placeholder="Match (string or regex)"
          value={draft.match}
          spellCheck={false}
          onChange={(e) => setDraft({ ...draft, match: e.target.value })}
        />
        <input
          className="input"
          placeholder="Replace with"
          value={draft.replace}
          spellCheck={false}
          onChange={(e) => setDraft({ ...draft, replace: e.target.value })}
        />
        <label className="switch" title="Treat Match as a regular expression">
          <input type="checkbox" checked={draft.regex} onChange={(e) => setDraft({ ...draft, regex: e.target.checked })} />
          <span className="track" />
          Regex
        </label>
        <input
          className="input"
          placeholder="Comment (optional)"
          value={draft.comment}
          onChange={(e) => setDraft({ ...draft, comment: e.target.value })}
        />
      </div>
      <div className="panel-body">
        {rules.length === 0 ? (
          <div className="empty">
            <div className="big">⇄</div>
            <div>
              No rules yet.
              <br />
              Example: strip a cookie, rewrite an API version, redact tokens in responses.
            </div>
          </div>
        ) : (
          <table className="rules-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>On</th>
                <th style={{ width: 150 }}>Applies to</th>
                <th>Match</th>
                <th>Replace</th>
                <th style={{ width: 50 }}>Regex</th>
                <th>Comment</th>
                <th style={{ width: 60, textAlign: 'right' }}>Hits</th>
                <th style={{ width: 110 }} />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} onDoubleClick={() => edit(r)} title="Double-click to edit">
                  <td>
                    <input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} />
                  </td>
                  <td>
                    <span className="zone-chip">{zoneLabel(r.zone)}</span>
                  </td>
                  <td title={r.match} style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.match}
                  </td>
                  <td title={r.replace} style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.replace || <span style={{ color: 'var(--text-faint)' }}>(empty)</span>}
                  </td>
                  <td>{r.regex ? '.*' : 'abc'}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{r.comment}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text-faint)' }}>{r.hits}</td>
                  <td>
                    <button className="btn ghost sm" onClick={() => edit(r)}>
                      Edit
                    </button>{' '}
                    <button className="btn danger sm" onClick={() => remove(r)}>
                      Del
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function PluginsPanel({ notify }: { notify: (text: string, kind?: 'ok' | 'err') => void }) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [dir, setDir] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = () =>
    api
      .listPlugins()
      .then((r) => {
        setPlugins(r.plugins)
        setDir(r.dir)
      })
      .catch(() => {})
  useEffect(() => {
    refresh()
    const t = window.setInterval(refresh, 4000)
    return () => window.clearInterval(t)
  }, [])

  const reload = async () => {
    setBusy(true)
    try {
      const r = await api.reloadPlugins()
      setPlugins(r.plugins)
      setDir(r.dir)
      notify('Plugins reloaded')
    } catch (e) {
      notify((e as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (p: PluginInfo) => {
    try {
      await api.setPluginEnabled(p.file, !p.enabled)
      refresh()
    } catch (e) {
      notify((e as Error).message, 'err')
    }
  }

  return (
    <div className="panel" style={{ flex: 1 }}>
      <div className="panel-head">
        <span className="title">Plugins</span>
        <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-faint)' }}>{dir}</span>
        <div className="spacer" />
        <button className="btn primary" disabled={busy} onClick={reload}>
          {busy ? <span className="spinner" /> : '⟳'} Reload
        </button>
      </div>
      <div className="banner" style={{ borderRadius: 0 }}>
        Drop <code>*.js</code> files into the directory above, then Reload. Hooks run on every proxied request
        and response — see docs/Plugins.md.
      </div>
      <div className="panel-body">
        {plugins.length === 0 ? (
          <div className="empty">
            <div className="big">🧩</div>
            <div>
              No plugins installed.
              <br />
              Copy an example from <code>examples/plugins/</code> to get started.
            </div>
          </div>
        ) : (
          plugins.map((p) => (
            <div key={p.file} className="plugin-card">
              <div className="head">
                <label className="switch" title={p.enabled ? 'Disable' : 'Enable'}>
                  <input type="checkbox" checked={p.enabled} onChange={() => toggle(p)} />
                  <span className="track" />
                </label>
                <span className="name">{p.name}</span>
                {p.version && <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>v{p.version}</span>}
                <span className="file">{p.file}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-muted)' }}>
                  {p.hooks.join(' + ') || 'no hooks'}
                </span>
                <div style={{ flex: 1 }} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)' }}>
                  {p.hits} calls
                </span>
              </div>
              {p.error && <div className="plugin-err">{p.error}</div>}
              {p.log && p.log.length > 0 && <pre className="plugin-log">{p.log.join('\n')}</pre>}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function zoneLabel(z: RewriteZone): string {
  const found = ZONES.find(([zone]) => zone === z)
  return found ? found[1] : z
}
