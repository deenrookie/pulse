import { useState } from 'react'
import ExtensionsView from './views/ExtensionsView'
import InterceptView from './views/InterceptView'
import ProxyView from './views/ProxyView'
import RepeaterView from './views/RepeaterView'
import SettingsView from './views/SettingsView'
import { usePulse } from './state'

type Tab = 'proxy' | 'intercept' | 'repeater' | 'extensions' | 'settings'

const TABS: [Tab, string][] = [
  ['proxy', 'Proxy'],
  ['intercept', 'Intercept'],
  ['repeater', 'Repeater'],
  ['extensions', 'Extensions'],
  ['settings', 'Settings'],
]

export default function App() {
  const pulse = usePulse()
  const [tab, setTab] = useState<Tab>('proxy')

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="logo">Pulse</span>
          <span className="ver">{pulse.status ? `v${pulse.status.version}` : ''}</span>
        </div>
        <nav className="nav-tabs">
          {TABS.map(([t, label]) => (
            <button key={t} className={`nav-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {label}
              {t === 'intercept' && (
                <span className="badge" data-zero={pulse.intercept.pending.length === 0 ? '1' : '0'}>
                  {pulse.intercept.pending.length || ''}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="header-right">
          <label className="switch" title="Hold requests before they reach the server">
            <input
              type="checkbox"
              checked={pulse.intercept.enabled}
              onChange={(e) => pulse.toggleIntercept(e.target.checked)}
            />
            <span className="track" />
            Intercept {pulse.intercept.enabled ? 'on' : 'off'}
          </label>
          <span className={`chip ${pulse.connected ? '' : 'off'}`} title="Proxy listener and event stream">
            <span className="dot" />
            {pulse.status ? pulse.status.proxyAddr.replace('127.0.0.1:', ':') : '…'}
          </span>
        </div>
      </header>
      <main className="app-main">
        {tab === 'proxy' && <ProxyView pulse={pulse} />}
        {tab === 'intercept' && <InterceptView pulse={pulse} />}
        {tab === 'repeater' && <RepeaterView pulse={pulse} goProxy={() => setTab('proxy')} />}
        {tab === 'extensions' && <ExtensionsView notify={pulse.notify} />}
        {tab === 'settings' && <SettingsView pulse={pulse} />}
      </main>
      {pulse.toast && (
        <div className={`toast ${pulse.toast.kind === 'err' ? 'err' : ''} ${pulse.toastLeaving ? 'leaving' : ''}`}>
          {pulse.toast.text}
        </div>
      )}
    </div>
  )
}
