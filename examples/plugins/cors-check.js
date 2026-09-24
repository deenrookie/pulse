// CORS Checker —— CORS 错误配置检测插件
//
// 检测原理：
//  1. 被动观察（onResponse，无网络）：识别响应中的可疑 CORS 组合
//     - Access-Control-Allow-Origin: *            —— 任何网站可直接跨域读取（无凭证）
//     - 通配符 + allow-credentials=true           —— 无效组合（浏览器拒绝），仍属错误配置
//     - 反射请求 Origin（尤其 + credentials=true）—— 疑似任意来源反射，待主动确认
//       （注意：反射"站点自己的 Origin"是白名单场景的正常行为，必须用外部 Origin 验证）
//  2. 主动验证（携带攻击者 Origin 重放，故意不带 Cookie/Authorization）：
//     若服务端反射攻击者 Origin（尤其 + allow-credentials=true），确认漏洞：
//     任何恶意网页都能跨域读取该接口响应（有 credentials 时还能携带受害者 Cookie）。
//  3. 打印可获取的数据：确认后输出攻击者能读到的内容——
//     真实会话响应（状态/类型/长度/敏感字段/预览）+ 无凭证探测响应。
//  4. 存在问题的 Flow 在 Live Traffic 中高亮为红色（ctx.highlight("red")）。
//
// 钩子分工（兼容 pulse v0.3.9+）：
//  - onResponse：通配符直接报告；反射/白名单端点打标并缓存会话快照（此钩子无网络）
//  - onRequest ：对已打标端点主动探测（此钩子可发 HTTP；探测会先于真实请求完成）
//  - onComplete：引擎正常派发时对刚完成的端点探测（与 onRequest 共享去重）
//
// 配置（编辑器上方 Configuration 行）：
//  - evilOrigin    攻击者 Origin（想测 null Origin 时改成 "null"）
//  - hosts         仅扫描 host 包含这些子串的流量（逗号分隔，空 = 全部）
//  - active        是否自动主动探测（关闭则只被动观察 + 手动动作）
//  - dedupeMinutes 同一端点去重窗口（分钟），避免重复探测/刷屏
//  - previewChars  打印 body 预览的字符数
//
// 手动动作（流量右键 Run: …）：
//  - "CORS: analyze this flow" —— 同步分析选中流量并打印可获取数据
//  - "CORS: print findings report" —— 打印累计发现
plugin = {
  name: "CORS Checker",
  version: "1.3",
  description: "Detect CORS misconfigurations (origin reflection / wildcard + credentials) and print the data an attacker site could read",
  config: {
    evilOrigin: { type: "string", label: "Attacker Origin for reflection test", default: "https://evil-cors.example" },
    hosts: { type: "string", label: "Only hosts containing (comma list, empty = all)", default: "" },
    active: { type: "boolean", label: "Actively re-send with attacker Origin", default: true },
    dedupeMinutes: { type: "number", label: "Dedupe window per endpoint (minutes)", default: 15 },
    previewChars: { type: "number", label: "Body preview chars to print", default: 160 }
  },
  actions: [
    { id: "corsProbe", label: "CORS: analyze this flow" },
    { id: "corsReport", label: "CORS: print findings report" }
  ]
};

var METHODS_WITH_BODY = ["POST", "PUT", "PATCH"];
var PROBE_METHODS = ["GET", "POST", "HEAD", "PUT", "DELETE", "PATCH"];

// ---- 配置读取（含默认值与类型防御）----
function cfgOf(ctx) {
  var c = ctx.config || {};
  function str(k, d) { return typeof c[k] === "string" && c[k] ? c[k] : d; }
  function num(k, d) { var n = Number(c[k]); return isFinite(n) && n > 0 ? n : d; }
  function bool(k, d) { return typeof c[k] === "boolean" ? c[k] : d; }
  return {
    evil: str("evilOrigin", "https://evil-cors.example"),
    hosts: typeof c.hosts === "string" ? c.hosts : "",
    active: bool("active", true),
    dedupeMs: num("dedupeMinutes", 15) * 60000,
    preview: num("previewChars", 160)
  };
}

function hostAllowed(host, list) {
  if (!list) return true;
  var parts = list.split(",");
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim().toLowerCase();
    if (p && host.toLowerCase().indexOf(p) >= 0) return true;
  }
  return false;
}

// ---- CORS 头摘要与分类 ----
function corsHeaders(msg) {
  return {
    acao: pulse.headers.get(msg, "Access-Control-Allow-Origin"),
    acac: pulse.headers.get(msg, "Access-Control-Allow-Credentials"),
    acah: pulse.headers.get(msg, "Access-Control-Allow-Headers"),
    acam: pulse.headers.get(msg, "Access-Control-Allow-Methods")
  };
}

