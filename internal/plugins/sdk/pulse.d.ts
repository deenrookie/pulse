/** Pulse plugin SDK — ambient declarations for plugin scripts.
 *  Place next to your source and reference it:
 *    /// <reference path="pulse.d.ts" />
 */
declare const plugin: {
  name?: string
  version?: string
  id?: string
  apiVersion?: number
  description?: string
  config?: Record<string, PluginConfigField>
  actions?: { id: string; label: string; hint?: string }[]
  uiPanel?: { id: string; title: string; html: string }
}
declare function onRequest(ctx: PluginRequestContext): void | Promise<void>
declare function onResponse(ctx: PluginResponseContext): void | Promise<void>
declare function onComplete(ctx: PluginFlowContext): void | Promise<void>
declare const actions: Record<string, (ctx: PluginFlowContext) => string | void>

interface PluginConfigField {
  type: 'string' | 'number' | 'boolean' | 'select' | 'secret'
  label?: string
  default?: unknown
  required?: boolean
  options?: string[]
  hint?: string
}

interface Header { name: string; value: string }

interface PluginRequestContext {
  request: { method: string; url: string; httpVersion: string; headers: Header[]; body: string }
  flowId: string
  config: Record<string, unknown>
  state: KV
  respond(opts: { status?: number; headers?: Header[]; body?: string }): void
  drop(opts?: { reason?: string } | string): void
}

interface PluginResponseContext extends PluginRequestContext {
  response: { status: number; reason: string; httpVersion: string; headers: Header[]; body: string }
}

interface PluginFlowContext {
  request: PluginRequestContext['request']
  response?: PluginResponseContext['response']
  flowId: string
  config: Record<string, unknown>
  state: KV
}

interface KV {
  get(key: string): unknown
  set(key: string, value: unknown): void
  delete(key: string): void
  keys(): string[]
}

declare const pulse: {
  version: string
  log(...args: unknown[]): void
  headers: {
    get(m: { headers: Header[] }, name: string): string | null
    getAll(m: { headers: Header[] }, name: string): string[]
    set(m: { headers: Header[] }, name: string, value: string): void
    append(m: { headers: Header[] }, name: string, value: string): void
    remove(m: { headers: Header[] }, name: string): number
  }
  url: { parse(url: string): { scheme: string; host: string; port: string; path: string; query: string } }
  query: {
    getAll(req: { url: string }, name: string): string[]
    set(req: { url: string }, name: string, value: string): void
    append(req: { url: string }, name: string, value: string): void
    remove(req: { url: string }, name: string): void
  }
  cookies: {
    get(m: { headers: Header[] }, name: string): string | null
    set(m: { headers: Header[] }, name: string, value: string): void
    remove(m: { headers: Header[] }, name: string): void
  }
  body: {
    json(m: { body: string }): unknown
    setJSON(m: { body: string }, value: unknown): void
    setText(m: { body: string }, text: string): void
  }
  encoding: { base64(text: string): string; hex(text: string): string }
  crypto: { sha256(text: string): string; hmacSha256(key: string, text: string): string }
  store: {
    memory: KV & { increment(key: string, delta?: number, ttlMs?: number): number }
    local: KV
  }
  files: {
    read(path: string): string
    write(path: string, content: string): void
    list(): string[]
  }
  http: {
    send(opts: {
      method?: string
      url: string
      headers?: Header[]
      body?: string
      timeoutMs?: number
      redirects?: 'follow' | 'manual'
    }): Promise<{ status: number; reason: string; headers: Header[]; body: string; source: string; flowId: string }>
  }
}
