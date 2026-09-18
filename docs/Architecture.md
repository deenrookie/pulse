# Pulse 技术架构文档

> 版本：v0.3.9 · 后端 Go（标准库 + goja JS 运行时 + golang.org/x/net/http2） · 前端 React 18 + TypeScript + Vite
>
> 生产默认端口：代理 `127.0.0.1:8080`、UI/API `127.0.0.1:8787`；开发模式后端 8000、Vite 5175（见 `dev.sh`）。路线图与已实现能力对照见 [Product.md](Product.md)；插件 API 细节见 [Plugins.md](Plugins.md)。

## 1. 系统总览

Pulse 是单进程双监听的本地服务：

```
                    ┌─────────────────────────────────────────────────┐
                    │                  pulse (Go)                     │
 浏览器/客户端        │                                                 │   目标服务器
 ────────────┐      │  ┌────────────┐   ┌──────────┐   ┌───────────┐  │   ┌─────────┐
  代理流量    ├──────┼─▶│ Proxy :8080 ├──▶│ Intercept│──▶│  Dialer   ├──────┼─▶│ origin  │
 (HTTP/HTTPS │      │  │  (MITM)    │   │ (队列/挂起)│   │(h2/1.1,TLS)│  │   └─────────┘
  WS/H2)     │      │  └─────┬──────┘   └──────────┘   └───────────┘  │
             │      │        │ flow                                    │
             │      │        ▼                                         │
             │      │  ┌────────────┐    SSE     ┌──────────────────┐  │
  控制台浏览器 ├──────┼─▶│ API/UI:8787│◀──────────│  React SPA       │  │
 (任意现代浏览器)│     │  │ REST + SSE │──────────▶│  (embedded/dist) │  │
             │      │  │ /share/:id │           └──────────────────┘  │
             │      │  └─────┬──────┘                                 │
             │      │        ▼                                         │
             │      │  ┌────────────┐   ┌──────────────┐              │
             │      │  │  Store     │──▶│ data dir     │              │
             │      │  │ (内存+JSONL)│   │ flows.jsonl  │              │
             │      │  └────────────┘   │ repeater.json│              │
             │      │                   │ attacks.json │              │
             │      │                   │ shares/      │              │
             │      │                   │ ca.pem/key   │              │
             │      └───────────────────┴──────────────┴──────────────┘
```

- **Proxy 监听（默认 `127.0.0.1:8080`）**：接收代理协议流量（绝对形式请求 + `CONNECT` 隧道）；TLS 隧道经 ALPN 协商 `h2`（HTTP/2 下游 MITM）或 `http/1.1`。
- **UI/API 监听（默认 `127.0.0.1:8787`）**：REST API、SSE 事件流、生产模式下内嵌的 React 静态资源；`/share/<token>` 为公开只读分享路由（仅暴露单个快照，无需实例密钥）。
- 两个监听均默认只绑定回环地址（见安全模型 §6）；非回环 API 需要访问密钥（`PULSE_KEY`）。

## 2. 代码结构

