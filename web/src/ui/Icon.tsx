// Inline SVG icon set — 16px grid, 1.5px stroke, round caps/joins.
// No external dependency so the console stays fully offline (local-first tool).
import type { CSSProperties } from 'react'

// Each entry is the inner SVG markup (paths etc.) drawn inside a 24x24 viewBox.
const PATHS: Record<string, string> = {
  // brand / navigation
  pulse: '<path d="M2 12h4l2.5-7 4 14 2.5-7h7" />',
  waves: '<path d="M2 6c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2 2.5-2 5-2" /><path d="M2 12c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2 2.5-2 5-2" /><path d="M2 18c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2 2.5-2 5-2" />',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12" /><path d="M11 11.5v-2a1.5 1.5 0 0 1 3 0V12" /><path d="M14 11.5v-1a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-.6a6 6 0 0 1-4.6-2.15L3 15.2a1.6 1.6 0 0 1 2.4-2.1L8 16" />',
  repeat: '<path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" />',
  puzzle: '<path d="M19.4 13a2 2 0 0 0-.6 3.4l.3.3a2 2 0 1 1-2.8 2.8l-.3-.3a2 2 0 0 0-3.4.6 2 2 0 0 1-3.7 0 2 2 0 0 0-3.4-.6l-.3.3a2 2 0 1 1-2.8-2.8l.3-.3a2 2 0 0 0-.6-3.4 2 2 0 0 1 0-3.7 2 2 0 0 0 .6-3.4l-.3-.3a2 2 0 1 1 2.8-2.8l.3.3a2 2 0 0 0 3.4-.6 2 2 0 0 1 3.7 0 2 2 0 0 0 3.4.6l.3-.3a2 2 0 1 1 2.8 2.8l-.3.3a2 2 0 0 0 .6 3.4 2 2 0 0 1 0 3.7Z" /><path d="M10 8v6" /><path d="M14 8v6" />',
  gear: '<circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />',
  // actions
  play: '<path d="m6 3 14 9-14 9V3Z" />',
  trash: '<path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" />',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6" /><path d="M10 14 21 3" />',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" />',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" /><path d="M21 3v5h-5" />',
  plus: '<path d="M12 5v14" /><path d="M5 12h14" />',
  x: '<path d="M18 6 6 18" /><path d="m6 6 12 12" />',
  check: '<path d="M20 6 9 17l-5-5" />',
  send: '<path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" />',
  // indicators / objects
  search: '<circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3Z" />',
  clock: '<circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" />',
  alert: '<path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0Z" />',
  chevronDown: '<path d="m6 9 6 6 6-6" />',
  chevronRight: '<path d="m9 18 6-6-6-6" />',
  chevronsLeft: '<path d="m11 17-5-5 5-5" /><path d="m18 17-5-5 5-5" />',
  arrowDownUp: '<path d="m3 16 4 4 4-4" /><path d="M7 20V4" /><path d="m21 8-4-4-4 4" /><path d="M17 4v16" />',
  arrowUp: '<path d="M12 19V5" /><path d="m5 12 7-7 7 7" />',
  arrowDown: '<path d="M12 5v14" /><path d="m19 12-7 7-7-7" />',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M9 21V9" />',
  image: '<rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" />',
  file: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2Z" /><path d="M14 2v6h6" />',
  terminal: '<path d="m4 17 6-6-6-6" /><path d="M12 19h8" />',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" />',
  circle: '<circle cx="12" cy="12" r="9" />',
  globe: '<circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z" />',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />',
  minus: '<path d="M5 12h14" />',
  shield: '<path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z" />',
}

export type IconName = keyof typeof PATHS | (string & {})

export default function Icon({
  name,
  size = 16,
  className,
  style,
}: {
  name: IconName
  size?: number
  className?: string
  style?: CSSProperties
}) {
  const html = PATHS[name] ?? PATHS.circle
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