// none（无 ACAO）/ wildcard（*）/ reflect（反射给定 Origin）/ fixed（固定白名单）
function classify(h, origin) {
  var acao = h.acao ? String(h.acao).trim() : null;
  var creds = !!h.acac && String(h.acac).trim().toLowerCase() === "true";
  if (!acao) return { kind: "none", creds: creds };
  if (acao === "*") return { kind: "wildcard", creds: creds };
  if (origin && acao === String(origin).trim()) return { kind: "reflect", creds: creds };
  return { kind: "fixed", creds: creds, acao: acao };
}

function endpointOf(req) {
  var u = pulse.url.parse(req.url);
  return { scheme: u.scheme, host: u.host, key: req.method + " " + u.host + u.path, target: req.method + " " + req.url };
}

// ---- 数据侧信息：预览 / 敏感字段 ----
function bodyPreview(body, n) {
  if (!body) return "(empty)";
  var flat = String(body).replace(/\s+/g, " ");
  return flat.length > n ? flat.slice(0, n) + "..." : flat;
}

function contentTypeOf(msg) {
  var ct = pulse.headers.get(msg, "Content-Type");
  return ct ? ct.split(";")[0].trim().toLowerCase() : "(none)";
}

function textLike(ct) {
  return !ct || ct === "(none)" || /^text\//.test(ct) ||
    /^application\/(json|xml|x-www-form-urlencoded|javascript)/.test(ct);
}

function sensitiveHits(body) {
  if (!body) return "";
  var s = String(body), hits = [];
  var emails = s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
  if (emails && emails.length) hits.push("email x" + emails.length);
  var tokenKeys = s.match(/"(?:access_?token|refresh_?token|api_?key|secret|password|session|jwt|authorization)"/gi);
  if (tokenKeys && tokenKeys.length) hits.push("token-like keys x" + tokenKeys.length);
  if (/bearer\s+[A-Za-z0-9._-]+/i.test(s)) hits.push("bearer token");
  var phones = s.match(/\b1[3-9]\d{9}\b/g);
  if (phones && phones.length) hits.push("phone x" + phones.length);
  return hits.join(", ");
}

// 真实会话响应快照：这就是"攻击者能读到的数据"
function liveSnapshot(resp, cfg) {
  if (!resp) return null;
  var ct = contentTypeOf(resp);
  return {
    status: resp.status, ct: ct,
    len: resp.body ? resp.body.length : 0,
    setCookie: !!pulse.headers.get(resp, "Set-Cookie"),
    sens: sensitiveHits(resp.body),
    preview: textLike(ct) ? bodyPreview(resp.body, cfg.preview) : "(binary body, preview skipped)"
  };
}

// ---- "待探测端点"登记（onResponse 打标，onRequest/onComplete 消费）----
function markWorthy(ep, kind, h, snap) {
  try {
    pulse.store.memory.set("corsW:" + ep.key, { kind: kind, acao: h.acao, creds: kind.creds, snap: snap, at: Date.now() });
    var idx = pulse.store.memory.get("corsWIdx");
    if (!idx || typeof idx.slice !== "function") idx = [];
    for (var i = idx.length - 1; i >= 0; i--) if (idx[i] === ep.key) idx.splice(i, 1);
    idx.push(ep.key);
    while (idx.length > 100) {
      pulse.store.memory.delete("corsW:" + idx.shift());
    }
    pulse.store.memory.set("corsWIdx", idx);
  } catch (e) { /* 状态失败不影响观察 */ }
}

function getWorthy(ep, cfg) {
  try {
    var w = pulse.store.memory.get("corsW:" + ep.key);
    if (!w || typeof w !== "object") return null;
    if (Date.now() - Number(w.at || 0) > cfg.dedupeMs) { pulse.store.memory.delete("corsW:" + ep.key); return null; }
    return w;
  } catch (e) { return null; }
}

