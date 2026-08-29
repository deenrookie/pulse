// Types mirroring the Go API JSON models (docs/API.md).

export interface Header {
  name: string
  value: string
}

export interface HttpRequest {
  id: string
  method: string
  url: string
  httpVersion: string
  headers: Header[]
  body: string | null // base64 (null tolerated for legacy records)
  truncated: boolean
  timestamp: string
  source: string
}

export interface HttpResponse {
  statusCode: number
  reason: string
  httpVersion: string
  headers: Header[]
  body: string | null // base64
  truncated: boolean
  timestamp: string
  durationMs: number
}

export type FlowState = 'pending' | 'complete' | 'intercepted' | 'dropped' | 'error'

export interface Flow {
  id: string
  request: HttpRequest
  response?: HttpResponse
  state: FlowState
  error?: string
}

export interface FlowMeta {
  id: string
  method: string
  url: string
  host: string
  path: string
  statusCode: number
  contentType: string
  reqSize: number
  respSize: number
  durationMs: number
  state: FlowState
  timestamp: string
  source: string
}

export interface PendingItem {
  id: string
  method: string
  url: string
}

export interface InterceptSummary {
  enabled: boolean
  capacity: number
  pending: PendingItem[]
}

export interface RepeaterTab {
  id: string
  title: string
  request: HttpRequest
  lastResponse?: HttpResponse
  updatedAt: string
}

export interface Status {
  version: string
  proxyAddr: string
  uiAddr: string
  dataDir: string
  caFingerprint: string
  flows: { total: number; pending: number }
  intercept: { enabled: boolean; pending: number }
}

export interface EditableRequest {
  method: string
  url: string
  httpVersion: string
  headers: Header[]
  body: string // base64
}

export type RewriteZone =
  | 'request_line'
  | 'request_header'
  | 'request_body'
  | 'response_header'
  | 'response_body'

export interface RewriteRule {
  id: string
  enabled: boolean
  zone: RewriteZone
  match: string
  replace: string
  regex: boolean
  comment: string
  hits: number
}

export interface PluginInfo {
  name: string
  version: string
  file: string
  enabled: boolean
  hooks: string[]
  hits: number
  error?: string
  log?: string[]
}
