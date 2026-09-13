// One-click "copy as code" generators for captured requests: Go (net/http),
// Python (requests) and JavaScript (fetch). String literals are embedded as
// JSON strings — a valid literal in all three languages, so bodies and header
// values survive verbatim.
import type { Header } from '../types'

const HOP_HEADERS = ['host', 'content-length', 'connection', 'proxy-connection']

const usable = (headers: Header[]) => headers.filter((h) => !HOP_HEADERS.includes(h.name.toLowerCase()))

export interface CodeRequest {
  method: string
  url: string
  headers: Header[]
  bodyText: string
}

export function toGoRequest(r: CodeRequest): string {
  const hs = usable(r.headers)
  const bodyArg = r.bodyText
    ? `strings.NewReader(${JSON.stringify(r.bodyText)})`
    : 'nil'
  const lines = [
    'package main',
    '',
    'import (',
    '\t"fmt"',
    '\t"io"',
    '\t"net/http"',
    r.bodyText ? '\t"strings"' : null,
    ')',
    '',
    'func main() {',
    `\treq, err := http.NewRequest(${JSON.stringify(r.method)}, ${JSON.stringify(r.url)}, ${bodyArg})`,
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
  ]
  for (const h of hs) {
    lines.push(`\treq.Header.Add(${JSON.stringify(h.name)}, ${JSON.stringify(h.value)})`)
  }
  lines.push(
    '\tresp, err := http.DefaultClient.Do(req)',
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    '\tdefer resp.Body.Close()',
    '\tb, _ := io.ReadAll(resp.Body)',
    '\tfmt.Println(resp.Status)',
    '\tfmt.Println(string(b))',
    '}',
  )
  return lines.filter((l): l is string => l !== null).join('\n')
}

export function toPythonRequest(r: CodeRequest): string {
  const hs = usable(r.headers)
  const method = r.method.toLowerCase()
  const args: string[] = [JSON.stringify(r.url)]
  if (hs.length > 0) {
    const pairs = hs.map((h) => `(${JSON.stringify(h.name)}, ${JSON.stringify(h.value)})`).join(', ')
    args.push(`headers=[${pairs}]`)
  }
  if (r.bodyText) args.push(`data=${JSON.stringify(r.bodyText)}`)
  return [
    'import requests',
    '',
    `resp = requests.${method}(`,
    ...args.map((a) => `    ${a},`),
    ')',
    'print(resp.status_code)',
    'print(resp.text)',
    '',
  ].join('\n')
}

export function toJsRequest(r: CodeRequest): string {
  const hs = usable(r.headers)
  const args: string[] = [`method: ${JSON.stringify(r.method)}`]
  if (hs.length > 0) {
    const pairs = hs.map((h) => `[${JSON.stringify(h.name)}, ${JSON.stringify(h.value)}]`).join(', ')
    args.push(`headers: [${pairs}]`)
  }
  if (r.bodyText) args.push(`body: ${JSON.stringify(r.bodyText)}`)
  return [
    `const resp = await fetch(${JSON.stringify(r.url)}, {`,
    ...args.map((a) => `  ${a},`),
    '});',
    'console.log(resp.status);',
    'const text = await resp.text();',
    'console.log(text);',
    '',
  ].join('\n')
}
