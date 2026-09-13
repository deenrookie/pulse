// R3 custom plugin panel: the plugin's declared HTML renders in a sandboxed
// iframe (no direct DOM access to the app) and talks to the host over a
// versioned postMessage bridge. Bridge v1 supports notify + copy + a
// read-only summary of the inspected flow.
import { useEffect, useMemo, useRef } from 'react'

const BRIDGE_VERSION = 1

/** inject the bridge client into the plugin's HTML document */
function bridgeScript(pluginFile: string): string {
  return `<script>
(function () {
  var seq = 0;
  var waiting = {};
  window.addEventListener('message', function (ev) {
    if (!ev.data || ev.data.v !== ${BRIDGE_VERSION} || ev.data.plugin !== ${JSON.stringify(pluginFile)}) return;
    if (ev.data.type === 'rpc' && ev.data.seq != null && waiting[ev.data.seq]) {
      waiting[ev.data.seq](ev.data.result);
      delete waiting[ev.data.seq];
    }
  });
  function send(type, payload) {
    window.parent.postMessage({ v: ${BRIDGE_VERSION}, plugin: ${JSON.stringify(pluginFile)}, type: type, payload: payload }, '*');
  }
  window.pulse = {
    notify: function (text, kind) { send('notify', { text: text, kind: kind }); },
    copy: function (text) { send('copy', { text: text }); },
    rpc: function (method, args) {
      return new Promise(function (resolve) {
        var n = ++seq;
        waiting[n] = resolve;
        send('rpc', { method: method, args: args || [], seq: n });
      });
    },
    flow: function () { return window.pulse.rpc('flow'); }
  };
})();
</script>`
}

export default function PluginPanel({
  pluginFile,
  html,
  flowSummary,
  onNotify,
}: {
  pluginFile: string
  html: string
  flowSummary: { method: string; url: string; status: number } | null
  onNotify: (text: string, kind?: 'ok' | 'err') => void
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const summaryRef = useRef(flowSummary)
  summaryRef.current = flowSummary

  const doc = useMemo(() => bridgeScript(pluginFile) + html, [pluginFile, html])

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const d = ev.data
      if (!d || d.v !== BRIDGE_VERSION || d.plugin !== pluginFile) return
      const reply = (result: unknown) => {
        frameRef.current?.contentWindow?.postMessage({ v: BRIDGE_VERSION, plugin: pluginFile, type: 'rpc', seq: d.payload?.seq, result }, '*')
      }
      switch (d.type) {
        case 'notify':
          onNotify(String(d.payload?.text ?? ''), d.payload?.kind === 'err' ? 'err' : undefined)
          break
        case 'copy':
          void navigator.clipboard?.writeText(String(d.payload?.text ?? '')).then(
            () => onNotify('Copied to clipboard'),
            () => onNotify('Clipboard unavailable', 'err'),
          )
          break
        case 'rpc':
          if (d.payload?.method === 'flow') {
            reply(summaryRef.current)
          } else {
            reply({ error: 'unknown method' })
          }
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [pluginFile, onNotify])

  return (
    <iframe
      ref={frameRef}
      title={`Plugin panel: ${pluginFile}`}
      className="plugin-panel-frame"
      sandbox="allow-scripts"
      srcDoc={doc}
    />
  )
}
