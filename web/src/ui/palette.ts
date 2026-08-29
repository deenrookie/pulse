// Shared marker palette for highlights (Live Traffic) and tab marks
// (Repeater). Fixed default set — pops on both warm and midnight themes.
export const MARK_COLORS = [
  { id: 'red', label: 'Red', value: '#f87171' },
  { id: 'orange', label: 'Orange', value: '#fb923c' },
  { id: 'yellow', label: 'Yellow', value: '#fbbf24' },
  { id: 'green', label: 'Green', value: '#34d399' },
  { id: 'cyan', label: 'Cyan', value: '#22d3ee' },
  { id: 'blue', label: 'Blue', value: '#60a5fa' },
  { id: 'violet', label: 'Violet', value: '#a78bfa' },
  { id: 'pink', label: 'Pink', value: '#f472b6' },
] as const

export type MarkColorId = (typeof MARK_COLORS)[number]['id']

export function colorValue(id: string): string {
  return MARK_COLORS.find((c) => c.id === id)?.value ?? '#f87171'
}

/** hex -> "r, g, b" for use in rgb(var-less) alpha composition */
export function colorTriplet(hex: string): string {
  const n = hex.replace('#', '')
  return `${parseInt(n.slice(0, 2), 16)}, ${parseInt(n.slice(2, 4), 16)}, ${parseInt(n.slice(4, 6), 16)}`
}