```
pulse/
├── cmd/pulse/
│   ├── main.go               # 入口：装配 flags、logger、引擎、API，阻塞运行
│   └── plugins_cli.go        # `pulse plugins check/test` 子命令
├── internal/
│   ├── certs/certs.go        # CA 生成/加载（每机一份）、按主机叶子证书签发与缓存
│   ├── events/events.go      # SSE hub（订阅者 channel 广播）
│   ├── proxy/                # MITM 代理引擎
│   │   ├── engine.go         # 监听器、连接生命周期、请求管线编排、ALPN h2 下游
│   │   ├── wire.go           # HTTP/1.1 手工读写（保序保重复、分帧、隧道）
│   │   ├── forward.go        # 上游拨号（h2 优先 ALPN，失败回退 1.1/TLS/明文）、101 隧道
│   │   ├── intercept.go      # 双向拦截队列：Hold/Forward/Drop，容量与降级
│   │   └── *_test.go         # MITM/拦截/隧道/重放/管线顺序集成测试
│   ├── store/store.go        # Flow 内存索引 + JSONL 追加日志，重启重放
│   ├── repeater/repeater.go  # 重放标签持久化与执行（含每次历史原始请求）
│   ├── rewrite/rewrite.go    # Match & Replace 规则引擎（5 个作用域，正则缓存）
│   ├── update/update.go      # 应用内更新检查/下载/替换
│   ├── plugins/              # JS 插件平台（详见 Plugins.md）
│   │   ├── plugins.go        # Runtime：加载（含目录项目/身份冲突）、隔离 VM 执行
│   │   ├── sdk.go            # pulse SDK（headers/url/query/cookies/body/…）
│   │   ├── state.go          # ctx.state 事务 + 内存/持久存储
│   │   ├── config.go         # plugin.config 表单（secret 不回显）
│   │   ├── r2.go             # 主动能力：host 事件循环、respond/drop、Actions
│   │   ├── http.go           # pulse.http.send（防递归、source:plugin、Mock）
│   │   ├── manifest.go       # pulse.plugin.json 目录项目
│   │   ├── ui.go             # 沙箱 UI 面板定义 + pulse.files 授权
│   │   ├── skills/           # 内嵌 pulse-plugin-dev AI 技能包
│   │   └── samples/          # 内嵌样例插件
│   └── api/
│       ├── server.go         # 路由装配、静态资源、Host 校验 + 密钥 gate、/share 公开路由
│       ├── flows.go          # /api/flows*（列表/详情/render/HAR/标注）
│       ├── search.go         # /api/search 全文深搜
│       ├── intercept.go      # /api/intercept*（请求+响应）
│       ├── repeater.go       # /api/repeater*
│       ├── intruder.go       # /api/intruder*（计划持久化 + fire）
│       ├── rewrite.go        # /api/rewrite* CRUD
│       ├── plugins.go        # /api/plugins*（编辑/测试/config/action/apply/sdk/skill/files）
│       ├── shares.go         # /api/shares* + /share/:id 公开查看/下载/解码
│       ├── skills.go         # 技能页数据源
│       ├── settings.go       # /api/settings（超时/内存防护/Lean/插件目录/scope/shareIP/热重绑）
│       ├── update_api.go     # /api/update/*（检查/应用/重启）
│       ├── events.go         # /api/events（SSE）
│       └── misc.go           # health/status/cert/decode
├── web/                      # React SPA（详见 §8）
├── examples/plugins/         # 示例插件（add-header / redact-tokens）
├── docs/                     # 本文档集（含 Plugins.md 插件开发指南）
└── go.mod                    # 依赖：goja（JS 运行时）+ golang.org/x/net（http2）
```

## 3. 核心数据模型（internal/store）

```go
type Header struct{ Name, Value string }     // 保序、保重复

type Request struct {
    ID      string    // 流量内唯一（req-<n>）
    Method  string    // GET/POST/...
    URL     string    // 完整绝对 URL（scheme://host/path?query）
    HTTPVersion string
    Headers []Header
    Body    []byte    // JSON 中 base64，上限 10MB
    Truncated bool    // 超限截断标记
    Timestamp time.Time
    Source  string    // "proxy" | "repeater"
}

type Response struct {
    StatusCode  int
    Reason      string
    HTTPVersion string
    Headers     []Header
    Body        []byte
    Truncated   bool
    Timestamp   time.Time
    DurationMs  int64
}

type Flow struct {
    ID      string    // 请求 ID 一致（flow 主键）
    Req     Request
    Resp    *Response // 未完成时为 nil
    State   string    // "pending" | "complete" | "intercepted" | "dropped" | "error"
    Error   string
}
```

设计要点：
- **Header 用 `[]{Name,Value}` 而非 map**：保持顺序与重复头（Set-Cookie、安全审计关键语义）。
- **Flow 以请求为主键**：请求先落库（State=pending），响应到达原地更新（State=complete）。
- **JSONL 追加日志**：每次写入/更新都追加整条 Flow 记录；加载时按 ID 后写覆盖先写（last-wins）。简单、崩溃安全（最坏丢最后一行）、人可 grep。

## 4. MITM 代理引擎（internal/proxy）

### 4.1 连接处理状态机

```
client conn
   │ 读首请求（http.ReadRequest）
   ├─ 绝对形式（http://example.com/…）──────────▶ 明文 HTTP 代理 ──▶ handleRequest
   └─ CONNECT host:443
        │ 回写 200 Connection Established
        │ tls.Server(conn, NextProtos=["h2","http/1.1"], GetCertificate=按 SNI/主机签叶子证书)
        ▼
      TLS(客户端↔Pulse)   ←—— 叶子证书由 Pulse CA 签发；ALPN 协商 h2 或 http/1.1
        │ h2: HTTP/2 帧解析（http2.Server）   1.1: 循环 http.ReadRequest（origin-form）
        ▼
      handleRequest ── 拦截开启? ──▶ Intercept.Hold() ── 等待 Forward/Drop
        │
        ▼
      Dialer 上游（h2 优先，失败回退 1.1/TLS/明文）
        ├─ 101 Switching Protocols ─▶ 双向原始隧道（WebSocket 等）
        └─ 普通响应 ─▶ （响应拦截开启? Hold）─▶ 记录 Flow（请求先记、响应补记）→ 回写客户端
```

### 4.2 证书体系（internal/certs）
- 首次启动生成 **CA**：ECDSA P-256、CN=Pulse CA、10 年有效，落盘 `ca.pem`/`ca-key.pem`（私钥 0600）。
- **叶子证书**：按主机名懒生成，SAN=主机名（含 IP），24 小时有效，内存缓存（LRU 上限 1024，防内存膨胀）。
- 叶子证书生成由 `tls.Config.GetCertificate` 回调驱动，SNI 为空时回退 CONNECT 目标主机。

