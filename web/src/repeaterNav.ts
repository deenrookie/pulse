const PENDING_TAB_KEY = 'pulse.repeater.pendingTab'
const LEGACY_JUMP_KEY = 'pulse.repeater.jumpNewest'

/** Remember the exact tab created by Send to Repeater.
 *  Repeater consumes this only after that tab is present in its list, so
 *  API/list refresh timing cannot make the navigation fall back to an older
 *  saved tab. */
export function armRepeaterTab(tabId: string): void {
  try {
    localStorage.setItem(PENDING_TAB_KEY, tabId)
    localStorage.removeItem(LEGACY_JUMP_KEY)
  } catch {
    /* private mode: normal tab selection still works */
  }
}

export function pendingRepeaterTab(): string | null {
  try {
    return localStorage.getItem(PENDING_TAB_KEY)
  } catch {
    return null
  }
}

export function lastRepeaterTab(): string | null {
  try {
    return localStorage.getItem('pulse.repeater.selected')
  } catch {
    return null
  }
}

export function consumeRepeaterTab(tabId: string): void {
  try {
    if (localStorage.getItem(PENDING_TAB_KEY) === tabId) localStorage.removeItem(PENDING_TAB_KEY)
    localStorage.removeItem(LEGACY_JUMP_KEY)
  } catch {
    /* private mode */
  }
}
