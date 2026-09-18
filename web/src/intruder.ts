import type { Flow } from './types'
import { bodyToTextDecoded } from './api'

export type AttackMode = 'sniper' | 'battering-ram' | 'pitchfork'
export const countPositions = (raw: string) => Math.floor((raw.split('§').length - 1) / 2)

export function payloadLines(text: string): string[] {
  const lines = text
    .split(String.fromCharCode(10))
    .map((line) => (line.endsWith(String.fromCharCode(13)) ? line.slice(0, -1) : line))
  return lines.filter((line) => line !== '') // preserve meaningful whitespace
}

export function attackPlan(raw: string, mode: AttackMode, payloads: string, sets: string[]) {
  const segments = raw.split('§')
  if (segments.length < 3 || segments.length % 2 === 0)
    throw new Error('Mark at least one balanced §position§. Every opening marker needs a closing marker.')
  const count = countPositions(raw)
  const lists =
    mode === 'pitchfork'
      ? Array.from({ length: count }, (_, i) => payloadLines(sets[i] ?? ''))
      : [payloadLines(payloads)]
  if (lists.some((list) => list.length === 0))
    throw new Error(
      mode === 'pitchfork'
        ? 'Add a non-empty payload set for every position.'
        : 'Add at least one payload, one per line.',
    )
  const rounds =
    mode === 'pitchfork'
      ? Math.min(...lists.map((list) => list.length))
      : lists[0].length * (mode === 'sniper' ? count : 1)
  return {
    count: rounds,
    warning:
      mode === 'pitchfork' && new Set(lists.map((list) => list.length)).size > 1
        ? 'Pitchfork stops when the shortest payload set is exhausted.'
        : '',
    round(index: number) {
      const active = mode === 'sniper' ? Math.floor(index / lists[0].length) : -1
      const values = Array.from({ length: count }, (_, position) =>
        mode === 'pitchfork'
          ? lists[position][index]
          : mode === 'sniper' && position !== active
            ? segments[position * 2 + 1]
            : lists[0][index % lists[0].length],
      )
      return {
        raw: segments.map((segment, i) => (i % 2 ? values[(i - 1) / 2] : segment)).join(''),
        payload: mode === 'sniper' ? lists[0][index % lists[0].length] : values.join(' · '),
        position: active < 0 ? 'all' : String(active + 1),
      }
    },
  }
}

export function templateBaseURL(raw: string) {
  const target = raw.split(String.fromCharCode(10))[0]?.split(' ')[1]
  if (target?.startsWith('http://') || target?.startsWith('https://')) {
    try {
      return new URL(target).origin
    } catch {
      /* Host fallback */
    }
  }
  for (const line of raw.split(String.fromCharCode(10))) {
    if (line.toLowerCase().startsWith('host:')) return 'http://' + line.slice(5).trim()
  }
  return 'http://example.com'
}

export async function grepHitsFor(flow: Flow, keywords: string[]) {
  if (!flow.response || !keywords.length) return []
  const response = flow.response
  const encoding =
    (response.headers ?? []).find((h) => h.name.toLowerCase() === 'content-encoding')?.value ?? ''
  const body = await bodyToTextDecoded(response.body, encoding)
  const hay = [
    String(response.statusCode),
    response.reason,
    ...(response.headers ?? []).map((h) => h.name + ': ' + h.value),
    body.text,
  ]
    .join(String.fromCharCode(10))
    .toLowerCase()
  return keywords.filter((k) => hay.includes(k.toLowerCase()))
}

export function bodySize(flow: Flow) {
  try {
    return atob(flow.response?.body ?? '').length
  } catch {
    return 0
  }
}
