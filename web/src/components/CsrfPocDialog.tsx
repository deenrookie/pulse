// Burp-style "Generate CSRF PoC" dialog: an editable request on top (edit +
// Regenerate), the generated HTML below (also editable), technique options in
// between — and Copy / Save / Test in browser to hand the PoC over.
import { useEffect, useRef, useState } from 'react'
import Icon from '../ui/Icon'
import RawEditor, { rawToRequest } from './RawEditor'
import { generateCsrfPoc, type CsrfTechnique } from './csrf'
import { bodyToText, copyToClipboard } from '../api'

const TECHNIQUES: { id: CsrfTechnique; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'form', label: 'Form' },
  { id: 'xhr', label: 'XHR' },
]

export default function CsrfPocDialog({ raw, fallbackUrl, onClose }: { raw: string; fallbackUrl?: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [reqRaw, setReqRaw] = useState(raw)
  const [technique, setTechnique] = useState<CsrfTechnique>('auto')
  const [autoSubmit, setAutoSubmit] = useState(true)
  const [submitButton, setSubmitButton] = useState(false)
  const [html, setHtml] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [used, setUsed] = useState<'form' | 'xhr'>('form')

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    return () => {
      dialog.current?.close()
      previous?.focus({ preventScroll: true })
    }
  }, [])

  // the raw buffer carries only a Host header — the request's original URL
  // supplies the scheme (and a host when the buffer has none)
  const parse = () => rawToRequest(reqRaw, fallbackUrl ?? 'https://example.com/')

  // (re)build the PoC from the current request buffer + options. Option
  // changes regenerate immediately (Burp behavior); request edits wait for
  // the Regenerate button, so typing never clobbers the HTML pane.
  const regenerate = () => {
    const parsed = parse()
    const poc = generateCsrfPoc(
      { method: parsed.method, url: parsed.url, headers: parsed.headers ?? [], bodyText: bodyToText(parsed.body) },
      { technique, autoSubmit, submitButton },
    )
    setHtml(poc.html)
    setWarnings(poc.warnings)
    setUsed(poc.used)
  }
  useEffect(regenerate, [technique, autoSubmit, submitButton]) // eslint-disable-line react-hooks/exhaustive-deps

  const hostOf = (() => {
    try {
      return new URL(parse().url).host
    } catch {
      return ''
    }
  })()

  const downloadUrl = () => URL.createObjectURL(new Blob([html], { type: 'text/html' }))

  const save = () => {
    const a = document.createElement('a')
    a.href = downloadUrl()
    a.download = `csrf-poc${hostOf ? `-${hostOf.replace(/[^a-z0-9.-]/gi, '_')}` : ''}.html`
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(a.href), 30_000)
  }

  const testInBrowser = () => {
    const win = window.open(downloadUrl(), '_blank')
    // embedded WebViews can block blob: popups — hand the file over instead
    if (!win) {
      save()
      window.dispatchEvent(
        new CustomEvent('pulse:notify', { detail: { text: 'Popups are blocked here — saved the PoC as an HTML file, open it to test' } }),
      )
    }
  }

  const meta = parse()

  return (
    <dialog
      ref={dialog}
      className="share-dialog csrf-dialog"
      aria-labelledby="csrf-title"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="share-heading">
        <h2 id="csrf-title">
          <Icon name="shield" size={17} />
          Generate CSRF PoC
        </h2>
        <button className="btn sm" onClick={onClose} autoFocus>
          Close
        </button>
      </div>
      <p className="sub">
        HTML that makes a victim's browser issue this request — cookies ride along automatically, which is the point.
      </p>
      <div className="csrf-meta mono">
        <span className={`method-${meta.method}`}>{meta.method}</span>
        <span className="csrf-url" title={meta.url}>
          {meta.url}
        </span>
        <span className="grow" />
        <span className="csrf-tech" title="Technique used for the generated HTML">
          {used}
        </span>
      </div>

      <div className="csrf-pane">
        <div className="csrf-pane-head">
          <span className="csrf-pane-title">Request</span>
          <span className="faint">edit, then regenerate</span>
          <span className="grow" />
          <button className="btn ghost sm" onClick={regenerate} title="Rebuild the PoC from the edited request">
            <Icon name="refresh" size={12} />
            Regenerate
          </button>
        </div>
        <div className="csrf-pane-body">
          <RawEditor value={reqRaw} onChange={setReqRaw} />
        </div>
      </div>

      <div className="csrf-options">
        <label className="csrf-opt" title="Which HTML technique to use — Auto picks the most appropriate, like Burp">
          <span className="csrf-opt-label">Technique</span>
          <select
            className="input"
            style={{ width: 92 }}
            value={technique}
            onChange={(e) => setTechnique(e.target.value as CsrfTechnique)}
          >
            {TECHNIQUES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label
          className="csrf-opt"
          title="Submit the form as soon as the page loads — no victim interaction needed"
          style={{ opacity: used === 'xhr' ? 0.45 : 1 }}
        >
          <input
            type="checkbox"
            checked={autoSubmit}
            disabled={used === 'xhr'}
            onChange={(e) => setAutoSubmit(e.target.checked)}
          />
          Auto-submit script
        </label>
        <label
          className="csrf-opt"
          title="Add a manual submit button inside the form (for testing by hand)"
          style={{ opacity: used === 'xhr' ? 0.45 : 1 }}
        >
          <input
            type="checkbox"
            checked={submitButton}
            disabled={used === 'xhr'}
            onChange={(e) => setSubmitButton(e.target.checked)}
          />
          Submit button
        </label>
      </div>

      {warnings.length > 0 && (
        <div className="csrf-warn" role="status">
          <Icon name="alert" size={13} />
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="csrf-pane csrf-html-pane">
        <div className="csrf-pane-head">
          <span className="csrf-pane-title">CSRF HTML</span>
          <span className="faint">editable — Copy / Save use exactly what you see</span>
        </div>
        <textarea
          className="editor raw csrf-html"
          value={html}
          spellCheck={false}
          aria-label="Generated CSRF PoC HTML"
          onChange={(e) => setHtml(e.target.value)}
        />
      </div>

      <div className="share-actions">
        <button className="btn" onClick={testInBrowser} title="Open the PoC as a local page in a new tab and watch it fire">
          <Icon name="external" size={13} />
          Test in browser
        </button>
        <button className="btn" onClick={save} title="Download the PoC as an .html file">
          <Icon name="download" size={13} />
          Save
        </button>
        <span className="spacer" />
        <button className="btn primary" onClick={() => void copyToClipboard(html, { label: 'CSRF PoC HTML' })}>
          <Icon name="copy" size={13} />
          Copy HTML
        </button>
      </div>
    </dialog>
  )
}