// ---- 被动层：响应返回时立即分析（无网络）----
function onResponse(ctx) {
  try {
    var req = ctx.request, resp = ctx.response;
    if (!req || !resp) return;
    var h = corsHeaders(resp);
    if (!h.acao) return;

    var cfg = cfgOf(ctx);
    var ep = endpointOf(req);
    if ((ep.scheme !== "http" && ep.scheme !== "https") || !hostAllowed(ep.host, cfg.hosts)) return;

    var v = classify(h, pulse.headers.get(req, "Origin"));
    var snap = liveSnapshot(resp, cfg);

    if (v.kind === "wildcard") {
      // 通配符无需主动验证：任何网站本来就能（无凭证）读取该响应
      if (pulse.store.memory.increment("corsSeen:" + ep.key, 1, cfg.dedupeMs) > 1) return;
      report(ctx, cfg, v.creds ? "wildcard + credentials (invalid combo, browsers reject credentialed *)" : "wildcard",
        ep.target, "*", v.creds, snap, null);
      return;
    }

    // reflect / fixed：打标 + 缓存会话快照，等主动钩子用攻击者 Origin 验证
    markWorthy(ep, v, h, snap);
    if (v.kind === "reflect" &&
        pulse.store.memory.increment("corsLogP:" + ep.key, 1, cfg.dedupeMs) === 1) {
      pulse.log("[CORS][passive] origin reflected" + (v.creds ? " + allow-credentials=true" : "") +
        ": " + ep.target + " -> ACAO=" + h.acao + " (probing with attacker Origin...)");
    }
  } catch (e) {
    pulse.log("[CORS] onResponse error: " + e);
  }
}

// ---- 主动钩子 1：onRequest（当前引擎里唯一带网络 sender 的自动钩子）----
// 注意：探测先于真实请求完成，命中端点在每个去重窗口内首次请求会稍慢。
async function onRequest(ctx) {
  try {
    var req = ctx.request;
    if (PROBE_METHODS.indexOf(req.method) < 0) return;
    var cfg = cfgOf(ctx);
    if (!cfg.active) return;
    var ep = endpointOf(req);
    if ((ep.scheme !== "http" && ep.scheme !== "https") || !hostAllowed(ep.host, cfg.hosts)) return;

    var w = getWorthy(ep, cfg);
    if (!w) return; // 该端点从未出现过带 CORS 头的响应，不盲目探测
    if (pulse.store.memory.increment("corsSeen:" + ep.key, 1, cfg.dedupeMs) > 1) return;

    await probeAndReport(ctx, cfg, ep, w.snap);
  } catch (e) {
    pulse.log("[CORS] onRequest error: " + e);
  }
}

// ---- 主动钩子 2：onComplete（引擎派发后自动生效，与 onRequest 共享去重）----
async function onComplete(ctx) {
  try {
    var req = ctx.request, resp = ctx.response;
    if (!req || !resp || PROBE_METHODS.indexOf(req.method) < 0) return;
    var cfg = cfgOf(ctx);
    if (!cfg.active) return;
    var ep = endpointOf(req);
    if ((ep.scheme !== "http" && ep.scheme !== "https") || !hostAllowed(ep.host, cfg.hosts)) return;
    var h = corsHeaders(resp);
    if (!h.acao) return;
    if (pulse.store.memory.increment("corsSeen:" + ep.key, 1, cfg.dedupeMs) > 1) return;

    await probeAndReport(ctx, cfg, ep, liveSnapshot(resp, cfg));
  } catch (e) {
    pulse.log("[CORS] onComplete error: " + e);
  }
}

// ---- 用攻击者 Origin 重放并判定（探测本身不携带任何凭证）----
async function probeAndReport(ctx, cfg, ep, snap) {
  var req = ctx.request;
  var headers = [{ name: "Origin", value: cfg.evil }];
  var ct = pulse.headers.get(req, "Content-Type");
  if (ct) headers.push({ name: "Content-Type", value: ct });
  var accept = pulse.headers.get(req, "Accept");
  if (accept) headers.push({ name: "Accept", value: accept });

  var r;
  try {
    r = await pulse.http.send({
      method: req.method,
      url: req.url,
      headers: headers,
      body: METHODS_WITH_BODY.indexOf(req.method) >= 0 && req.body ? req.body : "",
      timeoutMs: 6000, // 受钩子 2s 总预算约束
      redirects: "manual"
    });
  } catch (e) {
    pulse.store.memory.delete("corsSeen:" + ep.key); // 释放名额，下次重试
    pulse.log("[CORS][warn] probe failed (" + e + "): " + ep.target);
    return;
  }

  var ph = corsHeaders(r);
  var pv = classify(ph, cfg.evil);

  if (pv.kind === "reflect") {
    report(ctx, cfg, pv.creds ? "credentialed origin reflection" : "origin reflection",
      ep.target, ph.acao, pv.creds, snap, r);
  } else if (pv.kind === "wildcard") {
    report(ctx, cfg, "wildcard", ep.target, "*", pv.creds, snap, r);
  } else {
    // 未反射攻击者 Origin：之前的反射/白名单是正常行为，不受此漏洞影响
    pulse.log("[CORS][ok] attacker Origin not accepted (ACAO=" + (ph.acao || "none") + "): " + ep.target);
  }
}

