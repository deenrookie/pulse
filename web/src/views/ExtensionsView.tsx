import { useEffect, useState } from 'react'
import * as api from '../api'
import Icon from '../ui/Icon'
import Empty from '../ui/Empty'
import { confirm } from '../ui/Confirm'
import ContextMenu, { type MenuItem } from '../components/ContextMenu'
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
    <div className="view">
      <div className="ext-tabs">
        <button className={`ext-tab ${tab === 'rewrite' ? 'active' : ''}`} onClick={() => setTab('rewrite')}>
          <Icon name="arrowDownUp" size={14} />
          Match &amp; Replace
        </button>
        <button className={`ext-tab ${tab === 'plugins' ? 'active' : ''}`} onClick={() => setTab('plugins')}>
          <Icon name="puzzle" size={14} />
          Plugins
        </button>
      </div>
      <div className="view padded" style={{ position: 'relative' }}>
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
  const [menu, setMenu] = useState<{ x: number; y: number; rule: RewriteRule } | null>(null)

  const rowMenu = (r: RewriteRule): MenuItem[] => [
    {
      icon: 'file',
      label: 'Edit rule',
      onClick: () => edit(r),
    },
    {
      icon: r.enabled ? 'minus' : 'check',
      label: r.enabled ? 'Disable rule' : 'Enable rule',
      onClick: () => void toggle(r),
    },
    {
      icon: 'trash',
      label: 'Delete rule',
      danger: true,
      separatorAfter: true,
      onClick: () => void remove(r),
    },
  ]

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
    const ok = await confirm({
      title: 'Delete rule?',
      message: `«${r.match}» will no longer rewrite traffic.`,
      confirmLabel: 'Delete rule',
      danger: true,
    })
    if (!ok) return
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

  const totalHits = rules.reduce((n, r) => n + r.hits, 0)

  return (
    <div className="panel" style={{ flex: 1 }}>
      <div className="panel-head">
        <span className="title">{editingId ? 'Edit rule' : 'Rules'}</span>
        <button className="btn primary" disabled={busy} onClick={submit}>
          {busy ? <span className="spinner" /> : <Icon name="plus" size={13} />}
          {editingId ? 'Save' : 'Add rule'}
        </button>
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
        <span className="meta">rules run on proxy traffic after plugins, before interception</span>
        <div className="spacer" />
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
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <input
          className="input"
          placeholder="Replace with"
          value={draft.replace}
          spellCheck={false}
          onChange={(e) => setDraft({ ...draft, replace: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
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
          spellCheck={false}
          onChange={(e) => setDraft({ ...draft, comment: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>
      <div className="panel-body">
        {rules.length === 0 ? (
          <Empty icon="arrowDownUp" title="No rules yet">
            Rewrite headers, bodies or URLs on the fly — e.g. strip a cookie,
            <br />
            rewrite an API version, redact tokens in responses.
          </Empty>
        ) : (
          <table className="rules-table">
            <thead>
              <tr>
                <th style={{ width: 44 }}>On</th>
                <th style={{ width: 160 }}>Applies to</th>
                <th>Match</th>
                <th>Replace</th>
                <th style={{ width: 56 }}>Regex</th>
                <th>Comment</th>
                <th style={{ width: 60, textAlign: 'right' }}>Hits</th>
                <th style={{ width: 106 }} />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr
                  key={r.id}
                  onDoubleClick={() => edit(r)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ x: e.clientX, y: e.clientY, rule: r })
                  }}
                  title="Double-click to edit - right-click for actions"
                >
                  <td>
                    <label className="switch">
                      <input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} />
                      <span className="track" />
                    </label>
                  </td>
                  <td>
                    <span className={`zone-chip ${r.zone.startsWith('request') ? 'z-req' : 'z-resp'}`}>
                      {zoneLabel(r.zone)}
                    </span>
                  </td>
                  <td className="cell-clip" title={r.match}>
                    <span className="mono">{r.match}</span>
                  </td>
                  <td className="cell-clip" title={r.replace}>
                    {r.replace ? <span className="mono">{r.replace}</span> : <span className="faint">(empty)</span>}
                  </td>
                  <td className="muted">{r.regex ? '.*' : 'abc'}</td>
                  <td className="muted cell-clip" title={r.comment}>
                    {r.comment}
                  </td>
                  <td style={{ textAlign: 'right' }} className="faint">
                    {r.hits}
                  </td>
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
      {rules.length > 0 && (
        <div className="panel-head" style={{ borderTop: '1px solid var(--border)', borderBottom: 'none', height: 34 }}>
          <span className="meta">
            {rules.length} rules · {totalHits.toLocaleString()} total hits
          </span>
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={rowMenu(menu.rule)} onClose={() => setMenu(null)} />}
    </div>
  )
}

function PluginsPanel({ notify }: { notify: (text: string, kind?: 'ok' | 'err') => void }) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [dir, setDir] = useState('')
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; plugin: PluginInfo } | null>(null)

  const pluginMenu = (p: PluginInfo): MenuItem[] => [
    {
      icon: p.enabled ? 'minus' : 'check',
      label: p.enabled ? 'Disable plugin' : 'Enable plugin',
      onClick: () => void toggle(p),
    },
    {
      icon: 'refresh',
      label: 'Reload all plugins',
      separatorAfter: true,
      onClick: () => void reload(),
    },
  ]

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
        <button className="btn primary" disabled={busy} onClick={reload}>
          {busy ? <span className="spinner" /> : <Icon name="refresh" size={13} />}
          Reload
        </button>
        <span className="meta" title={dir}>
          {dir}
        </span>
        <div className="spacer" />
      </div>
      <div className="banner">
        <Icon name="terminal" size={14} />
        <span>
          Drop <code>*.js</code> files into the directory above, then Reload. Hooks run on every proxied request
          and response — see <code>docs/Plugins.md</code>.
        </span>
      </div>
      <div className="panel-body">
        {plugins.length === 0 ? (
          <Empty icon="puzzle" title="No plugins installed">
            Copy an example from <b>examples/plugins/</b> into the plugin
            <br />
            directory to get started.
          </Empty>
        ) : (
          plugins.map((p) => (
            <div
              key={p.file}
              className="plugin-card"
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, plugin: p })
              }}
              title="Right-click for actions"
            >
              <div className="head">
                <label className="switch" title={p.enabled ? 'Disable' : 'Enable'}>
                  <input type="checkbox" checked={p.enabled} onChange={() => toggle(p)} />
                  <span className="track" />
                </label>
                <span className="name">{p.name}</span>
                {p.version && <span className="faint" style={{ fontSize: 11 }}>v{p.version}</span>}
                <span className="file">{p.file}</span>
                {p.hooks.map((h) => (
                  <span key={h} className="hook-tag">
                    {h}()
                  </span>
                ))}
                <div className="grow" />
                <span className="faint mono" style={{ fontSize: 11 }}>
                  {p.hits} calls
                </span>
              </div>
              {p.error && <div className="plugin-err">{p.error}</div>}
              {p.log && p.log.length > 0 && <pre className="plugin-log">{p.log.join('\n')}</pre>}
            </div>
          ))
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={pluginMenu(menu.plugin)} onClose={() => setMenu(null)} />}
    </div>
  )
}

function zoneLabel(z: RewriteZone): string {
  const found = ZONES.find(([zone]) => zone === z)
  return found ? found[1] : z
}
