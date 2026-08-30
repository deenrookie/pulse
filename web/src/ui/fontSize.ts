// Global UI font size: the app's base is 13px (body); scaling applies an
// equivalent zoom on <html> so every surface — raw views, tables, menus,
// toasts, the decoder — grows and shrinks together, preserving ratios.
const KEY = 'pulse.fontsize'

export const FONT_DEFAULT = 13
export const FONT_MIN = 11
export const FONT_MAX = 18

export function loadFontSize(): number {
  try {
    const v = Number(localStorage.getItem(KEY))
    return Number.isFinite(v) && v >= FONT_MIN && v <= FONT_MAX ? v : FONT_DEFAULT
  } catch {
    return FONT_DEFAULT
  }
}

/** clamp + persist + apply; returns the effective value */
export function applyFontSize(px: number): number {
  const v = Math.min(FONT_MAX, Math.max(FONT_MIN, px))
  try {
    localStorage.setItem(KEY, String(v))
  } catch {
    /* ignore */
  }
  document.documentElement.style.zoom = String(v / FONT_DEFAULT)
  return v
}
