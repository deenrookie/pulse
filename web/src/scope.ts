// Scope（目标范围）：host 规则列表，每条规则包含其子域（Burp 语义）。
// 真实来源是后端 settings.json；localStorage 只做启动缓存避免闪烁。
// 跨视图共享（流量过滤 / 站点地图 / 右键菜单），通过事件广播变更。
import { useEffect, useState } from 'react'
import { getSettings, putSettings } from './api'

const CACHE_KEY = 'pulse.scope'
const ONLY_KEY = 'pulse.scopeOnly'

let rules: string[] = loadCache()
let scopeOnly = loadOnly()
const listeners = new Set<() => void>()

function loadCache(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function loadOnly(): boolean {
  try {
    return localStorage.getItem(ONLY_KEY) === '1'
  } catch {
    return false
  }
}

function emit() {
  listeners.forEach((fn) => fn())
}

/** server sync (once per page load; writes above push back via PUT) */
getSettings()
  .then((s) => {
    rules = Array.isArray(s.scope) ? s.scope : []
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(rules))
    } catch {
      /* private mode */
    }
    emit()
  })
  .catch(() => {})

// cross-tab sync: our own writes update localStorage, which fires `storage`
// in every other tab of this console. (Direct API edits sync on reload.)
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== CACHE_KEY) return
    rules = loadCache()
    emit()
  })
}

/** normalize a flow host ("www.x.com:443" → "www.x.com") before matching */
export function bareHost(host: string): string {
  return host.replace(/:\d+$/, '').toLowerCase()
}

export function hostInScope(host: string): boolean {
  const h = bareHost(host)
  return rules.some((r) => h === r || h.endsWith('.' + r))
}

export function scopeRules(): string[] {
  return rules
}

export function scopeOnlyOn(): boolean {
  return scopeOnly
}

async function push(next: string[], label: string) {
  const prev = rules
  rules = next
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(next))
  } catch {
    /* private mode */
  }
  emit()
  try {
    await putSettings({ scope: next })
    return `${label} · scope now ${next.length} host${next.length === 1 ? '' : 's'}`
  } catch (e) {
    rules = prev // server refused — roll back
    emit()
    throw e
  }
}

export async function addHostToScope(host: string): Promise<string> {
  const h = bareHost(host)
  if (rules.includes(h)) return `${h} is already in scope`
  return push([...rules, h], `Added ${h} to scope`)
}

export async function removeHostFromScope(host: string): Promise<string> {
  const h = bareHost(host)
  if (!rules.includes(h)) return `${h} is not in scope`
  return push(
    rules.filter((r) => r !== h && !h.endsWith('.' + r)),
    `Removed ${h} from scope`,
  )
}

export function setScopeOnly(on: boolean) {
  scopeOnly = on
  try {
    localStorage.setItem(ONLY_KEY, on ? '1' : '0')
  } catch {
    /* private mode */
  }
  emit()
}

/** subscribe components re-render on every scope/scopeOnly change */
export function useScope(): { rules: string[]; scopeOnly: boolean } {
  const [, force] = useState(0)
  useEffect(() => {
    const fn = () => force((n) => n + 1)
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }, [])
  return { rules, scopeOnly }
}
