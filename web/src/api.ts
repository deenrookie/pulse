// Typed REST + SSE client for the Pulse backend.
import type {
  EditableRequest,
  Flow,
  FlowMeta,
  HttpRequest,
  InterceptSummary,
  PluginInfo,
  RepeaterTab,
  RewriteRule,
  Status,
} from './types'

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await resp.text()
  const data = text ? JSON.parse(text) : {}
  if (!resp.ok) {
    throw new Error(data.error ?? `${resp.status} ${resp.statusText}`)
  }
  return data as T
}

export const getPulseStatus = () => api<Status>('/api/status')

export const listFlows = (q = '') =>
  api<{ total: number; items: FlowMeta[] }>(`/api/flows?limit=5000&q=${encodeURIComponent(q)}`)

export const getFlow = (id: string) => api<Flow>(`/api/flows/${id}`)

export const deleteFlow = (id: string) => api<{ ok: boolean }>(`/api/flows/${id}`, { method: 'DELETE' })

export const clearFlows = () => api<{ ok: boolean }>('/api/flows', { method: 'DELETE' })

export const getIntercept = () => api<InterceptSummary>('/api/intercept')

export const setInterceptEnabled = (enabled: boolean) =>
  api<InterceptSummary>('/api/intercept', { method: 'PUT', body: JSON.stringify({ enabled }) })

export const getHeldRequest = (id: string) => api<HttpRequest>(`/api/intercept/${id}`)

export const forwardHeld = (id: string, request?: EditableRequest) =>
  api<{ ok: boolean }>(`/api/intercept/${id}/forward`, {
    method: 'POST',
    body: JSON.stringify(request ? { request } : {}),
  })

export const dropHeld = (id: string) =>
  api<{ ok: boolean }>(`/api/intercept/${id}/drop`, { method: 'POST', body: '{}' })

export const listRepeater = () => api<{ tabs: RepeaterTab[] }>('/api/repeater')

export const createRepeaterTab = (payload: { flowId?: string; request?: EditableRequest }) =>
  api<RepeaterTab>('/api/repeater', { method: 'POST', body: JSON.stringify(payload) })

export const updateRepeaterTab = (id: string, request: EditableRequest) =>
  api<RepeaterTab>(`/api/repeater/${id}`, { method: 'PUT', body: JSON.stringify({ request }) })

export const deleteRepeaterTab = (id: string) =>
  api<{ ok: boolean }>(`/api/repeater/${id}`, { method: 'DELETE' })

export const sendRepeaterTab = (id: string, request?: EditableRequest) =>
  api<{ flow: Flow }>(`/api/repeater/${id}/send`, {
    method: 'POST',
    body: JSON.stringify(request ? { request } : {}),
  })

export interface SseHandlers {
  onFlow?: (flow: Flow) => void
  onFlowUpdate?: (flow: Flow) => void
  onIntercept?: (summary: { enabled: boolean; pending: number }) => void
  onOpen?: () => void
  onClose?: () => void
}

// ---------- rewrite (Match & Replace) ----------

export const listRewriteRules = () => api<{ rules: RewriteRule[] }>('/api/rewrite')

export const createRewriteRule = (payload: Omit<RewriteRule, 'id' | 'hits'>) =>
  api<RewriteRule>('/api/rewrite', { method: 'POST', body: JSON.stringify(payload) })

export const updateRewriteRule = (id: string, payload: Omit<RewriteRule, 'id' | 'hits'>) =>
  api<RewriteRule>(`/api/rewrite/${id}`, { method: 'PUT', body: JSON.stringify(payload) })

export const deleteRewriteRule = (id: string) =>
  api<{ ok: boolean }>(`/api/rewrite/${id}`, { method: 'DELETE' })

// ---------- plugins ----------

export const listPlugins = () => api<{ plugins: PluginInfo[]; dir: string }>('/api/plugins')

// ---------- settings ----------

