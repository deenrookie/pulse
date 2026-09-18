import { useEffect, useState } from 'react'
import { apiBase, authHeaders, copyToClipboard, getPluginSkill } from '../api'

export default function PluginSkills({ onEditor }: { onEditor: () => void }) {
  const [content, setContent] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [status, setStatus] = useState('')
  const load = async () => {
    setLoading(true); setError('')
    try { setContent((await getPluginSkill()).content) }
    catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const download = async () => {
    setDownloading(true); setError(''); setStatus('')
    try {
      const response = await fetch(apiBase() + '/api/plugins/skill/download', { headers: authHeaders() })
      if (!response.ok) throw new Error('Skill download failed: HTTP ' + response.status)
      const url = URL.createObjectURL(await response.blob())
      const a = document.createElement('a')
      a.href = url; a.download = 'pulse-plugin-dev.zip'
      document.body.appendChild(a); a.click(); a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setStatus('Skill kit downloaded. Extract pulse-plugin-dev into your AI tool’s skills directory.')
    } catch (e) { setError((e as Error).message) }
    finally { setDownloading(false) }
  }
  return <section className="skills-panel" aria-label="Plugin development skills">
    <div className="skill-intro"><span className="faint">BUILT-IN SKILL · LOCAL WORKFLOW</span><h2>Build plugins with your AI assistant</h2>
      <p className="sub">Give your assistant the Pulse runtime contract, a scoped plugin template and repeatable sandbox checks. Keep your traffic local while you build the small tools your workflow needs.</p>
      <div className="share-actions">
        <button className="btn primary" disabled={!content} onClick={async () => { if (await copyToClipboard(content, { silent: true })) setStatus('SKILL.md copied. Paste it into your AI assistant.'); else setError('Clipboard unavailable. Select the text below or download the kit.') }}>Copy SKILL.md</button>
        <button className="btn" disabled={downloading || !content} onClick={() => void download()}>{downloading ? 'Downloading…' : 'Download skill kit'}</button>
        <button className="btn" onClick={onEditor}>Open plugin editor</button>
      </div>
      <ol className="steps"><li>Download and extract <code>pulse-plugin-dev</code> into your AI tool’s skills directory, or copy the instructions into a chat.</li><li>Describe a host, an input and the expected change. The kit includes SDK types, a guarded template, fixtures and a Python 3 sandbox checker.</li><li>Check → Test run → inspect results → save. Verify a synthetic local request before using the plugin with real traffic.</li></ol>
      <p className="sub">Copy includes the instructions; download includes the helper files. Reload your AI tool after installing the kit. No AI service is contacted by Pulse.</p>
    </div>
    {error && <div role="alert" className="err-inline">{error} <button className="btn sm" onClick={() => void load()}>Retry</button></div>}
    {status && <p role="status">{status}</p>}
    {loading ? <p role="status">Loading skill…</p> : <pre className="skill-source" tabIndex={0} aria-label="SKILL.md source">{content}</pre>}
  </section>
}
