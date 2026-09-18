import { useEffect, useState } from 'react'
import type { Flow, HttpRequest } from '../types'
import { bodyToHex, bodyToText, bodyToTextDecoded, copyToClipboard, shellQuote } from '../api'
import { requestToRaw, responseToRaw } from './RawEditor'
import { RawView } from './MessageViewer'
import type { MenuItem } from './ContextMenu'

export function snapshotCode(req: HttpRequest, kind: 'curl' | 'python'): string {
  if (kind === 'curl') {
    // Pipe decoded bytes to curl so binary and NUL bytes survive export.
    const data = req.body ? 'printf %s ' + shellQuote(req.body) + ' | openssl base64 -d -A | ' : ''
    return (
      data +
      'curl --path-as-is -X ' +
      shellQuote(req.method) +
      ' ' +
      shellQuote(req.url) +
      ' ' +
      (req.headers ?? [])
        .map((h) => '-H ' + shellQuote(h.name + (h.value ? ': ' + h.value : ';')))
        .join(' ') +
      (req.body ? ' --data-binary @-' : '')
    )
  }
  // http.client preserves duplicate header names and arbitrary methods.
  return [
    'import base64',
    'import http.client',
    'from urllib.parse import urlsplit',
    '',
    'url = urlsplit(' + JSON.stringify(req.url) + ')',
    'connection = (http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection)(url.hostname, url.port)',
    'connection.putrequest(' +
      JSON.stringify(req.method) +
      ', (url.path or "/") + ("?" + url.query if url.query else ""), skip_host=True, skip_accept_encoding=True)',
    ...(req.headers ?? []).map(
      (h) => 'connection.putheader(' + JSON.stringify(h.name) + ', ' + JSON.stringify(h.value) + ')',
    ),
    'connection.endheaders(base64.b64decode(' + JSON.stringify(req.body ?? '') + '))',
    'response = connection.getresponse()',
    'print(response.status, response.reason)',
    'print(response.getheaders())',
    'print(response.read())',
    'connection.close()',
  ].join(String.fromCharCode(10))
}

export function snapshotMenu(flow: Flow): MenuItem[] {
  return [
    {
      label: 'Copy as cURL',
      icon: 'terminal',
      onClick: async () => {
        await copyToClipboard(snapshotCode(flow.request, 'curl'), {
          label: 'cURL',
        })
      },
    },
    {
      label: 'Copy as Python',
      icon: 'terminal',
      onClick: async () => {
        await copyToClipboard(snapshotCode(flow.request, 'python'), {
          label: 'Python code',
        })
      },
    },
    {
      label: 'Copy URL',
      icon: 'copy',
      onClick: async () => {
        await copyToClipboard(flow.request.url, { label: 'URL' })
      },
    },
  ]
}

type Decoder = (
  side: 'request' | 'response',
  body: string | null | undefined,
  encoding: string,
) => Promise<string>

const headerValue = (headers: { name: string; value: string }[] | undefined, name: string) =>
  (headers ?? []).find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? ''

const localDecoder: Decoder = async (_side, body, encoding) => (await bodyToTextDecoded(body, encoding)).text

export default function FlowSnapshot({
  flow,
  extraMenu = [],
  decode = localDecoder,
}: {
  flow: Flow
  extraMenu?: MenuItem[]
  decode?: Decoder
}) {
  const [requestHex, setRequestHex] = useState(false)
  const [responseHex, setResponseHex] = useState(false)
  const [requestText, setRequestText] = useState(() => bodyToText(flow.request.body))
  const [responseText, setResponseText] = useState(() => bodyToText(flow.response?.body))
  const [requestEncoding, setRequestEncoding] = useState('')
  const [responseEncoding, setResponseEncoding] = useState('')
  useEffect(() => {
    let active = true
    const requestCE = headerValue(flow.request.headers, 'Content-Encoding')
    setRequestEncoding(requestCE)
    void decode('request', flow.request.body, requestCE).then((text) => active && setRequestText(text))
    if (flow.response) {
      const responseCE = headerValue(flow.response.headers, 'Content-Encoding')
      setResponseEncoding(responseCE)
      void decode('response', flow.response.body, responseCE).then((text) => active && setResponseText(text))
    } else {
      setResponseEncoding('')
      setResponseText('')
    }
    return () => {
      active = false
    }
  }, [flow, decode])
  const menu = [...extraMenu, ...snapshotMenu(flow)]
  const request = requestToRaw(flow.request).split(String.fromCharCode(10))[0]
  return (
    <div className={`snapshot-pair ${flow.response ? '' : 'request-only'}`}>
      <section className="panel snapshot-message" aria-label="Request">
        <div className="panel-head">
          <span className="title">Request</span>
          <span className="meta">{flow.request.method}</span>
          {requestEncoding && <span className="encoding-badge">decoded {requestEncoding}</span>}
          <div className="spacer" />
          <button className="btn sm" onClick={() => setRequestHex((v) => !v)}>
            {requestHex ? 'Raw' : 'Hex body'}
          </button>
          <button
            className="btn sm"
            onClick={() =>
              void copyToClipboard(
                [
                  request,
                  ...(flow.request.headers ?? []).map((h) => h.name + ': ' + h.value),
                  '',
                  requestText,
                ].join(String.fromCharCode(10)),
                {
                  label: 'request',
                },
              )
            }
          >
            Copy request
          </button>
        </div>
        {requestHex ? (
          <pre className="code-view">{bodyToHex(flow.request.body)}</pre>
        ) : (
          <RawView
            headLine={request}
            headers={flow.request.headers ?? []}
            text={requestText}
            extraMenu={menu}
            standalone
            full
          />
        )}
      </section>
      {flow.response ? (
        <section className="panel snapshot-message" aria-label="Response">
          <div className="panel-head">
            <span className="title">Response</span>
            <span className="meta">{flow.response?.statusCode ?? 'No response'}</span>
            {responseEncoding && <span className="encoding-badge">decoded {responseEncoding}</span>}
            <div className="spacer" />
            <button className="btn sm" disabled={!flow.response} onClick={() => setResponseHex((v) => !v)}>
              {responseHex ? 'Raw' : 'Hex body'}
            </button>
            <button
              className="btn sm"
              disabled={!flow.response}
              onClick={() =>
                flow.response &&
                void copyToClipboard(responseToRaw(flow.response, responseText), {
                  label: 'response',
                })
              }
            >
              Copy response
            </button>
          </div>
          {responseHex ? (
            <pre className="code-view">{bodyToHex(flow.response.body)}</pre>
          ) : (
            <RawView
              headLine={
                flow.response.httpVersion + ' ' + flow.response.statusCode + ' ' + flow.response.reason
              }
              headers={flow.response.headers ?? []}
              text={responseText}
              extraMenu={menu}
              standalone
              full
            />
          )}
        </section>
      ) : (
        <aside className="request-only-note" role="note">
          <b>Request-only snapshot</b>
          <span>No response was captured.</span>
          {flow.error && <code>{flow.error}</code>}
        </aside>
      )}
    </div>
  )
}
