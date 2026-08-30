import { useCallback, useEffect, useState } from 'react'
import ExtensionsView from './views/ExtensionsView'
import InterceptView from './views/InterceptView'
import ProxyView from './views/ProxyView'
import RepeaterView from './views/RepeaterView'
import SiteMapView from './views/SiteMapView'
import SettingsView from './views/SettingsView'
import Icon, { type IconName } from './ui/Icon'
import Decoder from './ui/Decoder'
import { usePulse } from './state'

type Tab = 'proxy' | 'intercept' | 'repeater' | 'sitemap' | 'extensions' | 'settings'
type Theme = 'warm' | 'midnight'

const THEMES: { id: Theme; label: string; hint: string }[] = [
  { id: 'warm', label: 'Warm', hint: 'Warm charcoal + cream (Warp)' },
  { id: 'midnight', label: 'Midnight', hint: 'Violet midnight + lime (Sentry)' },
]

function readTheme(): Theme {
  try {
    return localStorage.getItem('pulse.theme') === 'midnight' ? 'midnight' : 'warm'
  } catch {
    return 'warm'
  }
}

const VIEWS: { id: Tab; icon: IconName; label: string; title: string; subtitle: string }[] = [
  { id: 'proxy', icon: 'waves', label: 'Live Traffic', title: 'Live Traffic', subtitle: 'Everything passing through the proxy, in real time' },
  { id: 'intercept', icon: 'hand', label: 'Intercept', title: 'Intercept', subtitle: 'Hold requests, edit them, then forward or drop' },
  { id: 'repeater', icon: 'repeat', label: 'Repeater', title: 'Repeater', subtitle: 'Edit and resend any captured request' },
  { id: 'sitemap', icon: 'sitemap', label: 'Site Map', title: 'Site Map', subtitle: 'Every captured endpoint as a host → path tree' },
  { id: 'extensions', icon: 'puzzle', label: 'Extensions', title: 'Extensions', subtitle: 'Match & Replace rules and JavaScript plugins' },
  { id: 'settings', icon: 'gear', label: 'Settings', title: 'Settings', subtitle: 'CA certificate, runtime configuration' },
]

export default function App() {
  const pulse = usePulse()
  const viewFromHash = () => {
    // strip any query (#/repeater?tab=x → repeater) before matching a view
    const h = window.location.hash.replace(/^#\/?/, '').split('?')[0]
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
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [decoderOpen, setDecoderOpen] = useState(false)

  // apply theme to <html>, persist it, and keep the favicon in sync
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('pulse.theme', theme)
    } catch {
      /* ignore */
    }
    const bg = theme === 'midnight' ? '#150f23' : '#2b2622'
    const fg = theme === 'midnight' ? '#c2ef4e' : '#f7f5f0'
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>` +
      `<rect width='24' height='24' rx='5' fill='${bg}'/>` +
      `<path d='M3 12h4l2.5-7 4 14 2.5-7h5' fill='none' stroke='${fg}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>`
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']")
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      document.head.appendChild(link)
    }
    link.href = 'data:image/svg+xml,' + encodeURIComponent(svg)
  }, [theme])

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
      const h = window.location.hash.replace(/^#\/?/, '').split('?')[0]
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
      if (mod && e.key >= '1' && e.key <= '6') {
        e.preventDefault()
        go(VIEWS[Number(e.key) - 1].id)
      } else if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        if (tab !== 'proxy') go('proxy')
        window.dispatchEvent(new CustomEvent('pulse:focus-filter'))
      } else if (mod && e.key.toLowerCase() === 'r') {
        // Burp-style Ctrl+R: send the selected flow to Repeater. No jump —
        // the toast confirms, and the next Repeater visit focuses the newest.
        e.preventDefault()
        const target = e.target as HTMLElement
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
        // every view owns its notion of "current request" and handles the event
        window.dispatchEvent(new CustomEvent('pulse:send-to-repeater'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab, go, pulse.selectedId, pulse])

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
          <button
            className="rail-theme"
            onClick={() => setTheme((t) => (t === 'warm' ? 'midnight' : 'warm'))}
            title={`Theme: ${THEMES.find((t) => t.id === theme)!.hint} — click to switch`}
          >
            <span className="swatch" />
            <span className="txt">{THEMES.find((t) => t.id === theme)!.label}</span>
          </button>
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
          {tab === 'sitemap' && <SiteMapView pulse={pulse} goProxy={() => go('proxy')} />}
          {tab === 'extensions' && <ExtensionsView notify={pulse.notify} />}
          {tab === 'settings' && <SettingsView pulse={pulse} />}
        </div>

        <footer className="footbar">
        <button
          className="foot-tool"
          title="Decoder — encode/decode toolkit (draggable, pinnable)"
          onClick={() => setDecoderOpen(true)}
        >
          <Icon name="terminal" size={13} />
          Decoder
        </button>
        <span className="foot-sep" />
        <span className="foot-tool ghosted" title="More tools are on the way">
          <Icon name="puzzle" size={13} />
          Tools
        </span>
        <span className="spacer" />
        <span className={`foot-stat ${pulse.connected ? '' : 'off'}`} title="Proxy listener & event stream">
          <span className="dot" />
          {proxyShort}
        </span>
        <span className="foot-sep" />
        <span className="foot-stat" title="Flows captured (store)">
          <Icon name="waves" size={12} />
          {pulse.total.toLocaleString()}
        </span>
        {pulse.status?.memory && (
          <>
            <span className="foot-sep" />
            <span className="foot-stat" title="Go runtime — total memory obtained from the OS">
              <Icon name="bolt" size={12} />
              MEM {pulse.status.memory.sysMB} MB
            </span>
            <span className="foot-stat" title="Go runtime — live heap">
              HEAP {pulse.status.memory.heapMB} MB
            </span>
            <span className="foot-stat" title="Goroutines" style={{ display: 'none' }} />
          </>
        )}
      </footer>
      </div>

      {decoderOpen && <Decoder onClose={() => setDecoderOpen(false)} />}

      {pulse.toast && (
        <div className={`toast ${pulse.toast.kind === 'err' ? 'err' : ''} ${pulse.toastLeaving ? 'leaving' : ''}`}>
          <Icon name={pulse.toast.kind === 'err' ? 'alert' : 'check'} size={14} />
          {pulse.toast.text}
        </div>
      )}
    </div>
  )
}
