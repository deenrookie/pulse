// Shared deep-search history: the footer tabs and the search window both
// read/write it; changes broadcast through a window event so every listener
// re-renders. Persisted in localStorage, most recent first.
const KEY = 'pulse.search.history'
export const SEARCH_HISTORY_EVT = 'pulse:search-history'
const LIMIT = 8

export function getSearchHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, LIMIT)
  } catch {
    /* corrupted entry — start fresh */
  }
  return []
}

export function pushSearchHistory(q: string) {
  const needle = q.trim()
  if (!needle) return
  const next = [needle, ...getSearchHistory().filter((x) => x !== needle)].slice(0, LIMIT)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new CustomEvent(SEARCH_HISTORY_EVT))
}

export function removeSearchHistory(q: string) {
  const next = getSearchHistory().filter((x) => x !== q)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new CustomEvent(SEARCH_HISTORY_EVT))
}

/** a search window re-searched a new keyword: its footer tab follows along
 * (renamed in place) instead of piling up one tab per search */
export function renameSearchHistory(prev: string, next: string) {
  const needle = next.trim()
  if (!needle || prev === needle) return
  const cur = getSearchHistory()
  const idx = cur.indexOf(prev)
  if (idx < 0) {
    pushSearchHistory(needle)
    return
  }
  const rest = cur.filter((x, i) => i !== idx && x !== needle)
  const out = [...rest.slice(0, idx), needle, ...rest.slice(idx)].slice(0, LIMIT)
  try {
    localStorage.setItem(KEY, JSON.stringify(out))
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new CustomEvent(SEARCH_HISTORY_EVT))
}
