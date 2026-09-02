import { useEffect, useState } from 'react'
import * as api from '../api'
import Icon from '../ui/Icon'
import Empty from '../ui/Empty'
import Split from '../ui/Split'
import CodeEditor from '../ui/CodeEditor'
import { confirm } from '../ui/Confirm'
import ContextMenu, { type MenuItem } from '../components/ContextMenu'
import type { PluginInfo, PluginSample, PluginTestResult, RewriteRule, RewriteZone, TestMessage } from '../types'

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
      <div className="view-fill padded">{tab === 'rewrite' ? <RewritePanel notify={notify} /> : <PluginsPanel notify={notify} />}</div>
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

// ---------- plugin samples ----------
// Showcase sources live in the backend (internal/plugins/samples, embedded)
// and are fetched via /api/plugins/samples so the UI, the API and the test
// suite all exercise the very same code. This constant only seeds the
// editor's initial draft before anything is loaded.
const TEMPLATE_SRC = `plugin = {
  name: "My Plugin",
  version: "1.0",
};

function onRequest(ctx) {
  // ctx.request = { method, url, httpVersion, headers, body }
}

function onResponse(ctx) {
  // ctx.response = { status, reason, httpVersion, headers, body }
}`

type PluginTab = 'installed' | 'editor' | 'samples'

const defaultFixture = JSON.stringify(
  {
    request: {
      method: 'GET',
      url: 'http://example.com/api/v1/users',
      httpVersion: 'HTTP/1.1',
      headers: [
        { name: 'Host', value: 'example.com' },
        { name: 'Accept', value: 'application/json' },
      ],
      body: '',
    },
    response: {
      status: 200,
      reason: 'OK',
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      body: '{"token": "Bearer abc123.def456.ghi789"}',
    },
  },
  null,
  2,
)

function PluginsPanel({ notify }: { notify: (text: string, kind?: 'ok' | 'err') => void }) {
  const [tab, setTab] = useState<PluginTab>('installed')
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [dir, setDir] = useState('')
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; plugin: PluginInfo } | null>(null)

  // editor state lives here so plugin cards and samples can load into it
  const [file, setFile] = useState('my-plugin.js')
  const [src, setSrc] = useState(TEMPLATE_SRC)
  const [savedSrc, setSavedSrc] = useState<string | null>(null)

  const pluginMenu = (p: PluginInfo): MenuItem[] => [
    {
      icon: 'file',
      label: 'Edit source',
      onClick: () => void openInEditor(p),
    },
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

  const openInEditor = async (p: PluginInfo) => {
    try {
      const r = await api.getPluginSource(p.file)
      setFile(p.file)
      setSrc(r.src)
      setSavedSrc(r.src)
      setTab('editor')
    } catch (e) {
      notify((e as Error).message, 'err')
    }
  }

  const loadSample = (s: { file: string; src: string }) => {
    setFile(s.file)
    setSrc(s.src)
    setSavedSrc(null)
    setTab('editor')
  }

  return (
    <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="panel-head">
        <span className="title">Plugins</span>
        <div className="subtabs">
          <button className={`subtab ${tab === 'installed' ? 'active' : ''}`} onClick={() => setTab('installed')}>
            Installed
          </button>
          <button className={`subtab ${tab === 'editor' ? 'active' : ''}`} onClick={() => setTab('editor')}>
            Editor
          </button>
          <button className={`subtab ${tab === 'samples' ? 'active' : ''}`} onClick={() => setTab('samples')}>
            Samples
          </button>
        </div>
        <button className="btn primary" disabled={busy} onClick={reload}>
          {busy ? <span className="spinner" /> : <Icon name="refresh" size={13} />}
          Reload
        </button>
        <span className="meta" title={dir}>
          {dir}
        </span>
        <div className="spacer" />
      </div>
      {tab === 'installed' && (
        <InstalledTab plugins={plugins} dir={dir} busy={busy} notify={notify} onRefresh={refresh} onEdit={openInEditor} onToggle={toggle} onMenu={(x, y, p) => setMenu({ x, y, plugin: p })} />
      )}
      {tab === 'editor' && (
        <EditorTab dir={dir} plugins={plugins} notify={notify} onRefresh={refresh} file={file} setFile={setFile} src={src} setSrc={setSrc} savedSrc={savedSrc} setSavedSrc={setSavedSrc} />
      )}
      {tab === 'samples' && <SamplesTab onLoad={loadSample} notify={notify} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={pluginMenu(menu.plugin)} onClose={() => setMenu(null)} />}
    </div>
  )
}