export interface PulseSettings {
  responseTimeoutSec: number
  /** resident-body budget (MB): past it, new binary bodies > largeBodyMB are dropped */
  memoryGuardMB: number
  largeBodyMB: number
}

export const getSettings = () => api<PulseSettings>('/api/settings')

export const putSettings = (patch: Partial<PulseSettings>) =>
  api<PulseSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) })

export const reloadPlugins = () => api<{ plugins: PluginInfo[]; dir: string }>('/api/plugins/reload', { method: 'POST', body: '{}' })

export const setPluginEnabled = (file: string, enabled: boolean) =>
  api<{ ok: boolean }>(`/api/plugins/${encodeURIComponent(file)}`, { method: 'PUT', body: JSON.stringify({ enabled }) })

// ---------- context-menu helpers ----------

/** POSIX-shell-safe single-quoting for cURL export. */
export function shellQuote(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_\-:.,/@+=]+$/.test(s)) return s
  return "'" + s.replace(/'/g, `'\\''`) + "'"
}

/** Build a curl command from an ad-hoc request (Repeater/Intercept). */
export function toCurlRequest(method: string, url: string, headers: { name: string; value: string }[], bodyText: string): string {
  const parts = [`curl -X ${shellQuote(method)}`, shellQuote(url)]
  for (const h of headers) {
    if (['host', 'content-length', 'connection', 'proxy-connection'].includes(h.name.toLowerCase())) continue
    parts.push(`-H ${shellQuote(`${h.name}: ${h.value}`)}`)
  }
  if (bodyText) parts.push(`--data-raw ${shellQuote(bodyText)}`)
  return parts.join(' \\\n  ')
}

/** Build a curl command from a captured flow. */
export function toCurl(flow: Flow): string {
  const r = flow.request
  const parts = [`curl -X ${shellQuote(r.method)}`, shellQuote(r.url)]
  for (const h of r.headers) {
    if (['host', 'content-length', 'connection', 'proxy-connection'].includes(h.name.toLowerCase())) continue
    parts.push(`-H ${shellQuote(`${h.name}: ${h.value}`)}`)
  }
  const body = bodyToText(r.body)
  if (body) parts.push(`--data-raw ${shellQuote(body)}`)
  return parts.join(' \\\n  ')
}

/** copy text to the clipboard with a toast confirming success/failure.
 *  opts.label customizes the message ("Copied URL"); opts.silent disables it
 *  for callers that provide their own feedback. */
export async function copyToClipboard(text: string, opts?: { label?: string; silent?: boolean }): Promise<boolean> {
  const notify = (ok: boolean) => {
    if (opts?.silent) return
    window.dispatchEvent(
      new CustomEvent('pulse:notify', {
        detail: ok
          ? { text: opts?.label ? `Copied ${opts.label}` : 'Copied to clipboard' }
          : { text: 'Copy failed — clipboard unavailable', kind: 'err' },
      }),
    )
  }
  try {
    await navigator.clipboard.writeText(text)
    notify(true)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      notify(ok)
      return ok
    } catch {
      notify(false)
      return false
    }
  }
}

export function subscribeEvents(handlers: SseHandlers): () => void {
  const es = new EventSource('/api/events')
  const on = (name: string, fn: (ev: MessageEvent) => void) => es.addEventListener(name, fn as EventListener)
  on('flow', (ev) => handlers.onFlow?.(JSON.parse((ev as MessageEvent).data)))
  on('flow_update', (ev) => handlers.onFlowUpdate?.(JSON.parse((ev as MessageEvent).data)))
  on('intercept', (ev) => handlers.onIntercept?.(JSON.parse((ev as MessageEvent).data)))
  es.onopen = () => handlers.onOpen?.()
  es.onerror = () => handlers.onClose?.()
  return () => es.close()
}

// ---------- body helpers (base64 <-> bytes <-> text/hex) ----------

export function decodeBody(b64: string | null | undefined): Uint8Array {
  if (!b64) return new Uint8Array(0)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function encodeBody(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export function bodyToText(b64: string | null | undefined): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(decodeBody(b64))
}

/** server-side decompression fallback (covers encodings the browser
 *  runtime lacks, notably br) — POSTs the base64 body to /api/decode */
export async function serverDecodeBody(b64: string, encoding: string): Promise<Uint8Array | null> {
  try {
    const r = await fetch('/api/decode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: b64, encoding }),
    })
    if (!r.ok) return null
    const data = (await r.json()) as { body: string }
    return decodeBody(data.body)
  } catch {
    return null
  }
}

/**
 * Decode a (possibly compressed) body to text. gzip/deflate decompress
 * locally via DecompressionStream; br (and any local failure) falls back
 * to the server-side /api/decode endpoint.
 */
export async function bodyToTextDecoded(
  b64: string | null | undefined,
  contentEncoding: string,
): Promise<{ text: string; encoding: string; decodedBytes: number }> {
  const bytes = decodeBody(b64)
  const enc = (contentEncoding || '').trim().toLowerCase()
  const formats: Record<string, 'gzip' | 'deflate' | 'br'> = {
    gzip: 'gzip',
    xgzip: 'gzip',
    deflate: 'deflate',
    br: 'br',
  }
  const fmt = formats[enc.replace(/[^a-z]/g, '')]
  if (bytes.length > 0 && fmt && typeof DecompressionStream !== 'undefined') {
    try {
      const ok =
        fmt === 'br'
          ? await (async () => {
              // probe br support with an empty stream
              try {
                await new Response(new Blob([]).stream().pipeThrough(new DecompressionStream('br' as CompressionFormat))).arrayBuffer()
                return true
              } catch {
                return false
              }
            })()
          : true
      if (ok) {
        const stream = new Response(new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream(fmt as CompressionFormat)))
        const out = new Uint8Array(await stream.arrayBuffer())
        return { text: new TextDecoder('utf-8', { fatal: false }).decode(out), encoding: enc, decodedBytes: out.length }
      }
    } catch {
      // fall through to the server fallback below
    }
  }
  if (bytes.length > 0 && fmt && b64) {
    const out = await serverDecodeBody(b64, enc.replace(/[^a-z]/g, '') === 'xgzip' ? 'gzip' : fmt)
    if (out) {
      return { text: new TextDecoder('utf-8', { fatal: false }).decode(out), encoding: enc, decodedBytes: out.length }
    }
  }
  return {
    text: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
    encoding: enc && fmt ? enc : '',
    decodedBytes: bytes.length,
  }
}

/** serialize one side of a message into Burp-style raw text */
export function rawOfMessage(
  head: string, // request/status line
  headers: { name: string; value: string }[],
  bodyText: string,
): string {
  const lines = [head, ...headers.map((h) => `${h.name}: ${h.value}`), '', bodyText]
  return lines.join('\n')
}

export function bodyToHex(b64: string | null | undefined, limit = 4096): string {
  const bytes = decodeBody(b64)
  const lines: string[] = []
  const n = Math.min(bytes.length, limit)
  for (let i = 0; i < n; i += 16) {
    const slice = bytes.slice(i, Math.min(i + 16, n))
    const hex = Array.from(slice).map((b) => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = Array.from(slice).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(47, ' ')}  ${ascii}`)
  }
  if (bytes.length > n) lines.push(`… ${bytes.length - n} more bytes (truncated view)`)
  return lines.join('\n')
}

export function looksBinary(b64: string | null | undefined): boolean {
  const bytes = decodeBody(b64)
  const n = Math.min(bytes.length, 512)
  for (let i = 0; i < n; i++) {
    const b = bytes[i]
    if (b === 0 || (b < 9 && b !== 0) || (b === 13)) continue
    if (b < 32 && b !== 9 && b !== 10) return true
  }
  return false
}

export function prettyJsonIfPossible(text: string): string | null {
  const t = text.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return null
  try {
    return JSON.stringify(JSON.parse(t), null, 2)
  } catch {
    return null
  }
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour12: false })
}
