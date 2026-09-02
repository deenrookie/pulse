// 全功能演示：读取并改写请求/响应的每一个部分。
// 复制到插件目录（或 Samples 标签一键载入编辑器保存）后，
// 经代理发送任意请求，即可在 Plugins 面板看到 pulse.log 输出。
plugin = {
  name: "Demo: Read & Rewrite",
  version: "1.0",
};

// ---- URL 工具：从完整 URL 中拆出 path 与 query 参数 ----
function pathOf(url) {
  var i = url.indexOf("://");
  var rest = i < 0 ? url : url.slice(i + 3);
  var slash = rest.indexOf("/");
  return slash < 0 ? "/" : rest.slice(slash).split("?")[0];
}

function queryParams(url) {
  var q = {};
  var i = url.indexOf("?");
  if (i < 0) return q;
  url.slice(i + 1).split("&").forEach(function (kv) {
    var p = kv.split("=");
    if (p[0]) q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || "");
  });
  return q;
}

// ---- header 工具：大小写不敏感地读取 / 设置（headers 是 {name, value} 数组）----
function header(headers, name) {
  for (var i = 0; i < headers.length; i++) {
    if (headers[i].name.toLowerCase() === name.toLowerCase()) return headers[i];
  }
  return null;
}

function setHeader(headers, name, value) {
  var h = header(headers, name);
  if (h) h.value = value;
  else headers.push({ name: name, value: value });
}

// ---- 请求钩子：获取 path / query 参数 / headers / POST body，并演示改写 ----
function onRequest(ctx) {
  var req = ctx.request;
  var path = pathOf(req.url);
  var params = queryParams(req.url);
  var ua = header(req.headers, "User-Agent");

  pulse.log("[req] " + req.method + " " + path);
  pulse.log("[req] query user=" + params.user + " verbose=" + params.verbose);
  pulse.log("[req] User-Agent: " + (ua ? ua.value : "(none)"));
  if (req.method === "POST" && req.body) {
    pulse.log("[req] body: " + req.body);
  }

  // 改写请求：替换一个头 + 向 JSON body 注入字段
  setHeader(req.headers, "User-Agent", "Pulse-Demo/1.0");
  if (req.method === "POST" && req.body && req.body.indexOf("{") >= 0) {
    try {
      var payload = JSON.parse(req.body);
      payload.injected_by = "pulse-demo";
      req.body = JSON.stringify(payload);
    } catch (e) {
      pulse.log("[req] body is not JSON, left untouched");
    }
  }
}

// ---- 响应钩子：获取 headers / body，并演示改写 ----
function onResponse(ctx) {
  var resp = ctx.response;
  var ct = header(resp.headers, "Content-Type");

  pulse.log("[resp] " + resp.status + " " + pathOf(ctx.request.url));
  pulse.log("[resp] Content-Type: " + (ct ? ct.value : "(none)"));
  if (resp.body) {
    pulse.log("[resp] body: " + resp.body.slice(0, 120));
  }

  // 改写响应：替换一个头 + 替换 body 中的模板标记
  setHeader(resp.headers, "X-Served-By", "pulse-demo");
  if (resp.body && resp.body.indexOf("{{username}}") >= 0) {
    resp.body = resp.body.replace(/\{\{username\}\}/g, "pulse-user");
  }
}
