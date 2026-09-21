# Pulse HTTP API 参考

基址：`http://127.0.0.1:8787`（UI 监听地址）。所有请求/响应均为 JSON（除证书下载、HAR 与 SSE）。

通用约定：
- Header 数组形式：`[{"name":"Content-Type","value":"application/json"}]`（保序保重复）。
- `body` 字段为 base64 编码字节（Go `[]byte` 默认 JSON 序列化）；空体为 `""`。
- 错误响应：`{"error":"message"}`，状态码 4xx/5xx。
- 非回环访问必须携带访问密钥：`X-Pulse-Key` 头，或 SSE 流的 `?key=`。

## 运行状态

### `GET /api/health`
存活探测。→ `{"ok":true,"version":"0.3.10"}`

### `GET /api/status`
运行概况（版本、代理地址、数据目录、CA 指纹、流量计数、拦截开关与队列、内存统计、插件目录）。
```json
{
  "version": "0.3.10",
  "proxyAddr": "127.0.0.1:8080",
  "uiAddr": "127.0.0.1:8787",
  "dataDir": "C:\\Users\\x\\.pulse",
  "caFingerprint": "SHA256:AB:CD:…",
  "flows": {"total": 128, "pending": 1},
  "intercept": {"enabled": false, "pending": 0},
  "memory": {"heapMB": 3, "sysMB": 10}
}
```

## 设置

### `GET /api/settings`
持久化设置。字段：`responseTimeoutSec`、`memoryGuardMB`（内存防护阈值）、`largeBodyMB`、`stubStatic`（Lean 省内存：binary/static/JS 响应体打桩）、`pluginsDir`、`proxyAddr`（热重绑后的代理地址）、`shareIP`（临时分享对外 IP）、`scope`（目标范围 host 列表，规则自动含子域）。

### `PUT /api/settings`
增补式更新，提交上面任意字段子集：
- `{"pluginsDir":"..."}` 切换插件目录（自动创建；空串恢复默认 `<data-dir>/plugins`）。
- `{"proxyAddr":"127.0.0.1:9090"}` 热重绑代理监听（先绑新再关旧；非法地址 400）。
- `{"shareIP":"192.168.1.5"}` IPv4/IPv6 地址，不能是 URL 或通配符。
- `{"scope":["api.example.com"]}` 上限 100；带路径/空格 400。

## 流量（Flows）

### `GET /api/flows?limit=200&offset=0&q=keyword`
分页 + 关键字过滤（匹配 method/host/path/status）。`limit` 默认 200、上限 1000。响应体不含 `body`（列表轻量），条目带标注字段 `star`/`note`。
```json
{"total": 128, "items": [ { "id":"req-42", "method":"GET", "url":"https://a.com/x",
  "host":"a.com","path":"/x","statusCode":200,"contentType":"text/html",
  "reqSize":123,"respSize":4567,"durationMs":88,"state":"complete",
  "timestamp":"2026-08-29T12:00:00Z","source":"proxy","star":false,"note":"" } ]}
```

### `GET /api/flows/{id}`
完整 Flow（含请求/响应头与 base64 正文）。404 若不存在。

### `PUT /api/flows/{id}/annotate` `{"star":true}` / `{"note":"…"}`
★ 收藏与备注（字段可选，只更新提交的字段）；持久化于数据目录。

### `GET /api/flows/{id}/render`
以原始 Content-Type 直接渲染响应正文（"在浏览器中查看响应"）。带 `Content-Security-Policy: sandbox` 等安全头。

### `GET /api/flows/har`
全部完成态流量导出为 HAR 附件。

### `DELETE /api/flows` / `DELETE /api/flows/{id}`
清空全部 / 删除单条。

## 深搜

### `GET /api/search?q=needle&side=request|response`
跨 traffic + repeater 的全文检索（`side` 缺省两侧）；返回命中条目与上下文供深搜面板定位。

## 解码

### `POST /api/decode` `{"body":"<base64>","encoding":"gzip|deflate|br|bzip2|identity"}`
正文按指定编码解码，返回解码后 base64；供分享页与检查器复用。

## 实时事件（SSE）

### `GET /api/events`
`text/event-stream`。事件类型与载荷（`data` 为 JSON）：
- `hello`：`{interceptEnabled, pendingCount}`
- `flow`：新 Flow 完整对象
- `flow_update`：更新后的 Flow 完整对象
- `intercept`：`{pendingCount}` —— 拦截队列变化

## 拦截（Intercept）

### `GET /api/intercept` → `{"enabled":false,"respEnabled":false,"capacity":50,"pending":[…],"respPending":[…]}`
### `PUT /api/intercept` `{"enabled":true}` / `{"respEnabled":true}` → 请求/响应阶段拦截开关（可同时提交）

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

### `GET /api/repeater` → `{"tabs":[{"id":"tab-1","title":"GET a.com/x","request":{…},"lastResponse":{…|null},"history":[…]}]}`
历史记录含每次发送的原始 Request（供分享配对）。
### `POST /api/repeater` `{"flowId":"req-42"}`（或直接 `{"request":{…}}`）
从历史流量（或裸请求）创建标签 → 返回新标签。
### `PUT /api/repeater/{id}` `{"request":{…}}` —— 保存编辑
### `DELETE /api/repeater/{id}` —— 删除标签
### `POST /api/repeater/{id}/send`（可选 `{"request":{…}}` 顺带保存并发送）
执行请求（不经浏览器代理，直接由引擎拨号）→ 返回产生的完整 Flow；同时进入 History（`source:"repeater"`）。