### 4.3 上游转发（internal/proxy/forward.go）
- 上游连接**优先尝试 HTTP/2**（`http2.Transport`，ALPN 协商）：多路复用、现代源站默认支持；任何失败（源站无 h2、拨号、流错误）自动回退 **HTTP/1.1 手工拨号**（`net.Dial` → 可选 `tls.Client`），以便：
  1. `101 Upgrade` 后能拿到原始连接做双向隧道；
  2. 精确控制写出字节与超时；
  3. 上游 TLS 校验策略可注入（生产走系统根；测试注入测试 CA 池）。
- TLS 1.2 握手失败（仅支持 RSA 的老网关）时以 plain-RSA ClientHello 重试。
- 逐跳头处理：剥离 `Proxy-Connection/Connection/Keep-Alive/Upgrade*` 等 hop-by-hop 头后按语义重建。
- 正文读取上限 `MaxBodySize = 10MB`，超限截断并置 `Truncated`。
- 超时：拨号 10s，响应头 30s，整体读 60s；错误以 `State=error` 记入 Flow。

### 4.4 拦截（internal/proxy/intercept.go)
- **双向**：请求到达时与响应回写前均可挂起。`Hold(ctx, req)` 生成队列项，`select` 等待 `action chan` 或连接断开；响应拦截同理（`HoldResponse`）。
- `Forward(id, modifiedReq)` / `Drop(id)` 由 API 调用；Drop 向客户端回 502。挂起的压缩响应以明文编辑，放行时按原 `Content-Encoding` 重编码。
- 队列容量 50：满时自动放行最旧项（可用性优先，绝不丢连接不响应）。

### 4.5 扩展管线（internal/plugins + internal/rewrite）

请求方向（响应方向相反）：

```
capture → plugins.onRequest → Match&Replace(请求) → Intercept(手动) → 上游
上游响应 → plugins.onResponse → Match&Replace(响应) → 客户端
```

- **记录语义**：存储与界面展示的 Flow 始终是**实际发送/接收**的最终形态（插件与规则改写后）。
- **插件运行时**（goja，v0.3.7–v0.3.8 完整平台）：源码预编译，坏源码不落盘生效——保存失败或编译错误时**上一个有效修订继续运行**；每次钩子调用在带中断预算的隔离 VM 中执行，看门狗阻断死循环；主动能力（`pulse.http.send` 等）由宿主拥有的事件循环调度。完整契约见 [Plugins.md](Plugins.md)。
- **重写引擎**：规则按序应用；5 个作用域（请求行/请求头/请求体/响应头/响应体）；正则预编译缓存；请求行改写若变更 host 会自动同步 Host 头；命中计数（会话内）。规则持久化于 `match-replace.json`。
- **Repeater 默认不经过扩展管线**（与 Burp 默认一致）；可通过 *Apply plugin* 显式套用某个插件后发送。

## 5. API 与实时事件

- REST：见 `docs/API.md`（Go 1.21 标准库 mux，无框架）。
- **SSE（`GET /api/events`）**：hub 维护订阅者 channel；事件：
  - `flow` —— 新 Flow（含完整请求）
  - `flow_update` —— Flow 更新（响应到达/状态变化）
  - `intercept` —— 拦截队列变化（到达/处理）
  - `hello` —— 连接建立（携带当前状态快照）
- 选择 SSE 而非 WebSocket：事件流是单向的，SSE 免依赖、自动重连（前端 `EventSource`）。

## 6. 安全模型

| 威胁 | 对策 |
| --- | --- |
| MITM CA 私钥泄露 | CA 仅存本机数据目录，0600；**绝不**自动加入系统信任库，安装由用户显式完成并可随时卸载 |
| 局域网内他人连接代理（开放代理） | 双监听默认仅绑定 `127.0.0.1`；绑定非回环地址时启动日志显著告警 |
| API 被网页跨站调用（CSRF/DNS rebinding） | API 校验 `Host` 头必须为预期监听地址；非 GET 写操作需显式路由 |
| 恶意响应体撑爆内存 | 消息体 10MB 截断上限；流量总量由用户清空策略控制 |
| 上游 TLS 降级 | 默认按系统根 CA 完整校验（与浏览器一致的信任锚） |
| 敏感数据落盘 | 全部数据仅在本地数据目录；会话退出清空与项目文件加密在 [路线图](Product.md) 评估区 |

已知限制（v0.3.x）：
- 证书固定（certificate pinning）的客户端 App 无法解密，隧道会失败（与 Burp 行为一致）。
- 上游代理链（`CONNECT` 级联另一台代理）未实现，在 [路线图](Product.md) 评估区。

