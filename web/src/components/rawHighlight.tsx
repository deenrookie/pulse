// Shared rich-text highlighting for raw views: JSON body keys and
// Cookie/Set-Cookie key=value pairs. Pure rendering helpers — no state.
import type { ReactNode } from 'react'

/** render a JSON body line with its property keys tinted: "key": value */
export function renderJSONKeys(line: string, keyClass = 'json-key'): ReactNode {
  const out: ReactNode[] = []
  let rest = line
  let i = 0
  while (rest) {
    const m = rest.match(/"((?:[^"\\]|\\.){1,256})"(\s*:)/)
    if (!m || m.index === undefined) {
      out.push(rest)
      break
    }
    const at = m.index
    if (at > 0) out.push(rest.slice(0, at))
    out.push(
      <span key={`jk${i++}`} className={keyClass}>
        {`"${m[1]}"`}
      </span>,
    )
    out.push(m[2])
    rest = rest.slice(at + m[0].length)
  }
  return out
}

/** render a Cookie/Set-Cookie value with each pair's key tinted: k1=v1; k2=v2 */
export function renderCookieValue(value: string, keyClass = 'cookie-key'): ReactNode {
  const parts = value.split(/;\s*/)
  const out: ReactNode[] = []
  parts.forEach((p, idx) => {
    if (idx > 0) out.push(';')
    const eq = p.indexOf('=')
    if (eq > 0) {
      out.push(
        <span key={`ck${idx}`} className={keyClass}>
          {p.slice(0, eq)}
        </span>,
      )
      out.push(p.slice(eq))
    } else {
      out.push(p)
    }
  })
  return out
}
