import Icon from '../ui/Icon'
import { getSettings, putSettings, apiBase, getRemoteConfig, saveRemoteConfig, checkUpdate, applyUpdate, restartUpdate } from '../api'
import type { UpdateInfo } from '../api'
import type { PulseState } from '../state'
import { useEffect, useState } from 'react'
import { applyFontSize, loadFontSize, FONT_DEFAULT, FONT_MIN, FONT_MAX } from '../ui/fontSize'

export default function SettingsView({ pulse }: { pulse: PulseState }) {
  const st = pulse.status
  const [timeoutSec, setTimeoutSec] = useState<number | null>(null)
  const [memGuard, setMemGuard] = useState<number | null>(null)
  const [largeBody, setLargeBody] = useState<number | null>(null)
  const [proxyAddr, setProxyAddr] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState(0)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [fontSize, setFontSize] = useState(loadFontSize)

  // self-update: check → confirm → download+swap → restart → reconnect
  const [upd, setUpd] = useState<UpdateInfo | null>(null)
  const [applied, setApplied] = useState<string | null>(null)
  const [updBusy, setUpdBusy] = useState<'check' | 'apply' | 'restart' | null>(null)
  const [updErr, setUpdErr] = useState<string | null>(null)

  const doCheck = async () => {
    setUpdErr(null)
    setUpdBusy('check')
    try {
      setUpd(await checkUpdate())
    } catch (e) {
      setUpdErr((e as Error).message)
    } finally {
      setUpdBusy(null)
    }
  }

  const doApply = async () => {
    setUpdErr(null)
    setUpdBusy('apply')
    try {
      const r = await applyUpdate()
      setUpd(r)
      setApplied(r.latest)
      pulse.notify(`Upgraded to v${r.latest} — restart to finish`)
    } catch (e) {
      setUpdErr((e as Error).message)
    } finally {
      setUpdBusy(null)
    }
  }

  const doRestart = async () => {
    setUpdErr(null)
    setUpdBusy('restart')
    try {
      await restartUpdate()
    } catch {
      /* the process may exit before the response lands — treat as started */
    }
    // poll until the new binary answers, then hard-reload the app
    const deadline = Date.now() + 30_000
    const poll = async () => {
      if (Date.now() > deadline) {
        setUpdBusy(null)
        setUpdErr('Restart timed out — start Pulse manually and refresh.')
        return
      }
      try {
        const r = await fetch('/api/status', { cache: 'no-store' })
        if (r.ok) {
          await r.json()
          location.reload()
          return
        }
      } catch {
        /* still down */
      }
      setTimeout(poll, 600)
    }
    setTimeout(poll, 1500)
  }

  // hosted-panel remote access: server address + access key, localStorage only
  const [remoteServer, setRemoteServer] = useState(() => getRemoteConfig()?.server ?? '')
  const [remoteKey, setRemoteKey] = useState(() => getRemoteConfig()?.key ?? '')
  const [remoteTest, setRemoteTest] = useState<string | null>(null)

  const saveRemote = () => {
    const server = remoteServer.trim().replace(/\/+$/, '')
    setRemoteServer(server)
    saveRemoteConfig(server ? { server, key: remoteKey } : null)
    setRemoteTest(null)
    pulse.notify(server ? `Panel will use ${server}` : 'Remote instance cleared — using the local API')
  }

  const testRemote = async () => {
    const server = remoteServer.trim().replace(/\/+$/, '')
    if (!server) return
    setRemoteTest('testing…')
    try {
      const r = await fetch(server + '/api/status', { headers: remoteKey ? { 'X-Pulse-Key': remoteKey } : {} })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      await r.json()
      setRemoteTest(`✓ reachable — panel will drive ${server}`)
    } catch (e) {
      setRemoteTest(`✗ ${(e as Error).message} — is Pulse running there, the key right, and is it bound to a reachable address?`)
    }
  }

  useEffect(() => {
    getSettings()
      .then((s) => {
        setTimeoutSec(s.responseTimeoutSec)
        setMemGuard(s.memoryGuardMB)
        setLargeBody(s.largeBodyMB)
        setProxyAddr(s.proxyAddr)
      })
      .catch(() => {})
  }, [])

  const saveGuard = async () => {
    if (memGuard === null || largeBody === null) return
    setSaveErr(null)
    try {
      const s = await putSettings({ memoryGuardMB: memGuard, largeBodyMB: largeBody })
      setMemGuard(s.memoryGuardMB)
      setLargeBody(s.largeBodyMB)
      setSavedAt(Date.now())
      pulse.notify(`Memory guard: ${s.memoryGuardMB} MB budget, drop binary bodies over ${s.largeBodyMB} MB`)
    } catch (e) {
      setSaveErr((e as Error).message)
    }
  }

  const saveTimeout = async () => {
    if (timeoutSec === null) return
    setSaveErr(null)
    try {
      const s = await putSettings({ responseTimeoutSec: timeoutSec })
      setTimeoutSec(s.responseTimeoutSec)
      setSavedAt(Date.now())
      pulse.notify(`Repeater send timeout set to ${s.responseTimeoutSec}s`)
    } catch (e) {
      setSaveErr((e as Error).message)
    }
  }
  const saveProxyAddr = async () => {
    if (proxyAddr === null) return
    setSaveErr(null)
    try {
      const s = await putSettings({ proxyAddr: proxyAddr.trim() })
      setProxyAddr(s.proxyAddr)
      setSavedAt(Date.now())
      pulse.notify(`Proxy listener rebound to ${s.proxyAddr} — point your browser proxy there`)
    } catch (e) {
      setSaveErr((e as Error).message)
    }
  }

  return (
    <div className="view">
      <div className="settings-wrap">
        <div className="settings">
        <div className="card">
          <h3>
            <Icon name="lock" size={15} />
            CA certificate
          </h3>
          <div className="sub">
            Install this certificate to let Pulse decrypt HTTPS traffic. Pulse never modifies your system
            trust store itself — remove the certificate when you stop testing.
          </div>
          <a className="btn primary" href={apiBase() + '/api/cert'} download="pulse-ca.pem">
            <Icon name="download" size={13} />
            Download pulse-ca.pem
          </a>
          {st && (
            <div className="fingerprint">
              <Icon name="shield" size={14} style={{ flex: 'none', color: 'var(--text-faint)' }} />
              <code title="SHA-256 fingerprint of this instance's CA">{st.caFingerprint}</code>
            </div>
          )}
        </div>

        <div className="card">
          <h3>
            <Icon name="globe" size={15} />
            Remote instance
          </h3>
          <div className="sub">
            Point this panel at a Pulse instance on another machine — run it there with{' '}
            <code>--ui 0.0.0.0:8787</code>, then fill in its address and access key. Saved in this browser
            (localStorage); the hosted panel then drives that instance instead of the local one.
          </div>
          <div className="kv-grid">
            <div className="k">Server address</div>
            <div className="v" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="input mono"
                style={{ width: 250 }}
                placeholder="http://192.168.1.5:8787"
                value={remoteServer}
                spellCheck={false}
                onChange={(e) => setRemoteServer(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveRemote()}
              />
            </div>
            <div className="k">Access key</div>
            <div className="v" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="input mono"
                style={{ width: 250 }}
                placeholder="PULSE_KEY or the startup key"
                value={remoteKey}
                spellCheck={false}
                onChange={(e) => setRemoteKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveRemote()}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '10px 0 6px' }}>
            <button className="btn primary sm" onClick={saveRemote}>
              <Icon name="check" size={13} />
              Save
            </button>
            <button className="btn sm" onClick={() => void testRemote()}>
              <Icon name="bolt" size={13} />
              Test connection
            </button>
            {(remoteServer || remoteKey) && (
              <button
                className="btn ghost sm"
                onClick={() => {
                  setRemoteServer('')
                  setRemoteKey('')
                  setRemoteTest(null)
                  saveRemoteConfig(null)
                  pulse.notify('Remote instance cleared — using the local API')
                }}
              >
                Clear
              </button>
            )}
          </div>
          {remoteTest && <div className="sub" style={{ marginBottom: 0 }}>{remoteTest}</div>}
          {st?.accessKey && (
            <div className="fingerprint" title="This instance's access key — copy it into the hosted panel">
              <Icon name="lock" size={14} style={{ flex: 'none', color: 'var(--text-faint)' }} />
              <code>this instance's key: {st.accessKey}</code>
            </div>
          )}
        </div>

        <div className="card">
          <h3>
            <Icon name="gear" size={15} />
            Installing the CA
          </h3>
          <div className="sub">Pick the environment you test in:</div>
          <ol className="steps">
            <li>
              <b>Windows</b> — Win+R → <code>certmgr.msc</code> → Trusted Root Certification Authorities →
              Import <code>pulse-ca.pem</code>. Or run:
              <div>
                <code>certutil -addstore -user root pulse-ca.pem</code>
              </div>
            </li>
            <li>
              <b>macOS</b> — Keychain Access → System → Import → double-click “Pulse CA” → set to “Always
              Trust”.
            </li>
            <li>
              <b>Firefox</b> — Settings → Privacy &amp; Security → Certificates → View Certificates → Import →
              check “Trust this CA to identify websites”.
            </li>
            <li>
              <b>Linux (Chrome/Chromium)</b> —{' '}
              <code>certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "Pulse CA" -i pulse-ca.pem</code>
            </li>
          </ol>
        </div>

        <div className="card">
          <h3>
            <Icon name="download" size={15} />
            Updates
          </h3>
          <div className="sub">
            Current backend version and GitHub release check — the upgrade downloads the release
            archive for this platform, swaps the binary in place and restarts Pulse.
          </div>
          <div className="update-row">
            <span className="mono">
              {st ? `v${st.version}` : '…'}
            </span>
            {!upd && (
              <button className="btn sm" disabled={!!updBusy} onClick={() => void doCheck()}>
                {updBusy === 'check' ? <span className="spinner" /> : <Icon name="refresh" size={12} />}
                Check for updates
              </button>
            )}
            {upd?.htmlUrl && (
              <a className="btn ghost sm" href={upd.htmlUrl} target="_blank" rel="noreferrer">
                Release notes
              </a>
            )}
          </div>
          {updErr && <div className="update-err">{updErr}</div>}
          {upd && !updErr && (
            <div className={`update-banner ${upd.newer ? 'newer' : ''}`}>
              {upd.newer ? (
                <>
                  <b>v{upd.latest}</b> is available ({upd.assetName ?? 'no asset for this platform'}
                  {upd.size ? ` · ${(upd.size / 1048576).toFixed(1)} MB` : ''}).
                  {!upd.assetUrl && ' This platform has no release archive — update manually.'}
                  {upd.assetUrl && (
                    <button className="btn sm primary" disabled={!!updBusy} onClick={() => void doApply()}>
                      {updBusy === 'apply' ? <span className="spinner" /> : <Icon name="download" size={12} />}
                      {updBusy === 'apply' ? `Downloading v${upd.latest}…` : `Upgrade to v${upd.latest}`}
                    </button>
                  )}
                </>
              ) : (
                <>Up to date — v{upd.latest} is the latest release.</>
              )}
            </div>
          )}
          {applied && (
            <div className="update-banner newer">
              <b>v{applied}</b> downloaded and swapped — restart to finish.
              <button className="btn sm primary" disabled={!!updBusy} onClick={() => void doRestart()}>
                {updBusy === 'restart' ? <span className="spinner" /> : <Icon name="refresh" size={12} />}
                {updBusy === 'restart' ? 'Restarting…' : 'Restart now'}
              </button>
            </div>
          )}
        </div>

        <div className="card">
          <h3>
            <Icon name="gear" size={15} />
            Runtime
          </h3>
          <div className="sub">Current process configuration and counters.</div>
          {st ? (
            <div className="kv-grid">
              <div className="k">Version</div>
              <div className="v">{st.version}</div>
              <div className="k">Proxy listener</div>
              <div className="v" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  className="input mono"
                  style={{ width: 190 }}
                  title="Proxy listen address — rebinds without restart, survives restarts"
                  placeholder="127.0.0.1:8080"
                  value={proxyAddr ?? ''}
                  spellCheck={false}
                  onChange={(e) => setProxyAddr(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveProxyAddr()}
                />
                <button className="btn sm" disabled={proxyAddr === null || proxyAddr.trim() === '' || proxyAddr.trim() === st.proxyAddr} onClick={saveProxyAddr}>
                  Apply
                </button>
              </div>
              <div className="k">UI / API</div>
              <div className="v">{st.uiAddr}</div>
              <div className="k">Data directory</div>
              <div className="v">{st.dataDir}</div>
              <div className="k">Flows captured</div>
              <div className="v">
                {st.flows.total} ({st.flows.pending} in flight)
              </div>
              <div className="k">Browser proxy setup</div>
              <div className="v">HTTP proxy → {st.proxyAddr} (HTTPS same address; no exceptions needed)</div>
            </div>
          ) : (
            <div className="spinner" />
          )}
        </div>

        <div className="card">
          <h3>
            <Icon name="contrast" size={15} />
            Interface
          </h3>
          <div className="sub">
            Base UI font size — every surface (raw views, tables, menus) scales with it. Default {FONT_DEFAULT}px;
            applies instantly and persists.
          </div>
          <div className="font-row">
            <input
              type="range"
              min={FONT_MIN}
              max={FONT_MAX}
              step={0.5}
              value={fontSize}
              aria-label="UI font size"
              onChange={(e) => setFontSize(applyFontSize(Number(e.target.value)))}
            />
            <span className="font-val">{fontSize}px</span>
            <button className="btn sm" disabled={fontSize === FONT_DEFAULT} onClick={() => setFontSize(applyFontSize(FONT_DEFAULT))}>
              Reset
            </button>
          </div>
        </div>

        <div className="card">
          <h3>
            <Icon name="shield" size={15} />
            Memory guard
          </h3>
          <div className="sub">
            Once stored bodies exceed the budget, newly captured <b>binary</b> responses (video, audio, images,
            octet-stream shards) larger than the drop size are recorded without their body — a YouTube session
            would otherwise grow the heap into the gigabytes. Text/JSON bodies are always kept. Defaults: 500 MB
            budget, drop over 3 MB.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              className="input"
              type="number"
              min={16}
              max={65536}
              style={{ width: 100 }}
              value={memGuard ?? ''}
              onChange={(e) => setMemGuard(parseInt(e.target.value, 10) || 0)}
            />
            <span className="faint">MB budget · drop binary bodies over</span>
            <input
              className="input"
              type="number"
              min={1}
              max={64}
              style={{ width: 80 }}
              value={largeBody ?? ''}
              onChange={(e) => setLargeBody(parseInt(e.target.value, 10) || 0)}
            />
            <span className="faint">MB</span>
            <button
              className="btn primary sm"
              onClick={() => void saveGuard()}
              disabled={!memGuard || !largeBody || memGuard < 16 || memGuard > 65536 || largeBody < 1 || largeBody > 64}
            >
              Save
            </button>
            {savedAt > 0 && !saveErr && (
              <span className="faint" key={savedAt} style={{ animation: 'hist-flash 700ms var(--ease-out)' }}>
                saved
              </span>
            )}
            {saveErr && <span className="err-inline">{saveErr}</span>}
          </div>
        </div>

        <div className="card">
          <h3>
            <Icon name="clock" size={15} />
            Timeouts
          </h3>
          <div className="sub">
            How long a <b>Repeater send</b> waits for the response before giving up (1–600 seconds, default 30).
            Proxied traffic keeps the standard timeout, like Burp.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="input"
              type="number"
              min={1}
              max={600}
              style={{ width: 110 }}
              value={timeoutSec ?? ''}
              onChange={(e) => setTimeoutSec(parseInt(e.target.value, 10) || 0)}
            />
            <span className="faint">seconds</span>
            <button className="btn primary sm" onClick={() => void saveTimeout()} disabled={!timeoutSec || timeoutSec < 1 || timeoutSec > 600}>
              Save
            </button>
            {savedAt > 0 && !saveErr && <span className="faint" key={savedAt} style={{ animation: 'hist-flash 700ms var(--ease-out)' }}>saved</span>}
            {saveErr && <span className="err-inline">{saveErr}</span>}
          </div>
        </div>

        <div className="card">
          <h3>
            <Icon name="alert" size={15} />
            Known limits
          </h3>
          <ul className="steps" style={{ lineHeight: 1.9 }}>
            <li>Message bodies are captured up to 10&nbsp;MB (larger ones are truncated, flagged in the UI).</li>
            <li>WebSocket traffic is tunneled (handshake visible, frames are not parsed).</li>
            <li>Clients with certificate pinning cannot be intercepted.</li>
            <li>Streaming responses are shown once the stream finishes.</li>
          </ul>
        </div>

        <div className="card">
          <h3>
            <Icon name="eye" size={15} />
            Keyboard shortcuts
          </h3>
          <div className="kv-grid">
            <div className="k">Switch views</div>
            <div className="v"><kbd>Ctrl 1</kbd> … <kbd>Ctrl 7</kbd></div>
            <div className="k">Deep search</div>
            <div className="v"><kbd>Ctrl ⇧ F</kbd></div>
            <div className="k">Send (Repeater)</div>
            <div className="v"><kbd>Ctrl ↵</kbd></div>
            <div className="k">Forward / Drop (Intercept)</div>
            <div className="v"><kbd>F</kbd> / <kbd>D</kbd></div>
            <div className="k">Resize panels</div>
            <div className="v">drag the splitters · double-click to reset</div>
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}
