# Pulse 插件开发指南

Pulse 插件是一个放在数据目录 `plugins/` 下的 **JavaScript 文件**（ES5.1+，由内嵌的 [goja](https://github.com/dop251/goja) 运行时执行，无需安装任何东西）。插件可以观察并修改经过代理的每一个请求和响应。

## 快速开始

两种方式任选：

- **在线编辑（推荐）**：打开 **Extensions → Plugins → Editor** 标签，写代码、`Check` 校验、`Test run` 沙箱试跑、`Save to disk` 直接写入插件目录并立即生效。
- **手动放置**：把 `examples/plugins/` 里的示例复制到插件目录（Installed 标签顶部可查看并**修改目录路径**），然后点 Reload。

浏览器经代理访问任意站点，插件立即生效。**Samples** 标签里有可直接借鉴的样例代码（可一键复制或载入编辑器）。

## 插件结构

```js
// 元数据（可选，用于界面展示）
plugin = {
  name: "My Plugin",
  version: "1.0",
};

// 请求钩子：发往上游之前调用
function onRequest(ctx) {
  // ctx.request = { method, url, httpVersion, headers, body }
}

// 响应钩子：返回客户端之前调用
function onResponse(ctx) {
  // ctx.request  只读参考
  // ctx.response = { status, reason, httpVersion, headers, body }
}
```

两个钩子都是可选的；只想处理响应的插件可以只定义 `onResponse`。

## 数据模型与修改方式

`ctx` 是**可变的纯数据对象**——直接改字段即可，Pulse 会在钩子返回后把变更写回真实流量：

```js
function onRequest(ctx) {
  // 改方法 / URL
  ctx.request.method = "POST";
  ctx.request.url = ctx.request.url.replace("http://", "https://");

  // 改/加/删头（headers 是 {name, value} 数组）
  for (var i = 0; i < ctx.request.headers.length; i++) {
    if (ctx.request.headers[i].name === "User-Agent") {
      ctx.request.headers[i].value = "pulse-bot/1.0";
    }
  }
  ctx.request.headers.push({ name: "X-Powered-By", value: "my-plugin" });

  // 改 body（字符串形式；二进制内容请勿使用此钩子改写）
  ctx.request.body = "rewritten";
}

function onResponse(ctx) {
  if (ctx.response.body.indexOf("secret") >= 0) {
    ctx.response.body = ctx.response.body.replace(/secret/g, "[REDACTED]");
  }
}
```

## 工具 API：`pulse`

| 调用 | 说明 |
| --- | --- |
| `pulse.log(msg)` | 输出一行日志（显示在 Plugins 面板，保留最近 60 行） |
| `pulse.version` | Pulse 版本号 |

## R1 SDK：`pulse.*` 报文与数据助手

插件里可以直接使用以下宿主 API（作用于 `ctx.request` / `ctx.response` 的当前草稿，与直接改字段等效）：

| API | 说明 |
| --- | --- |
| `pulse.headers.get/getAll/set/append/remove(message, name, …)` | 大小写不敏感；set 去重、append 保留重复、remove 返回删除数 |
| `pulse.url.parse(url)` | 返回 `{scheme, host, port, path, query}` |
| `pulse.query.getAll/set/append/remove(request, name, value?)` | 操作 URL 查询参数，保留重复参数与顺序 |
| `pulse.cookies.get/set/remove(message, name, value)` | 按 Cookie 语义处理请求 Cookie 头 |
| `pulse.body.json / setJSON / setText(message, …)` | JSON/文本 body 读写 |
| `pulse.encoding.base64 / hex(text)` | 编码 |
| `pulse.crypto.sha256(text)` / `hmacSha256(key, text)` | 十六进制摘要/签名 |

### 状态与配置

- `ctx.state.get/set/delete/keys()`：同一 Flow 的 request→response 阶段共享，事务结束释放。
- `pulse.store.memory.get/set/delete/keys/increment(key, val?, ttlMs?)`：跨请求内存状态（重启丢失，支持 TTL 与原子 increment）。
- `pulse.store.local.get/set/delete/keys(key, …)`：插件持久 JSON 状态（重启保留，256KB 上限）。
- `plugin.config`：声明配置表单（`string/number/boolean/select/secret`），用户在编辑器上方的 Configuration 行填写；secret 只写不回显。运行时经 `ctx.config` 读取快照（含默认值合并）。

### 测试台导入

- **From Flow**：从已捕获流量挑选导入 request+response 作为夹具。
- **From Raw**：粘贴原始 HTTP 报文（请求或响应）自动构造夹具。

## R2：主动能力

### `pulse.http.send(options)` — 插件发起 HTTP 请求（异步）

```js
async function onRequest(ctx) {
  const r = await pulse.http.send({
    method: "POST", url: "https://auth.test/token",
    headers: [{ name: "Content-Type", value: "application/json" }],
    body: JSON.stringify({ grant: "refresh" }),
    timeoutMs: 5000, redirects: "manual",
  });
  if (r.status !== 200) return;
  pulse.store.memory.set("token", pulse.body.json(r).access_token);
}
```

- 返回 Promise，受钩子总预算与 `timeoutMs` 双重限制；超时/取消传播为 rejection。
- 请求**绕过插件链、Match & Replace 与拦截**（防自触发递归），以 `source: plugin` 记录，可在 Live Traffic 查看。
- `redirects: "manual"` 逐跳返回 3xx；凭证不自动继承。

### `ctx.respond()` / `ctx.drop()` — 终结动作（onRequest）

- `ctx.respond({ status, headers, body })`：本地响应，不发上游；Content-Length 自动重算；之后仍进入响应阶段插件。
- `ctx.drop({ reason })`：插件阻断事务（客户端收到 502，Flow 标记 blocked by plugin）。
- 同一事务重复终结动作会抛错。

### `onComplete(ctx)` — 完成后分析

事务结束后只读运行（可读写插件 store、发起 HTTP），不阻塞响应返回。

### Mock 网络测试模式

`POST /api/plugins/test-mock`（编辑器 Test run 的 Mock 模式）：未配置 mock 的 URL 一律报 `unmocked network request`——测试永远不会悄悄打到真实网络。

### Action — 手动动作

```js
plugin = { name: "Tools", actions: [ { id: "extract", label: "Extract endpoint" } ] };
var actions = { extract: (ctx) => ctx.request.method + " " + ctx.request.url };
```

声明的动作出现在**流量右键菜单**（Run: …），对选中 Flow 的副本运行；结果以 toast 展示。

### Repeater：Apply plugin

Repeater 请求面板头部的 **Apply plugin** 按钮对当前缓冲区副本运行选中插件的 onRequest，先预览结果，再手动应用回编辑器——不发包。Repeater 默认仍不自动经过插件。

## R3：工程化与高级扩展

### 目录项目（pulse.plugin.json）

单文件插件无需任何工程；需要拆分/打包/类型提示时升级为目录形式：

	pulse 目录/
	  pulse.plugin.json    # id、name、version、entry（默认 dist/plugin.js）
	  dist/plugin.js       # 入口产物（可用任意打包器生成）
	  src/…、tests/…、pulse.d.ts、README.md

- **manifest 是身份权威**：id 用于身份识别；name/version 覆盖代码内 `plugin` 元数据的同名声明。
- **身份冲突**：两个插件声明相同 id 时，后加载者报告 "duplicate plugin id" 并停止运行（源码仍可编辑修复），不静默遮蔽。
- 打包：在开发机用 esbuild 等工具将纯 JS 依赖打包为单文件产物放入 entry；Pulse 运行时不访问 npm、不执行安装脚本。产物在加载时经 goja 编译校验（兼容性以锁定版本的引擎为准）。

### SDK 类型与命令行

- **TypeScript 声明**：`GET /api/plugins/sdk` 返回完整的 `pulse.d.ts`（ctx/pulse/actions 全 API）。放置到插件旁：`/// <reference path="pulse.d.ts" />`。
- **CLI 检查/试跑**（与浏览器同一宿主契约）：
  	go run ./cmd/pulse plugins check internal/plugins/samples/demo-read-rewrite.js
  	go run ./cmd/pulse plugins test my-plugin.js fixture.json
  	# 或直接： pulse plugins check <path>

### 自定义 UI 面板（隔离 iframe + 版本化消息桥）

	plugin = { ..., uiPanel: { id: "notes", title: "Plugin notes", html: "<button onclick=…>…</button>" } };

- 面板渲染在 `sandbox="allow-scripts"` 的 iframe 里——**没有 Pulse 页面的 DOM 访问**。
- 页面挂在报文检查器（请求/响应）的附加页签上（首个声明 uiPanel 的启用插件）。
- **桥协议 v1**（postMessage）：`{ v: 1, plugin: "<file>", type, payload }`：
  - `pulse.notify(text, kind)` — 宿主 toast
  - `pulse.copy(text)` — 写剪贴板
  - `pulse.flow()` → `Promise<{method,url,status}|null>` — 只读当前检查的报文摘要
  - RPC 回复 `{type:'rpc', seq, result}`；未知方法返回 `{error:'unknown method'}`。

### 授权目录文件读写（pulse.files）

- 每插件一个授权目录（`PUT /api/plugins/files/{file}` 授权/传空撤销），持久化在数据目录。
- `pulse.files.read/write/list(rel)`：路径经规范化（`..` 折叠到根内）+ 符号链接解析校验，任何逃逸授权目录的路径（含 symlink 出口）都会抛错。
- 未授权时返回明确错误而非静默失败。

## 插件目录

默认是 `<数据目录>/plugins`。在 **Extensions → Plugins → Installed** 标签顶部的 *Plugin directory* 输入框里可以改成任意路径（回车或 Apply 生效，目录不存在会自动创建；Reset 恢复默认）。配置持久化在 `settings.json`（`pluginsDir` 字段），重启后仍然生效。

## 在线编辑器（Editor 标签）

| 动作 | 说明 |
| --- | --- |
| **Check** | 干跑编译：不落盘，立即报告语法/加载错误与检测到的钩子（含 `plugin` 元数据） |
| **Test run** | 沙箱试跑：用下方可编辑的 JSON 夹具（请求/响应）执行钩子，显示 `pulse.log` 输出、抛错、以及修改后的报文——**不产生任何真实流量** |
| **Save to disk** | 写入插件目录并热加载（`Ctrl+S` 同）。若代码有编译错误：文件照写、错误就地显示、插件保持不生效，修好再存即可 |
| **Delete** | 从插件目录删除该文件 |

## 如何保证写对 / 如何调试 / 如何及时发现错误

1. **写时**：`Check` 干跑编译，语法错误精确到 `行:列`（错误条上有可点击的位置标记）；能立即看到钩子是否被识别（`hooks: request, response`）。
2. **改前**：`Test run` 用自定义夹具试跑 —— 看日志（`pulse.log`）、看修改后的报文、看抛错，全程零流量，不会污染真实请求。**改了源码或夹具后，旧结果会标记为 stale（已过期）**，不会被误当作当前代码的结论。
3. **草稿保护**：编辑器内容每 0.5 秒自动保存为本地草稿（按文件名区分）。离开页面、切换文件或加载样例后再回来，未保存的修改会自动恢复；保存成功后草稿清除。
4. **运行中**：
   - 加载错误（语法/顶层抛错）显示在插件卡片的红色错误条上；
   - 钩子内运行时抛错只影响当次调用，错误与 `pulse.log` 输出实时显示在插件卡片（面板每 4 秒刷新）；
   - 每次钩子执行（含插件顶层初始化）都有 2 秒超时，死循环不会拖垮代理；
   - 插件卡片显示分离计数：`成功/尝试 ok · 错误 err`，悬停可见 modified/timeouts 明细；**最近的错误会一直保留**（不会被后续成功抹掉），带时间戳。
5. **运行版本保护（last good revision）**：保存了一份加载不上的坏源码？代理**继续运行上一次能加载的修订**（插件卡片显示“last good revision running”，编辑器里仍显示坏源码供修复）。重启后同样恢复该有效修订。修好源码并保存后自动回到正常运行。
6. **禁用即止血**：插件卡片上的开关可立即停用某个插件，不影响其他插件。若启停状态的磁盘持久化失败，会明确报错而不是假装成功。

## 运行规则（与安全）

- **执行顺序**：`onRequest` 钩子按文件名顺序执行 → Match & Replace 规则 → Intercept（你在拦截面板里看到的是最终形态）→ 上游。响应方向：`onResponse` → 响应规则 → 客户端。
- **隔离**：每次钩子调用都在**全新的 VM** 中执行，插件之间、请求之间不共享状态（闭包变量每次都是新的）。
- **超时**：单次钩子执行（含每次调用中的顶层初始化）上限 **2 秒**，超时自动中断；死循环不会拖垮代理。
- **错误隔离**：语法错误在加载时记录到插件状态；运行时抛错只影响当次调用，其余插件与代理流程不受影响。错误显示在 Plugins 面板。
- **性能**：每个请求都会实例化 VM 并重新执行插件顶层代码。顶层应只做函数定义，不要放重计算。
- **能力边界**：无网络、无文件系统、无计时器——纯数据变换。需要发请求的插件能力在路线图（v0.5 将提供 `pulse.fetch`）。

### v1 字段契约（明确且经过测试）

| 字段 | onRequest 可写 | onResponse 可写 | 说明 |
| --- | --- | --- | --- |
| `ctx.request.method / url / headers / body` | ✓ | ✓（v1 兼容行为，保留） | 响应阶段改请求是 v1 历史行为，v2 将收紧 |
| `ctx.response.status / headers / body` | —（无 response） | ✓ | |
| `ctx.request.httpVersion` / `ctx.response.httpVersion` | 只读 | 只读 | 协议由传输层控制 |
| `ctx.response.reason` | — | 只读 | HTTP/1 语义，HTTP/2 无 reason phrase |

## 已知限制

- body 以 UTF-8 字符串往返；二进制 body 改写后可能损坏（不建议在插件中改二进制内容）。
- Repeater 发送的请求不经过插件与重写规则（与 Burp 默认行为一致）。

## 示例

仓库 `examples/plugins/`（同样内容内置在 **Extensions → Plugins → Samples** 标签，带语法高亮，可一键复制或载入编辑器）：

| 文件 | 作用 |
| --- | --- |
| `demo-read-rewrite.js` | **全功能演示**：获取/改写请求路径、query 参数、headers、POST body 与响应 headers/body |
| `add-header.js` | 为所有请求注入自定义头，并演示 `pulse.log` |
| `redact-tokens.js` | 响应中的 Bearer token / API key 打码（正则） |
| `template.js` | 最小插件骨架 |

## 路线图

- `pulse.fetch(url, options)` —— 插件内发起 HTTP 请求
- 脚本化 UI 面板（自定义 tab）
- 按作用域（scope）过滤钩子触发