function InstalledTab({
  plugins,
  dir,
  notify,
  onRefresh,
  onEdit,
  onToggle,
  onMenu,
}: {
  plugins: PluginInfo[]
  dir: string
  busy: boolean
  notify: (text: string, kind?: 'ok' | 'err') => void
  onRefresh: () => void
  onEdit: (p: PluginInfo) => void
  onToggle: (p: PluginInfo) => void
  onMenu: (x: number, y: number, p: PluginInfo) => void
}) {
  const [dirDraft, setDirDraft] = useState(dir)
  const [saving, setSaving] = useState(false)
  useEffect(() => setDirDraft(dir), [dir])

  const applyDir = async (value: string) => {
    setSaving(true)
    try {
      const r = await api.putSettings({ pluginsDir: value })
      setDirDraft(r.pluginsDir)
      notify(value.trim() === '' ? `Plugins directory reset to ${r.pluginsDir}` : `Plugins directory set to ${r.pluginsDir}`)
      onRefresh()
    } catch (e) {
      notify((e as Error).message, 'err')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="plugin-dir-row">
        <Icon name="file" size={13} />
        <span className="lbl">Plugin directory</span>
        <input
          className="input mono"
          style={{ flex: 1, minWidth: 200 }}
          title="Absolute path of the directory *.js plugins are loaded from. Empty = default <data-dir>/plugins."
          placeholder="<data-dir>/plugins"
          value={dirDraft}
          spellCheck={false}
          onChange={(e) => setDirDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void applyDir(dirDraft)}
        />
        <button className="btn ghost sm" disabled={saving || dirDraft === dir} onClick={() => void applyDir(dirDraft)}>
          Apply
        </button>
        <button className="btn ghost sm" disabled={saving} title="Reset to the default <data-dir>/plugins" onClick={() => void applyDir('')}>
          Reset
        </button>
      </div>
      <div className="banner">
        <Icon name="terminal" size={14} />
        <span>
          Hooks run on every proxied request and response. Manage sources in the <b>Editor</b> tab, copy ready-made
          examples from <b>Samples</b> — see <code>docs/Plugins.md</code>.
        </span>
      </div>
      <div className="panel-body">
        {plugins.length === 0 ? (
          <Empty icon="puzzle" title="No plugins installed">
            Open the <b>Editor</b> tab to write one online, or load a
            <br />
            sample from <b>Samples</b> to get started.
          </Empty>
        ) : (
          plugins.map((p) => (
            <div
              key={p.file}
              className="plugin-card"
              onContextMenu={(e) => {
                e.preventDefault()
                onMenu(e.clientX, e.clientY, p)
              }}
              title="Right-click for actions"
            >
              <div className="head">
                <label className="switch" title={p.enabled ? 'Disable' : 'Enable'}>
                  <input type="checkbox" checked={p.enabled} onChange={() => onToggle(p)} />
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
                <button className="btn ghost sm" onClick={() => onEdit(p)}>
                  Edit
                </button>
              </div>
              {p.error && <div className="plugin-err">{p.error}</div>}
              {p.log && p.log.length > 0 && <pre className="plugin-log">{p.log.join('\n')}</pre>}
            </div>
          ))
        )}
      </div>
    </>
  )
}

function EditorTab({
  dir,
  plugins,
  notify,
  onRefresh,
  file,
  setFile,
  src,
  setSrc,
  savedSrc,
  setSavedSrc,
}: {
  dir: string
  plugins: PluginInfo[]
  notify: (text: string, kind?: 'ok' | 'err') => void
  onRefresh: () => void
  file: string
  setFile: (f: string) => void
  src: string
  setSrc: (s: string) => void
  savedSrc: string | null
  setSavedSrc: (s: string | null) => void
}) {
  const [busy, setBusy] = useState(false)
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null)
  const [hook, setHook] = useState<'request' | 'response'>('request')
  const [fixture, setFixture] = useState(defaultFixture)
  const [result, setResult] = useState<PluginTestResult | null>(null)
  const exists = plugins.some((p) => p.file === file)

  const fileNameOk = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.js$/.test(file)

  const doCheck = async () => {
    setBusy(true)
    try {
      const r = await api.validatePlugin(src)
      setCheck(r.error ? { ok: false, text: r.error } : { ok: true, text: `compiles · hooks: ${r.hooks.length ? r.hooks.join(', ') : 'none'}${r.name ? ` · ${r.name}` : ''}` })
    } catch (e) {
      setCheck({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const doSave = async () => {
    if (!fileNameOk) {
      setCheck({ ok: false, text: `invalid file name — want name.js, no path separators: ${file}` })
      return
    }
    setBusy(true)
    try {
      const r = await api.savePluginSource(file, src)
      setSavedSrc(src)
      onRefresh()
      if (r.error) {
        setCheck({ ok: false, text: `saved, but it does not load: ${r.error}` })
        notify(`${file} saved — compile error, plugin inactive`, 'err')
      } else {
        setCheck({ ok: true, text: `saved to ${r.dir} · active` })
        notify(`${file} saved and active`)
      }
    } catch (e) {
      setCheck({ ok: false, text: (e as Error).message })
      notify((e as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async () => {
    const ok = await confirm({ title: `Delete ${file}?`, message: 'The file is removed from the plugin directory.', confirmLabel: 'Delete', danger: true })
    if (!ok) return
    setBusy(true)
    try {
      await api.deletePluginSource(file)
      setSavedSrc(null)
      onRefresh()
      notify(`${file} deleted`)
    } catch (e) {
      notify((e as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const doTest = async () => {
    let fx: { request: TestMessage; response?: TestMessage }
    try {
      const parsed = JSON.parse(fixture)
      if (!parsed || typeof parsed !== 'object' || !parsed.request) throw new Error('fixture must be an object with a "request" member')
      fx = parsed
    } catch (e) {
      notify(`Fixture is not valid JSON: ${(e as Error).message}`, 'err')
      return
    }
    setBusy(true)
    setResult(null)
    try {
      const r = await api.testPlugin({ src, hook, request: fx.request, response: fx.response })
      setResult(r)
    } catch (e) {
      notify((e as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="plugin-editor" onKeyDown={(e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        void doSave()
      }
    }}>
      <div className="editor-toolbar">
        <input
          className="input mono"
          style={{ width: 220 }}
          title="File name inside the plugin directory"
          value={file}
          spellCheck={false}
          onChange={(e) => setFile(e.target.value)}
        />
        {!fileNameOk && <span className="plugin-status err">name must be *.js</span>}
        {savedSrc !== null && src !== savedSrc && (
          <span className="plugin-status warn" title="Edited since last save">
            ● unsaved
          </span>
        )}
        {check && <span className={`plugin-status ${check.ok ? 'ok' : 'err'}`}>{check.ok ? '✓ ' : '✗ '}{check.text}</span>}
        <div className="spacer" />
        <button className="btn ghost sm" disabled={busy} title="Dry-compile without saving" onClick={doCheck}>
          <Icon name="check" size={13} />
          Check
        </button>
        {exists && (
          <button className="btn danger sm" disabled={busy} onClick={doDelete}>
            Delete
          </button>
        )}
        <button className="btn primary sm" disabled={busy} title={`Write to ${dir}`} onClick={doSave}>
          {busy ? <span className="spinner" /> : <Icon name="download" size={13} />}
          Save to disk
        </button>
      </div>
      <Split
        dir="v"
        storageKey="pulse.split.pluginEditor"
        initial={0.62}
        a={<CodeEditor value={src} onChange={setSrc} language="js" />}
        b={
          <div className="plugin-test">
            <div className="fixture-head">
              <span className="lbl">Test fixture</span>
              <label className="switch" title="Which hook the test run executes">
                <input type="checkbox" checked={hook === 'response'} onChange={(e) => setHook(e.target.checked ? 'response' : 'request')} />
                <span className="track" />
                onResponse
              </label>
              <span className="faint" style={{ fontSize: 11 }}>
                runs against this JSON — no traffic is sent
              </span>
              <div className="spacer" />
              <button className="btn ghost sm" disabled={busy} title="Run the hook against the fixture" onClick={doTest}>
                {busy ? <span className="spinner" /> : <Icon name="play" size={13} />}
                Test run
              </button>
            </div>
            <CodeEditor value={fixture} onChange={setFixture} language="json" />
            {result && (
              <div className="plugin-test-result">
                {result.error ? (
                  <div className="plugin-err">{result.error}</div>
                ) : (
                  <div className="plugin-status ok">✓ ran clean · {result.changed ? 'message modified' : 'no changes'}</div>
                )}
                {result.logs.length > 0 && (
                  <pre className="plugin-log">{result.logs.map((l, i) => `${String(i + 1).padStart(2, ' ')}  ${l}`).join('\n')}</pre>
                )}
                {result.changed && (
                  <pre className="plugin-log">
                    {`→ request ${result.request.method ?? ''} ${result.request.url ?? ''}`}
                    {result.request.headers?.map((h) => `\n  ${h.name}: ${h.value}`).join('') ?? ''}
                    {result.request.body ? `\n  body: ${result.request.body}` : ''}
                    {result.response
                      ? `\n→ response ${result.response.status ?? ''} ${result.response.reason ?? ''}${result.response.headers?.map((h) => `\n  ${h.name}: ${h.value}`).join('') ?? ''}${result.response.body ? `\n  body: ${result.response.body}` : ''}`
                      : ''}
                  </pre>
                )}
              </div>
            )}
          </div>
        }
      />
    </div>
  )
}

function SamplesTab({ onLoad, notify }: { onLoad: (s: { file: string; src: string }) => void; notify: (text: string, kind?: 'ok' | 'err') => void }) {
  const [samples, setSamples] = useState<PluginSample[]>([])

  useEffect(() => {
    api
      .listPluginSamples()
      .then((r) => setSamples(r.samples))
      .catch(() => notify('Failed to load samples', 'err'))
  }, [notify])

  const copy = async (s: PluginSample) => {
    try {
      await navigator.clipboard.writeText(s.src)
      notify(`${s.file} copied to clipboard`)
    } catch {
      notify('Clipboard unavailable', 'err')
    }
  }
  return (
    <div className="panel-body">
      {samples.map((s) => (
        <div key={s.file} className="sample-card">
          <div className="head">
            <span className="name mono">{s.file}</span>
            <span className="faint" style={{ fontSize: 11 }}>{s.desc}</span>
            <div className="grow" />
            <button className="btn ghost sm" onClick={() => copy(s)}>
              <Icon name="copy" size={13} />
              Copy
            </button>
            <button className="btn ghost sm" title="Open in the Editor tab" onClick={() => onLoad(s)}>
              Load into editor
            </button>
          </div>
          <div className="sample-code">
            <CodeEditor value={s.src} onChange={() => {}} language="js" readOnly autoHeight />
          </div>
        </div>
      ))}
    </div>
  )
}

function zoneLabel(z: RewriteZone): string {
  const found = ZONES.find(([zone]) => zone === z)
  return found ? found[1] : z
}