## Intruder

### `GET /api/intruder` → `{"attacks":[{id,raw,payloads,mode,targetURL,results?,lastRunAt?,createdAt,updatedAt}]}`
攻击计划与最后一轮结果持久化于 `<data-dir>/attacks.json`。
### `POST /api/intruder` `{"raw","payloads?","mode?","targetURL?"}` → 创建攻击（raw 内 `§…§` 标记位置；payloads 每行一个）
### `PUT /api/intruder/{id}` 同上字段 → 更新；`PUT /api/intruder/{id}/results` `{"results":[...]}` → 保存最后一轮结果摘要和 Flow ID
### `DELETE /api/intruder/{id}` → 删除
### `POST /api/intruder/fire` `{"request":{…}}` → 发送单次请求（控制台把载荷替换进 §位置§ 后调用；复用引擎 RoundTrip，不落任何存储）

`mode`：`sniper | battering-ram | pitchfork`；Pitchfork 载荷集按位配对。旧计划自动推断。计划原子写盘，失败保留旧文件。

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

基础（编辑与测试）：
- `GET /api/plugins` → `{"plugins":[...],"dir":"<plugins 目录>"}`；插件字段 `name`、`version`、`file`、`enabled`、`hooks`、`hits`、`error?`、`log?`（最近 60 行）
- `POST /api/plugins/reload` → 重扫插件目录
- `PUT /api/plugins/{file}` `{"enabled":bool}` → 启停
- `GET|PUT|DELETE /api/plugins/source/{file}` → 读/写（写后热加载，编译错误返回 `{"error":"compile: ..."}` 但文件已落盘）/删除源码
- `POST /api/plugins/validate` `{"src":"..."}` → 干跑编译
- `GET /api/plugins/samples` → 内嵌样例（Samples 标签同源）
- `POST /api/plugins/test` `{"src","hook","request":{...},"response":{...}?}` → 沙箱试跑（零流量）

平台扩展（R2/R3）：
- `GET|PUT /api/plugins/config/{file}` → 插件配置表单值（secret 字段写入后不回显）
- `POST /api/plugins/action/{file}/{action}` → 手动执行注册的 Action（右键菜单）
- `POST /api/plugins/apply` `{"src"|"file","request":{...}}` → 对给定请求应用插件（Repeater *Apply plugin* 使用）
- `POST /api/plugins/test-mock` → 模拟网络测试模式（未 mock 的请求得到确定性错误，不发出真实流量）
- `GET /api/plugins/sdk` → 生成的 TypeScript `.d.ts`（与运行实例同源）
- `GET|PUT /api/plugins/files/{file}/...` → 授权 `pulse.files` 目录读写（路径规范化 + 符号链接逃逸检查）

插件能力契约（钩子、SDK、主动 HTTP、目录项目、UI 面板）见 [Plugins.md](Plugins.md)。

## AI 技能

- `GET /api/plugins/skill` → `{name:"pulse-plugin-dev",content:"…SKILL.md…"}`（Skills 标签同源）
- `GET /api/plugins/skill/download` → 完整 ZIP（SKILL.md、模板、正反夹具、SDK 类型、Python 沙箱断言脚本）

## 临时分享（Traffic sharing）

控制端点沿用正常访问 gate；公开路由的令牌只授权所选快照。

| Endpoint | Contract |
| --- | --- |
| POST /api/shares/preview | {flowId} 或 {repeaterId,historyAt?} → 完整捕获 Flow |
| POST /api/shares | 同源外加 ttlMinutes（默认 10080；1..525600）→ 201 {id,url,flowId,createdAt,expiresAt} |
| GET /api/shares | {shares:[...]} 活跃元数据 |
| DELETE /api/shares/{id} | 撤销（磁盘+索引）；幂等 200 {ok:true} |
| GET /share/{id} | 公开查看页外壳；无效/过期/已撤销 404；写方法 405 |
| GET /share/{id}/data | {share,flow}；完整捕获的请求/响应/错误与 WebSocket 数据 |
| GET /share/{id}/data?download | 同一 JSON 作为附件下载 |
| GET /share/{id}/decode?side=request\|response | 仅此令牌可用的 gzip/deflate/br/bzip2 解码 |

分享无条数、单条或总字节数配额。完整载荷以 0600 文件落在 0700 分享目录并原子发布，内存仅索引元数据；磁盘失败不发布链接。重启恢复未过期分享；到期在读取时回收。分享层不脱敏、不裁剪——原捕获阶段的截断/Lean 标记保留，不能重建未存入的数据。

Repeater 源选择：仅显式 `historyAt` 分享历史配对的 Request/Response；缺省分享标签当前保存的 Request（无 Response）。未发送的编辑内容绝不与旧响应配对。

## 应用内更新

### `GET /api/update/check` → `{"current","latest","newer",assetName/assetUrl,size,notes}`
对比 GitHub Releases 最新版本。
### `POST /api/update/apply` → 下载并替换二进制（写入临时文件后原子替换）
### `POST /api/update/restart` → 重启实例（保留参数）

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
