# Pulse HTTP API 参考

基址：`http://127.0.0.1:8000`（UI 监听地址）。所有请求/响应均为 JSON（除证书下载与 SSE）。

通用约定：
- Header 数组形式：`[{"name":"Content-Type","value":"application/json"}]`（保序保重复）。
- `body` 字段为 base64 编码字节（Go `[]byte` 默认 JSON 序列化）；空体为 `""`。
- 错误响应：`{"error":"message"}`，状态码 4xx/5xx。

## 运行状态

### `GET /api/health`
存活探测。→ `{"ok":true,"version":"0.1.0"}`

### `GET /api/status`
运行概况。
```json
{
  "version": "0.1.0",
  "proxyAddr": "127.0.0.1:8080",
  "uiAddr": "127.0.0.1:8000",
  "dataDir": "C:\\Users\\x\\.pulse",
  "caFingerprint": "SHA256:AB:CD:…",
  "flows": {"total": 128, "pending": 1},
  "intercept": {"enabled": false, "pending": 0, "capacity": 50}
}
```

## 流量（Flows）

### `GET /api/flows?limit=100&offset=0&q=keyword`
分页 + 关键字过滤（匹配 method/host/path/status）。响应体不含 `body`（列表轻量）。
```json
{"total": 128, "items": [ { "id":"req-42", "method":"GET", "url":"https://a.com/x",
  "host":"a.com","path":"/x","statusCode":200,"contentType":"text/html",
  "reqSize":123,"respSize":4567,"durationMs":88,"state":"complete",
  "timestamp":"2026-08-29T12:00:00Z","source":"proxy"} ]}
```

### `GET /api/flows/{id}`
完整 Flow（含请求/响应头与 base64 正文）。404 若不存在。

### `GET /api/flows/{id}/render`
以原始 Content-Type 直接渲染响应正文（"在浏览器中查看响应"）。带 `Content-Security-Policy: sandbox` 等安全头。

### `DELETE /api/flows` / `DELETE /api/flows/{id}`
清空全部 / 删除单条。

## 实时事件（SSE）

### `GET /api/events`
`text/event-stream`。事件类型与载荷（`data` 为 JSON）：
- `hello`：`{interceptEnabled, pendingCount}`
- `flow`：新 Flow 完整对象
- `flow_update`：更新后的 Flow 完整对象
- `intercept`：`{pendingCount}` —— 拦截队列变化

## 拦截（Intercept）

### `GET /api/intercept` → `{"enabled":false,"capacity":50,"pending":[{id,method,url}]}`
### `PUT /api/intercept` `{"enabled":true}` → 开关

### `GET /api/intercept/{id}` → 挂起请求完整 Request
### `POST /api/intercept/{id}/forward`
可选载荷为修改后的完整 Request（缺省原样放行）：
```json
{"request": {"method":"POST","url":"https://a.com/x","httpVersion":"HTTP/1.1",
  "headers":[{"name":"X-A","value":"1"}],"body":"aGVsbG8="}}
```
### `POST /api/intercept/{id}/drop`
丢弃；代理向客户端返回 502。

## 重放（Repeater）

### `GET /api/repeater` → `{"tabs":[{"id":"tab-1","title":"GET a.com/x","request":{…},"lastResponse":{…|null}}]}`
### `POST /api/repeater` `{"flowId":"req-42"}`（或直接 `{"request":{…}}`）
从历史流量（或裸请求）创建标签 → 返回新标签。
### `PUT /api/repeater/{id}` `{"request":{…}}` —— 保存编辑
### `DELETE /api/repeater/{id}` —— 删除标签
### `POST /api/repeater/{id}/send`（可选 `{"request":{…}}` 顺带保存并发送）
执行请求（不经浏览器代理，直接由引擎拨号）→ 返回产生的完整 Flow；同时进入 History（`source:"repeater"`）。

## 证书

### `GET /api/cert`
`application/x-pem-file` 附件下载 CA（`pulse-ca.pem`）。

## 重写规则（Match & Replace）

### `GET /api/rewrite` → `{"rules":[{...}]}`
规则字段：`id`（rule-N）、`enabled`、`zone`（`request_line`|`request_header`|`request_body`|`response_header`|`response_body`）、`match`、`replace`、`regex`、`comment`、`hits`（本次会话命中数）。

### `POST /api/rewrite` `{zone,match,replace,regex,comment,enabled}` → 201 新规则
非法 zone / 空 match / 非法正则返回 400。
### `PUT /api/rewrite/{id}` → 更新（同上字段）
### `DELETE /api/rewrite/{id}` → 删除

## 插件（Plugins）

### `GET /api/plugins` → `{"plugins":[...],"dir":"<plugins 目录>"}`
插件字段：`name`、`version`、`file`、`enabled`、`hooks`（`["request","response"]`）、`hits`、`error?`、`log?`（最近 60 行）。
### `POST /api/plugins/reload` → 重扫插件目录并返回新列表
### `PUT /api/plugins/{file}` `{"enabled":bool}` → 启停单个插件

## Request 对象结构（提交类接口通用）
```json
{
  "method": "GET",
  "url": "https://host/path?query",
  "httpVersion": "HTTP/1.1",
  "headers": [{"name":"…","value":"…"}],
  "body": "base64…"
}
```
服务端忽略 `id/timestamp/source` 等只读字段；`body` 缺省为空。
