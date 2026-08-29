// Adds a custom header to every proxied request.
// Copy to <data-dir>/plugins/ and press Reload in Extensions → Plugins.
plugin = {
  name: "Add Header",
  version: "1.0",
};

function onRequest(ctx) {
  ctx.request.headers.push({ name: "X-Powered-By-Pulse-Plugin", value: "add-header" });
  pulse.log("tagged " + ctx.request.method + " " + ctx.request.url);
}
