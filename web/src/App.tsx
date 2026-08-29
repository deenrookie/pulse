import { useCallback, useEffect, useState } from 'react'
import ExtensionsView from './views/ExtensionsView'
import InterceptView from './views/InterceptView'
import ProxyView from './views/ProxyView'
import RepeaterView from './views/RepeaterView'
import SettingsView from './views/SettingsView'
import Icon, { type IconName } from './ui/Icon'
import { usePulse } from './state'

type Tab = 'proxy' | 'intercept' | 'repeater' | 'extensions' | 'settings'

const VIEWS: { id: Tab; icon: IconName; label: string; title: string; subtitle: string }[] = [
  { id: 'proxy', icon: 'waves', label: 'Live Traffic', title: 'Live Traffic', subtitle: 'Everything passing through the proxy, in real time' },
  { id: 'intercept', icon: 'hand', label: 'Intercept', title: 'Intercept', subtitle: 'Hold requests, edit them, then forward or drop' },
  { id: 'repeater', icon: 'repeat', label: 'Repeater', title: 'Repeater', subtitle: 'Edit and resend any captured request' },
  { id: 'extensions', icon: 'puzzle', label: 'Extensions', title: 'Extensions', subtitle: 'Match & Replace rules and JavaScript plugins' },
  { id: 'settings', icon: 'gear', label: 'Settings', title: 'Settings', subtitle: 'CA certificate, runtime configuration' },
]

export default function App() {
  const pulse = usePulse()
  const viewFromHash = () => {
    const h = window.location.hash.replace(/^#\/?/, '')
    return VIEWS.some((v) => v.id === h) ? (h as Tab) : null
  }
  const [tab, setTab] = useState<Tab>(() => {
    const fromHash = viewFromHash()
    if (fromHash) return fromHash
    try {
      const saved = localStorage.getItem('pulse.view')
      return VIEWS.some((v) => v.id === saved) ? (saved as Tab) : 'proxy'
    } catch {
      return 'proxy'
    }
  })
  const [railCollapsed, setRailCollapsed] = useState(() => {
    try {
      return localStorage.getItem('pulse.rail') === 'collapsed'
    } catch {
      return false
    }
  })

  const go = useCallback((t: Tab) => {
    setTab(t)
    try {
      localStorage.setItem('pulse.view', t)
    } catch {
      /* ignore */
    }
    window.history.replaceState(null, '', `#/${t}`)
  }, [])

  const toggleRail = useCallback(() => {
    setRailCollapsed((c) => {
      try {
        localStorage.setItem('pulse.rail', c ? 'expanded' : 'collapsed')
      } catch {
        /* ignore */
      }
      return !c
    })
  }, [])

  // follow #/view links while the app is already open (hashchange fires on
  // same-document navigation; our own go() uses replaceState so it never loops)
  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash.replace(/^#\/?/, '')
      if (VIEWS.some((v) => v.id === h) && h !== tab) {
        setTab(h as Tab)
        try {
          localStorage.setItem('pulse.view', h)
        } catch {
          /* ignore */
        }
      }
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [tab])

  // global shortcuts: Ctrl/Cmd+1..5 switch views, Ctrl/Cmd+F jumps to the
  // traffic filter (switches to Live Traffic first if needed)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key >= '1' && e.key <= '5') {
        e.preventDefault()
        go(VIEWS[Number(e.key) - 1].id)
      } else if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        if (tab !== 'proxy') go('proxy')
        window.dispatchEvent(new CustomEvent('pulse:focus-filter'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab, go])

  const view = VIEWS.find((v) => v.id === tab)!
  const repeaterCount = pulse.repeaterTabs.length
  const proxyShort = pulse.status ? pulse.status.proxyAddr.replace('127.0.0.1:', ':') : '…'

  return (
    <div className="shell">
      <nav className={`rail ${railCollapsed ? 'collapsed' : ''}`} aria-label="Views">
        <div className="rail-brand" title="Pulse">
          <span className="mark">
            <Icon name="pulse" size={20} />
          </span>
          <span className="word">
            PULSE<i>.</i>
          </span>
        </div>
        {VIEWS.map((v, i) => (
          <button
            key={v.id}
            className={`rail-item ${tab === v.id ? 'active' : ''}`}
            onClick={() => go(v.id)}
            title={`${v.title} (Ctrl+${i + 1})`}
          >
            <Icon name={v.icon} size={17} />
            <span className="rail-label">{v.label}</span>
            {v.id === 'intercept' && <span className="rail-badge">{pulse.intercept.pending.length || ''}</span>}
            {v.id === 'repeater' && repeaterCount > 0 && <span className="rail-badge">{repeaterCount}</span>}
          </button>
        ))}
        <div className="rail-footer">
          <div className={`rail-status ${pulse.connected ? '' : 'off'}`} title="Event stream / proxy listener">
            <span className="dot" />
            <span className="txt">{pulse.connected ? proxyShort : 'offline'}</span>
          </div>
          <button className="rail-collapse" onClick={toggleRail}>
            <Icon name="chevronsLeft" size={15} />
            <span className="txt">Collapse</span>
          </button>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <div>
            <div className="title">{view.title}</div>
            <div className="subtitle">{view.subtitle}</div>
          </div>
          <div className="spacer" />
          <label className="switch" title="Hold every request before it reaches the server">
            <input
              type="checkbox"
              checked={pulse.intercept.enabled}
              onChange={(e) => pulse.toggleIntercept(e.target.checked)}
            />
            <span className="track" />
            Intercept {pulse.intercept.enabled ? 'on' : 'off'}
          </label>
          <span className={`status-chip ${pulse.connected ? '' : 'off'}`} title="Proxy listener & event stream">
            <span className="dot" />
            {proxyShort}
          </span>
        </header>
        <div className="view-host">
          {tab === 'proxy' && <ProxyView pulse={pulse} />}
          {tab === 'intercept' && <InterceptView pulse={pulse} />}
          {tab === 'repeater' && <RepeaterView pulse={pulse} goProxy={() => go('proxy')} />}
          {tab === 'extensions' && <ExtensionsView notify={pulse.notify} />}
          {tab === 'settings' && <SettingsView pulse={pulse} />}
        </div>
      </div>

      {pulse.toast && (
        <div className={`toast ${pulse.toast.kind === 'err' ? 'err' : ''} ${pulse.toastLeaving ? 'leaving' : ''}`}>
          <Icon name={pulse.toast.kind === 'err' ? 'alert' : 'check'} size={14} />
          {pulse.toast.text}
        </div>
      )}
    </div>
  )
}
