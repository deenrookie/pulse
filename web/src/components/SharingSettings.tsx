import { useEffect, useState } from 'react'
import { copyToClipboard, getSettings, listShares, putSettings, revokeShare, type TrafficShare } from '../api'
import Icon from '../ui/Icon'

export default function SharingSettings() {
  const [ip, setIP] = useState('')
  const [savedIP, setSavedIP] = useState<string | null>(null)
  const [shares, setShares] = useState<TrafficShare[]>([])
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState('')
  const load = async () => {
    try {
      const settings = await getSettings()
      setIP(settings.shareIP)
      setSavedIP(settings.shareIP)
      setShares((await listShares()).shares)
      setError('')
    } catch (e) { setError((e as Error).message) }
  }
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      listShares().then(v => setShares(v.shares)).catch(e => setError(e.message))
    }, 15000)
    return () => window.clearInterval(timer)
  }, [])
  const save = async () => {
    setBusy('save'); setError(''); setStatus('')
    try {
      const s = await putSettings({ shareIP: ip.trim() })
      setIP(s.shareIP); setSavedIP(s.shareIP)
      setStatus(s.shareIP ? 'Share IP saved. New links use this address.' : 'New sharing disabled. Existing links remain valid until revoked or expired.')
    } catch (e) { setError((e as Error).message) }
    finally { setBusy('') }
  }
  const revoke = async (id: string) => {
    setBusy(id); setError(''); setStatus('')
    try { await revokeShare(id); setShares(v => v.filter(s => s.id !== id)); setStatus('Link revoked. Previously saved copies are unaffected.') }
    catch (e) { setError((e as Error).message) }
    finally { setBusy('') }
  }
  return <div className="card sharing-settings">
    <h3><Icon name="link" size={15} />Temporary sharing</h3>
    <p className="sub">Share an exchange from Live Traffic or Repeater. Recipients get a read-only snapshot, with no access to your console. Links survive restarts and expire at the selected time.</p>
    <label className="share-field">Share IP address<input className="input mono" placeholder="192.168.1.5" value={ip} spellCheck={false} disabled={savedIP === null || !!busy} onChange={e => setIP(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !busy) void save() }} /></label>
    <p className="sub">Use this machine’s IP reachable by the recipient. Pulse adds its UI port automatically. For LAN sharing, start with <code>--ui 0.0.0.0:8787</code> (IPv6: <code>--ui [::]:8787</code>). Changing this field does not rebind the server. HTTP links are for trusted networks; 127.0.0.1 works only on this computer.</p>
    <div className="share-actions"><button className="btn primary sm" disabled={savedIP === null || ip.trim() === savedIP || !!busy} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save share IP'}</button><button className="btn sm" disabled={!!busy} onClick={() => void load()}>Refresh shares</button></div>
    {error && <p className="err-inline" role="alert">{error}</p>}
    {status && <p role="status" className="sub">{status}</p>}
    <h4>Active links <span className="faint">{shares.length}</span></h4>
    {shares.length === 0 ? <p className="sub">No active shares. Select a completed request in Live Traffic to create one.</p> : shares.map(s => <div className="share-item" key={s.id}>
      <label className="share-field">{s.flowId} · expires {new Date(s.expiresAt).toLocaleString()} · full available capture<input className="input mono" readOnly value={s.url} onFocus={e => e.target.select()} /></label>
      <div className="share-actions"><button className="btn sm" onClick={() => void copyToClipboard(s.url, { label: 'share link' })}>Copy link</button><a className="btn sm" href={s.url} target="_blank" rel="noreferrer">Open snapshot</a><button className="btn danger sm" disabled={!!busy} onClick={() => void revoke(s.id)}>{busy === s.id ? 'Revoking…' : 'Revoke'}</button></div>
    </div>)}
  </div>
}
