plugin = { name: "Scoped debug header", version: "1.0", description: "Tag only the intended API requests" };

function onRequest(ctx) {
  var target = pulse.url.parse(ctx.request.url);
  if (target.host !== "api.example.test" || target.path.indexOf("/v1/") !== 0) return;
  pulse.headers.set(ctx.request, "X-Debug-Client", "pulse");
  pulse.log("Tagged an in-scope request");
}
