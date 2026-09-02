import Icon from '../ui/Icon'
import { getSettings, putSettings } from '../api'
import type { PulseState } from '../state'
import { useEffect, useState } from 'react'
import { applyFontSize, loadFontSize, FONT_DEFAULT, FONT_MIN, FONT_MAX } from '../ui/fontSize'

export default function SettingsView({ pulse }: { pulse: PulseState }) {
  const st = pulse.status
  const [timeoutSec, setTimeoutSec] = useState<number | null>(null)
  const [memGuard, setMemGuard] = useState<number | null>(null)
  const [largeBody, setLargeBody] = useState<number | null>(null)
  const [savedAt, setSavedAt] = useState(0)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [fontSize, setFontSize] = useState(loadFontSize)

  useEffect(() => {
    getSettings()
      .then((s) => {
        setTimeoutSec(s.responseTimeoutSec)
        setMemGuard(s.memoryGuardMB)
        setLargeBody(s.largeBodyMB)
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
          <a className="btn primary" href="/api/cert" download="pulse-ca.pem">
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
            <Icon name="bolt" size={15} />
            Runtime
          </h3>
          <div className="sub">Current process configuration and counters.</div>
          {st ? (
            <div className="kv-grid">
              <div className="k">Version</div>
              <div className="v">{st.version}</div>
              <div className="k">Proxy listener</div>
              <div className="v">{st.proxyAddr}</div>
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
            <div className="v"><kbd>Ctrl 1</kbd> … <kbd>Ctrl 5</kbd></div>
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
