import Icon from '../ui/Icon'
import type { PulseState } from '../state'

export default function SettingsView({ pulse }: { pulse: PulseState }) {
  const st = pulse.status
  return (
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
            <div className="k">Filter traffic</div>
            <div className="v"><kbd>Ctrl F</kbd></div>
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
  )
}