// ---- 报告：高亮问题流程并打印攻击者可以跨域读取的数据 ----
function report(ctx, cfg, verdict, target, acao, creds, live, probe) {
  // 问题流程标红（老版本宿主没有 ctx.highlight 时静默跳过）
  if (ctx && typeof ctx.highlight === "function") {
    try { ctx.highlight("red"); } catch (e) { /* 忽略 */ }
  }
  var lines = [];
  lines.push("[CORS][!!] VULNERABLE (" + verdict + "): " + target);
  lines.push("[CORS]      Access-Control-Allow-Origin: " + acao +
    (creds ? "  +  Access-Control-Allow-Credentials: true" : ""));
  lines.push(creds
    ? "[CORS]      impact: any malicious site can read this endpoint WITH the victim's cookies"
    : "[CORS]      impact: any site can read this response cross-origin (no credentials needed)");

  if (live) {
    lines.push("[CORS]      obtainable data (live session response " + live.status + "): " +
      live.ct + ", " + live.len + " bytes" + (live.setCookie ? ", Set-Cookie present" : ""));
    if (live.sens) lines.push("[CORS]      sensitive data in live body: " + live.sens);
    lines.push("[CORS]      live preview: " + live.preview);
  }

  if (probe) {
    var pct = contentTypeOf(probe);
    lines.push("[CORS]      unauthenticated probe (no cookies sent): " + probe.status + " " + pct + ", " +
      (probe.body ? probe.body.length : 0) + " bytes");
    if (textLike(pct)) lines.push("[CORS]      probe preview: " + bodyPreview(probe.body, cfg.preview));
  }

  for (var i = 0; i < lines.length; i++) pulse.log(lines[i]);
  saveFinding(target, verdict, acao, creds);
}

// ---- 发现持久化（最近 50 条），供报告动作使用 ----
function saveFinding(target, verdict, acao, creds) {
  try {
    var arr = pulse.store.local.get("findings");
    if (!arr || typeof arr.slice !== "function") arr = [];
    arr.push({ target: target, verdict: verdict, acao: acao, creds: !!creds, at: Date.now() });
    while (arr.length > 50) arr.shift();
    pulse.store.local.set("findings", arr);
  } catch (e) { /* 持久化失败不影响检测 */ }
}

// ---- 手动动作 ----
var actions = {
  // 右键任意流量：同步分析该流量的 CORS 头并打印可获取数据。
  // （actions 不支持 async，无法在这里发探测请求；主动验证由自动钩子完成：
  //   反射端点会被打标，下一次请求时自动用攻击者 Origin 探测。）
  corsProbe: function (ctx) {
    var req = ctx.request, resp = ctx.response;
    if (!req) return "CORS Checker: no request in this flow";
    if (!resp) return "CORS Checker: no response in this flow";
    var cfg = cfgOf(ctx);
    var h = corsHeaders(resp);
    if (!h.acao) return "CORS Checker: no Access-Control-Allow-Origin in this response";
    var v = classify(h, pulse.headers.get(req, "Origin"));
    if (v.kind === "wildcard") {
      report(ctx, cfg, v.creds ? "wildcard + credentials (invalid combo, browsers reject credentialed *)" : "wildcard",
        req.method + " " + req.url, "*", v.creds, liveSnapshot(resp, cfg), null);
      return "CORS Checker: VULNERABLE (wildcard) — see plugin log for obtainable data";
    }
    if (v.kind === "reflect") {
      report(ctx, cfg, "SUSPECTED " + (v.creds ? "credentialed " : "") + "origin reflection (passive; auto-probe with attacker Origin runs on the next request to this endpoint)",
        req.method + " " + req.url, h.acao, v.creds, liveSnapshot(resp, cfg), null);
      return "CORS Checker: suspected " + (v.creds ? "credentialed " : "") + "reflection — see plugin log";
    }
    return "CORS Checker: fixed trusted origin only (" + h.acao + "), no misconfiguration evidence";
  },

  // 打印累计发现
  corsReport: function (ctx) {
    var arr = pulse.store.local.get("findings");
    if (!arr || !arr.length) return "CORS Checker: no findings recorded yet";
    var out = ["CORS Checker: " + arr.length + " finding(s)"];
    for (var i = 0; i < arr.length; i++) {
      out.push("- [" + arr[i].verdict + "] " + arr[i].target +
        " (ACAO=" + arr[i].acao + (arr[i].creds ? ", credentials=true" : "") + ")");
      pulse.log("[CORS][report] " + out[out.length - 1]);
    }
    return out.join("\n");
  }
};
