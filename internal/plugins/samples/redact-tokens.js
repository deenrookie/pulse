// Redacts bearer tokens and api keys in responses before they reach the client.
plugin = {
  name: "Redact Tokens",
  version: "1.0",
};

var patterns = [
  /Bearer\s+[A-Za-z0-9._\-]+/g,
  /(api[_-]?key["'\s:=]+)[A-Za-z0-9_\-]{16,}/gi,
];

function onResponse(ctx) {
  var body = ctx.response.body;
  if (!body) return;
  for (var i = 0; i < patterns.length; i++) {
    body = body.replace(patterns[i], "[REDACTED]");
  }
  if (body !== ctx.response.body) {
    ctx.response.body = body;
    pulse.log("redacted response for " + ctx.request.url);
  }
}
