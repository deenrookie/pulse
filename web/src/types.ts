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
  /** memory guard discarded the body instead of storing it (media shards) */
  bodyDropped?: boolean
  /** wire size of the dropped body, for display */
  droppedSize?: number
  timestamp: string
  durationMs: number
}

export type FlowState = 'pending' | 'complete' | 'intercepted' | 'dropped' | 'error'

export interface WSMessage {
  dir: 'c2s' | 's2c'
  opcode: 'text' | 'binary' | 'close' | 'ping' | 'pong' | 'unknown'
  size: number
  data?: string // base64 (capped by the engine)
  truncated?: boolean
  at: string
}

export interface Flow {
  id: string
  request: HttpRequest
  response?: HttpResponse
  state: FlowState
  error?: string
  ws?: WSMessage[]
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
  wsCount: number
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

export interface RepeaterHistoryEntry {
  response?: HttpResponse
  error?: string
  at: string
}

export interface RepeaterTab {
  id: string
  title: string
  request: HttpRequest
  lastResponse?: HttpResponse
  history?: RepeaterHistoryEntry[]
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
  memory?: { sysMB: number; heapMB: number; goroutine: number }
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

/** dry-compile result from POST /api/plugins/validate */
export interface PluginInspection {
  name: string
  version: string
  hooks: string[]
  error?: string
}

/** sandbox hook run result from POST /api/plugins/test */
export interface PluginTestResult {
  logs: string[]
  error?: string
  changed: boolean
  request: TestMessage
  response: TestMessage | null
}

/** plain-string mirror of a request/response used as a test fixture */
export interface TestMessage {
  method?: string
  url?: string
  httpVersion?: string
  status?: number
  reason?: string
  headers?: { name: string; value: string }[]
  body?: string
}