## 7. 进程与运行

```
main.go
 ├─ flags: --proxy :8080 --ui :8787 --data-dir %USERPROFILE%/.pulse --open(否)
 ├─ certs.LoadOrCreateCA()                   # 每机一份（~/.pulse），实例间共享
 ├─ store.Open(dataDir/flows.jsonl)          # 重放日志恢复历史
 ├─ proxy.NewEngine(store, certs, events) → goroutine ListenAndServe
 ├─ repeater.Open(dataDir/repeater.json)
 └─ api.NewServer(...).ListenAndServe()      # 阻塞（含 /share 公开路由）
```

- 优雅退出：收到 SIGINT/SIGTERM 后关闭监听、flush 存储。
- 生产静态资源：`//go:embed all:web/dist`，`/` 提供 SPA（index 兜底路由）。

## 8. 前端架构（web/）

```
web/src/
├── main.tsx / App.tsx        # 布局、标签路由（hash 路由，支持深链接 ?flow=）
├── api.ts                    # fetch 封装 + SSE 订阅 + 类型定义（与 Go 模型一一对应）
├── state.ts                  # 全局状态：flows 流、拦截、repeater 标签（Context + hooks）
├── intruder.ts / repeaterNav.ts  # Intruder 调度、Send-to-Repeater 精确导航
├── theme.css                 # 设计 token（CSS 变量，三套主题）+ 基础组件样式
├── views/
│   ├── ProxyView.tsx         # 流量表 + 检查器分栏（过滤/高亮/收藏/分享）
│   ├── InterceptView.tsx     # 请求/响应双向挂起队列与编辑
│   ├── RepeaterView.tsx      # 标签 + 编辑器 + 响应 + 历史
│   ├── IntruderView.tsx      # Positions / Payloads / Results
│   ├── SiteMapView.tsx       # 端点树 + Comparer
│   ├── ExtensionsView.tsx    # Match&Replace + 插件（编辑/样例/Skills）
│   ├── SharedTrafficView.tsx # 分享接收页（只读）
│   └── SettingsView.tsx      # 证书/运行/分享/远程实例
└── components/
    ├── FlowTable.tsx         # 虚拟滚动表格（新行高亮）
    ├── MessageViewer.tsx     # Headers/Params/Pretty/Hex/Raw/WS 帧子标签（含插件面板）
    ├── RawEditor.tsx         # CodeMirror raw 编辑（Intercept/Repeater/Intruder 复用）
    ├── FlowSnapshot.tsx      # 分享预览/接收共用的报文渲染
    ├── ShareDialog.tsx / SharingSettings.tsx
    ├── PluginPanel.tsx       # 沙箱 iframe 面板 + postMessage 桥
    ├── PluginSkills.tsx      # AI 技能查看/复制/下载
    └── codegen.ts / rawHighlight.tsx  # cURL/Go/Python 生成、raw 着色
```

- 状态流：`EventSource(/api/events)` → reducer → 视图；写操作走 REST 后以服务器事件回显为准（单一事实源在服务端）。
- 开发模式：`./dev.sh` 一键启动后端（8000）+ Vite（5175，`/api` 代理到 8000）热更新；生产：内嵌静态资源。

## 9. 测试策略

| 层 | 手段 |
| --- | --- |
| 证书 | CA/叶子证书生成、SAN、有效期单测 |
| 存储 | 增改查、过滤、JSONL 落盘重载单测 |
| 代理引擎 | 集成测试：`httptest` 上游（明文/TLS）+ 信任 Pulse CA 的客户端走代理，断言 Flow 完整性、改写生效 |
| 拦截 | 并发挂起 → API 修改 → Forward 断言上游收到修改后请求；Drop 断言客户端 502 |
| 101 隧道 | 原始字节回显服务器经 MITM 隧道双向断言 |
| API | handlers 表驱动测试（flows/搜索/repeater/intruder/分享存储/插件/扩展） |
| 插件 | R0–R3 分层测试：隔离与超时、SDK 契约、主动能力防递归、目录项目/面板/文件授权 |
| 前端 | `tsc --noEmit` + `vite build` + Playwright 脚本真实浏览器走查（`scripts/verify-*.py`，证据在 `docs/verification/`） |

## 10. 演进预留（与路线图对应）

已落地项不再列入：HTTP/2（下游 ALPN + 上游 `http2.Transport`，v0.3.0）与插件事件钩子（v0.3.7–v0.3.8）均已实现。当前预留：

- **协议**：Dialer 已收敛为单点，上游代理链（`CONNECT` 级联另一台代理）只改 `forward.go` 此层。
- **桌面壳**：Web UI 与 API 完全解耦（同源 REST+SSE），Tauri 封装只需把静态资源与二进制打包（[路线图](Product.md) 评估区）。
