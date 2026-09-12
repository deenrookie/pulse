// Last-selected search result per keyword, so reopening a window from a
// footer history tab jumps straight back to the record the user was looking
// at. Keys are normalized needles; values are "source:id" hit keys.
const KEY = 'pulse.gsearch.sel'
const MAX_ENTRIES = 32

type SelMap = Record<string, string>

function loadMap(): SelMap {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (raw && typeof raw === 'object') return raw as SelMap
  } catch {
    /* corrupted */
  }
  return {}
}

function saveMap(m: SelMap) {
  try {
    const keys = Object.keys(m)
    if (keys.length > MAX_ENTRIES) {
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete m[k]
    }
    localStorage.setItem(KEY, JSON.stringify(m))
  } catch {
    /* storage unavailable */
  }
}

export function getSelected(q: string): string | null {
  return loadMap()[q.trim()] ?? null
}

export function setSelected(q: string, hitKey: string) {
  const needle = q.trim()
  if (!needle) return
  const m = loadMap()
  m[needle] = hitKey
  saveMap(m)
}
