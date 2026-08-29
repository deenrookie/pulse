// Central state hook: live flow list via SSE, intercept queue, repeater tabs.
import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from './api'
import type { EditableRequest, Flow, FlowMeta, InterceptSummary, RepeaterTab, Status } from './types'

const MAX_ROWS = 5000

export interface Toast {
  text: string
  kind: 'ok' | 'err'
}

export function usePulse() {
  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [flows, setFlows] = useState<FlowMeta[]>([])
  const [total, setTotal] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedFlow, setSelectedFlow] = useState<Flow | null>(null)
  const [intercept, setIntercept] = useState<InterceptSummary>({ enabled: false, capacity: 50, pending: [] })
  const [repeaterTabs, setRepeaterTabs] = useState<RepeaterTab[]>([])
  const [toast, setToast] = useState<Toast | null>(null)
  const [toastLeaving, setToastLeaving] = useState(false)
  const toastTimer = useRef<number | undefined>(undefined)
  const selectedIdRef = useRef<string | null>(null)
  selectedIdRef.current = selectedId

  const notify = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    setToastLeaving(false)
    setToast({ text, kind })
    window.clearTimeout(toastTimer.current)
    // play the CSS exit transition before unmounting
    toastTimer.current = window.setTimeout(() => {
      setToastLeaving(true)
      toastTimer.current = window.setTimeout(() => setToast(null), 200)
    }, 2400)
  }, [])

  const metaOfFlow = (fl: Flow): FlowMeta => ({
    id: fl.id,
    method: fl.request.method,
    url: fl.request.url,
    host: hostOf(fl.request.url),
    path: pathOf(fl.request.url),
    statusCode: fl.response?.statusCode ?? 0,
    contentType: headerOf(fl.response?.headers ?? [], 'content-type'),
    reqSize: b64Size(fl.request.body),
    respSize: fl.response ? b64Size(fl.response.body) : 0,
    durationMs: fl.response?.durationMs ?? 0,
    state: fl.state,
    timestamp: fl.request.timestamp,
    source: fl.request.source,
  })

  // Initial load + one long-lived SSE subscription.
  useEffect(() => {
    let alive = true
    const refreshStatus = () => api.getPulseStatus().then((s) => alive && setStatus(s)).catch(() => {})
    const refreshIntercept = () => api.getIntercept().then((s) => alive && setIntercept(s)).catch(() => {})
    const refreshRepeater = () => api.listRepeater().then((r) => alive && setRepeaterTabs(r.tabs)).catch(() => {})
    const refreshInterceptSoon = debounce(refreshIntercept, 150)

    api
      .listFlows()
      .then(({ total, items }) => {
        if (!alive) return
        setTotal(total)
        setFlows(items.slice(-MAX_ROWS))
      })
      .catch(() => {})
    refreshStatus()
    refreshIntercept()
    refreshRepeater()

    const close = api.subscribeEvents({
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onFlow: (fl) => {
        setFlows((prev) => {
          const next = prev.length >= MAX_ROWS ? prev.slice(prev.length - MAX_ROWS + 1) : prev.slice()
          next.push(metaOfFlow(fl))
          return next
        })
        setTotal((t) => t + 1)
      },
      onFlowUpdate: (fl) => {
        setFlows((prev) => {
          const idx = prev.findIndex((m) => m.id === fl.id)
          if (idx < 0) return prev
          const next = prev.slice()
          next[idx] = metaOfFlow(fl)
          return next
        })
        if (fl.id === selectedIdRef.current) setSelectedFlow(fl)
      },
      onIntercept: () => refreshInterceptSoon(),
    })

    const statusTimer = window.setInterval(refreshStatus, 10000)
    return () => {
      alive = false
      close()
      window.clearInterval(statusTimer)
    }
  }, [])

  // Full detail fetch on selection; live updates arrive via SSE.
  useEffect(() => {
    if (!selectedId) {
      setSelectedFlow(null)
      return
    }
    let alive = true
    api
      .getFlow(selectedId)
      .then((fl) => alive && setSelectedFlow(fl))
      .catch(() => alive && setSelectedFlow(null))
    return () => {
      alive = false
    }
  }, [selectedId])

  const selectFlow = useCallback((id: string | null) => setSelectedId(id), [])

  const clearAllFlows = useCallback(async () => {
    if (!window.confirm('Clear all captured traffic?')) return
    try {
      await api.clearFlows()
      setFlows([])
      setTotal(0)
      setSelectedId(null)
      setSelectedFlow(null)
      notify('History cleared')
    } catch (e) {
      notify(`Clear failed: ${(e as Error).message}`, 'err')
    }
  }, [notify])

  const removeFlow = useCallback(
    async (id: string) => {
      try {
        await api.deleteFlow(id)
        setFlows((prev) => prev.filter((m) => m.id !== id))
        setTotal((t) => Math.max(0, t - 1))
        if (selectedId === id) setSelectedId(null)
      } catch (e) {
        notify(`Delete failed: ${(e as Error).message}`, 'err')
      }
    },
    [selectedId, notify],
  )

  const toggleIntercept = useCallback(
    async (enabled: boolean) => {
      setIntercept((prev) => ({ ...prev, enabled }))
      try {
        const s = await api.setInterceptEnabled(enabled)
        setIntercept(s)
        notify(enabled ? 'Intercept is on — requests are being held' : 'Intercept is off')
      } catch (e) {
        notify(`Toggle failed: ${(e as Error).message}`, 'err')
      }
    },
    [notify],
  )

  const refreshIntercept = useCallback(() => {
    api.getIntercept().then(setIntercept).catch(() => {})
  }, [])

  const forwardPending = useCallback(
    async (id: string, request?: EditableRequest) => {
      await api.forwardHeld(id, request)
      refreshIntercept()
    },
    [refreshIntercept],
  )

  const dropPending = useCallback(
    async (id: string) => {
      await api.dropHeld(id)
      refreshIntercept()
    },
    [refreshIntercept],
  )

  const sendToRepeater = useCallback(
    async (flowId: string) => {
      try {
        await api.createRepeaterTab({ flowId })
        const r = await api.listRepeater()
        setRepeaterTabs(r.tabs)
        notify('Sent to Repeater')
        return true
      } catch (e) {
        notify(`Send to Repeater failed: ${(e as Error).message}`, 'err')
        return false
      }
    },
    [notify],
  )

  const repeaterSend = useCallback(async (id: string, request?: EditableRequest) => {
    await api.sendRepeaterTab(id, request)
    const r = await api.listRepeater()
    setRepeaterTabs(r.tabs)
  }, [])

  const repeaterSave = useCallback(async (id: string, request: EditableRequest) => {
    await api.updateRepeaterTab(id, request)
    const r = await api.listRepeater()
    setRepeaterTabs(r.tabs)
  }, [])

  const repeaterDelete = useCallback(async (id: string) => {
    await api.deleteRepeaterTab(id)
    setRepeaterTabs((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return {
    connected,
    status,
    flows,
    total,
    selectedId,
    selectedFlow,
    selectFlow,
    clearAllFlows,
    removeFlow,
    intercept,
    toggleIntercept,
    refreshIntercept,
    forwardPending,
    dropPending,
    repeaterTabs,
    sendToRepeater,
    repeaterSend,
    repeaterSave,
    repeaterDelete,
    toast,
    toastLeaving,
    notify,
  }
}

export type PulseState = ReturnType<typeof usePulse>

// ---------- small local helpers ----------

function b64Size(b64: string | null | undefined): number {
  return b64 ? Math.floor((b64.length * 3) / 4) : 0
}

function debounce<F extends (...args: never[]) => void>(fn: F, ms: number): F {
  let t: number | undefined
  return ((...args: Parameters<F>) => {
    window.clearTimeout(t)
    t = window.setTimeout(() => fn(...args), ms)
  }) as F
}

function hostOf(url: string): string {
  const m = url.match(/^\w+:\/\/([^/?#]+)/)
  return m ? m[1] : url
}

function pathOf(url: string): string {
  const i = url.indexOf('://')
  const rest = i >= 0 ? url.slice(i + 3) : url
  const j = rest.indexOf('/')
  return j >= 0 ? rest.slice(j) : '/'
}

function headerOf(headers: { name: string; value: string }[], name: string): string {
  const h = headers.find((x) => x.name.toLowerCase() === name)
  return h?.value ?? ''
}
