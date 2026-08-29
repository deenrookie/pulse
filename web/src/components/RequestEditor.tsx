// Editable request (method / URL / headers / body) shared by Intercept and
// Repeater. Serializes to the API's EditableRequest shape on demand.
import { useMemo } from 'react'
import { bodyToText, encodeBody } from '../api'
import type { EditableRequest, HttpRequest } from '../types'

export interface EditorState {
  method: string
  url: string
  headersText: string
  bodyText: string
}

export function editorStateFrom(req: HttpRequest): EditorState {
  return {
    method: req.method,
    url: req.url,
    headersText: req.headers.map((h) => `${h.name}: ${h.value}`).join('\n'),
    bodyText: bodyToText(req.body),
  }
}

export function editorToRequest(st: EditorState): EditableRequest | { error: string } {
  const headers: { name: string; value: string }[] = []
  for (const line of st.headersText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(':')
    if (idx <= 0) {
      return { error: `Invalid header line: ${trimmed}` }
    }
    headers.push({ name: trimmed.slice(0, idx).trim(), value: trimmed.slice(idx + 1).trim() })
  }
  if (!/^https?:\/\//i.test(st.url)) {
    return { error: 'URL must start with http:// or https://' }
  }
  return {
    method: st.method.toUpperCase(),
    url: st.url.trim(),
    httpVersion: 'HTTP/1.1',
    headers,
    body: encodeBody(new TextEncoder().encode(st.bodyText)),
  }
}

interface Props {
  state: EditorState
  onChange: (next: EditorState) => void
  note?: string
}

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']

export default function RequestEditor({ state, onChange, note }: Props) {
  const bodyIsBinary = useMemo(() => /[\u0000-\u0008\u000E-\u001F]/.test(state.bodyText), [state.bodyText])
  return (
    <div className="editor-grid">
      <div className="editor-row">
        <select
          className="select"
          value={state.method}
          onChange={(e) => onChange({ ...state, method: e.target.value })}
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          className="input"
          value={state.url}
          placeholder="https://example.com/path?query"
          spellCheck={false}
          onChange={(e) => onChange({ ...state, url: e.target.value })}
        />
      </div>
      <div className="editor-label">Headers (one per line, Name: Value)</div>
      <textarea
        className="editor headers"
        value={state.headersText}
        spellCheck={false}
        onChange={(e) => onChange({ ...state, headersText: e.target.value })}
      />
      <div className="editor-label">Body {bodyIsBinary ? '(binary content shown as text)' : ''}</div>
      <textarea
        className="editor"
        value={state.bodyText}
        spellCheck={false}
        onChange={(e) => onChange({ ...state, bodyText: e.target.value })}
        placeholder="(request body)"
      />
      {note && <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>{note}</div>}
    </div>
  )
}
