// Typed REST + SSE client for the Pulse backend.
import type {
  EditableRequest,
  Flow,
  FlowMeta,
  HttpRequest,
  InterceptSummary,
  RepeaterTab,
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
