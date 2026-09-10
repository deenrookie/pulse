// Word-aware line diff (unified view) for comparing two raw messages.
// LCS on lines with an O(n·m) table capped at 4M cells; beyond that it
// degrades to whole-block replace. Changed 1:1 lines get word-level LCS
// inside, so a one-word header change doesn't flag the whole line.
import { useMemo } from 'react'

export type DiffRow = { kind: 'same' | 'add' | 'del'; text: string; wordParts?: { s: string; hit: boolean }[] }

const MAX_CELLS = 4_000_000

function lcsOps(a: string[], b: string[]): DiffRow[] {
  const n = a.length
  const m = b.length
  if (n * m > MAX_CELLS) {
    return [
      ...a.map((text): DiffRow => ({ kind: 'del', text })),
      ...b.map((text): DiffRow => ({ kind: 'add', text })),
    ]
  }
  // dp[i][j] = LCS length of a[i:], b[j:]
  const width = m + 1
  const dp = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  const out: DiffRow[] = []
  const dels: DiffRow[] = []
  const adds: DiffRow[] = []
  const flush = () => {
    // pair up consecutive dels/adds 1:1 for word-level refinement
    while (dels.length && adds.length) {
      const d = dels.shift()!
      const u = adds.shift()!
      out.push({ kind: 'del', text: d.text, wordParts: wordDiff(d.text, u.text) })
      out.push({ kind: 'add', text: u.text, wordParts: wordDiff(u.text, d.text) })
    }
    out.push(...dels.splice(0), ...adds.splice(0))
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush()
      out.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      dels.push({ kind: 'del', text: a[i] })
      i++
    } else {
      adds.push({ kind: 'add', text: b[j] })
      j++
    }
  }
  flush()
  for (; i < n; i++) out.push({ kind: 'del', text: a[i] })
  for (; j < m; j++) out.push({ kind: 'add', text: b[j] })
  return out
}

/** split a line into words, LCS-hit against the counterpart; hits render highlighted */
function wordDiff(text: string, other: string): { s: string; hit: boolean }[] | undefined {
  if (text === other) return undefined
  const w = text.split(/(\s+)/).filter((s) => s !== '')
  const o = other.split(/(\s+)/).filter((s) => s !== '')
  if (w.length * o.length > 40_000) return undefined
  const n = w.length
  const m = o.length
  const width = m + 1
  const dp = new Uint8Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = w[i] === o[j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  const parts: { s: string; hit: boolean }[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (w[i] === o[j]) {
      parts.push({ s: w[i], hit: false })
      i++
      j++
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      parts.push({ s: w[i], hit: true })
      i++
    } else {
      j++
    }
  }
  for (; i < n; i++) parts.push({ s: w[i], hit: true })
  return parts.some((p) => p.hit) ? parts : undefined
}

export function DiffView({ a, b, labelA = 'previous', labelB = 'current' }: { a: string; b: string; labelA?: string; labelB?: string }) {
  const rows = useMemo(() => lcsOps(a.split('\n'), b.split('\n')), [a, b])
  const adds = rows.filter((r) => r.kind === 'add').length
  const dels = rows.filter((r) => r.kind === 'del').length
  return (
    <div className="diff-view">
      <div className="diff-head">
        <span className="meta">
          <b className="da">+{adds}</b> <b className="dd">−{dels}</b> — {labelA} → {labelB}
        </span>
      </div>
      <pre className="diff-body">
        {rows.map((r, i) => (
          <div key={i} className={`diff-line ${r.kind}`}>
            <span className="sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>
            {r.wordParts ? (
              r.wordParts.map((p, k) => (p.hit ? <span key={k} className="word-hit">{p.s}</span> : <span key={k}>{p.s}</span>))
            ) : (
              r.text || '\u00a0'
            )}
          </div>
        ))}
      </pre>
    </div>
  )
}
