# Pulse 技术架构文档

> 版本：v0.1.0 · 后端 Go 1.21+（纯标准库，零第三方依赖） · 前端 React 18 + TypeScript + Vite

## 1. 系统总览

Pulse 是单进程双监听的本地服务：

```
                    ┌─────────────────────────────────────────────────┐
                    │                  pulse (Go)                     │
 浏览器/客户端        │                                                 │   目标服务器
 ────────────┐      │  ┌────────────┐   ┌──────────┐   ┌───────────┐  │   ┌─────────┐
  代理流量    ├──────┼─▶│ Proxy :8080 ├──▶│ Intercept│──▶│  Dialer   ├──────┼─▶│ origin  │
 (HTTP/HTTPS)│      │  │  (MITM)    │   │ (队列/挂起)│   │ (TLS/明文) │  │   └─────────┘
             │      │  └─────┬──────┘   └──────────┘   └───────────┘  │
             │      │        │ flow                                    │
             │      │        ▼                                         │
             │      │  ┌────────────┐    SSE     ┌──────────────────┐  │
  控制台浏览器 ├──────┼─▶│ API/UI:8000│◀──────────│  React SPA       │  │
 (任意现代浏览器)│     │  │ REST + SSE │──────────▶│  (embedded/dist) │  │
             │      │  └─────┬──────┘           └──────────────────┘  │
             │      │        ▼                                         │
             │      │  ┌────────────┐   ┌──────────────┐              │
             │      │  │  Store     │──▶│ data dir     │              │
             │      │  │ (内存+JSONL)│   │ flows.jsonl  │              │
             │      │  └────────────┘   │ repeater.json│              │
             │      │                   │ ca.pem/key   │              │
             │      └───────────────────┴──────────────┴──────────────┘
```

- **Proxy 监听（默认 `127.0.0.1:8080`）**：接收代理协议流量（绝对形式请求 + `CONNECT` 隧道）。
- **UI/API 监听（默认 `127.0.0.1:8000`）**：REST API、SSE 事件流、生产模式下内嵌的 React 静态资源。
- 两个监听均默认只绑定回环地址（见安全模型 §6）。

## 2. 代码结构

```
pulse/
├── cmd/pulse/main.go        # 入口：装配 flags、logger、引擎、API，阻塞运行
├── internal/
│   ├── certs/certs.go       # CA 生成/加载、按主机叶子证书签发与缓存
│   ├── proxy/               # MITM 代理引擎
│   │   ├── engine.go        # 监听器、连接生命周期、HTTP/CONNECT 处理
│   │   ├── mitm.go          # TLS 拦截、逐请求解析与转发
│   │   ├── forward.go       # 上游拨号（TLS/明文）、逐字节往返、101 隧道
│   │   └── intercept.go     # 拦截队列：Hold/Forward/Drop，容量与降级
│   ├── store/store.go       # Flow 内存索引 + JSONL 追加日志，重启重放
│   ├── repeater/repeater.go # 重放标签持久化与执行
│   └── api/
│       ├── server.go        # 路由装配、静态资源、中间件
│       ├── flows.go         # /api/flows*
│       ├── intercept.go     # /api/intercept*
│       ├── repeater.go      # /api/repeater*
│       ├── events.go        # /api/events（SSE hub）
│       └── misc.go          # health/status/cert/settings
├── web/                     # React SPA（详见 §8）
├── docs/                    # 本文档集
└── go.mod                   # 无第三方依赖
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
        │ tls.Server(conn, GetCertificate=按 SNI/主机签叶子证书)
        ▼
      TLS(客户端↔Pulse)   ←—— 叶子证书由 Pulse CA 签发
        │ 循环 http.ReadRequest（origin-form）
        ▼
      handleRequest ── 拦截开启? ──▶ Intercept.Hold() ── 等待 Forward/Drop
        │
        ▼
      Dialer 拨号上游（TLS 或明文），逐字节转发请求，读响应
        ├─ 101 Switching Protocols ─▶ 双向原始隧道（WebSocket 等）
        └─ 普通响应 ─▶ 记录 Flow（请求先记、响应补记）→ 回写客户端
```

### 4.2 证书体系（internal/certs）
- 首次启动生成 **CA**：ECDSA P-256、CN=Pulse CA、10 年有效，落盘 `ca.pem`/`ca-key.pem`（私钥 0600）。
- **叶子证书**：按主机名懒生成，SAN=主机名（含 IP），24 小时有效，内存缓存（LRU 上限 1024，防内存膨胀）。
- 叶子证书生成由 `tls.Config.GetCertificate` 回调驱动，SNI 为空时回退 CONNECT 目标主机。

### 4.3 上游转发（internal/proxy/forward.go）
- 不使用 `http.Transport`，而是**手工拨号**（`net.Dial` → 可选 `tls.Client`），以便：
  1. `101 Upgrade` 后能拿到原始连接做双向隧道；
  2. 精确控制写出字节与超时；
  3. 上游 TLS 校验策略可注入（生产走系统根；测试注入测试 CA 池）。
- 逐跳头处理：剥离 `Proxy-Connection/Connection/Keep-Alive/Upgrade*` 等 hop-by-hop 头后按语义重建。
- 正文读取上限 `MaxBodySize = 10MB`，超限截断并置 `Truncated`。
- 超时：拨号 10s，响应头 30s，整体读 60s；错误以 `State=error` 记入 Flow。

### 4.4 拦截（internal/proxy/intercept.go)
- `Hold(ctx, req) (forwardReq, ok)`：生成队列项，`select` 等待 `action chan` 或连接断开。
- `Forward(id, modifiedReq)` / `Drop(id)` 由 API 调用；Drop 向客户端回 502。
- 队列容量 50：满时自动放行最旧项（可用性优先，绝不丢连接不响应）。

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
| 敏感数据落盘 | 全部数据仅在本地数据目录；产品路线图提供会话退出清空与加密项目文件 |

已知限制（v0.1）：
- 证书固定（certificate pinning）的客户端 App 无法解密，隧道会失败（与 Burp 行为一致）。
- HTTP/2 到上游会以 HTTP/1.1 协商（`ALPN http/1.1`）；HTTP/2 支持在路线图。
- 拦截仅支持请求阶段（响应拦截在路线图）。

## 7. 进程与运行

```
main.go
 ├─ flags: --proxy :8080 --ui :8000 --data-dir %USERPROFILE%/.pulse --open(否)
 ├─ certs.LoadOrCreateCA(dataDir)
 ├─ store.Open(dataDir/flows.jsonl)          # 重放日志恢复历史
 ├─ proxy.NewEngine(store, certs, events) → goroutine ListenAndServe
 ├─ repeater.Open(dataDir/repeater.json)
 └─ api.NewServer(...).ListenAndServe()      # 阻塞
```

- 优雅退出：收到 SIGINT/SIGTERM 后关闭监听、flush 存储。
- 生产静态资源：`//go:embed all:web/dist`，`/` 提供 SPA（index 兜底路由）。

## 8. 前端架构（web/）

```
web/src/
├── main.tsx / App.tsx        # 布局、标签路由（无 router 依赖，状态切换）
├── api.ts                    # fetch 封装 + SSE 订阅 + 类型定义（与 Go 模型一一对应）
├── state.ts                  # 全局状态：flows 流、拦截、repeater 标签（Context + hooks）
├── theme.css                 # 设计 token（CSS 变量）+ 基础组件样式
├── views/
│   ├── ProxyView.tsx         # 流量表 + 检查器分栏
│   ├── InterceptView.tsx     # 队列 + 请求编辑器
│   ├── RepeaterView.tsx      # 标签 + 编辑器 + 响应
│   └── SettingsView.tsx      # 证书/运行信息
└── components/
    ├── FlowTable.tsx         # 虚拟滚动表格（新行高亮）
    ├── MessageViewer.tsx     # Headers/Params/Pretty/Hex/Raw 子标签
    ├── RequestEditor.tsx     # 方法/URL/头/体编辑（Intercept 与 Repeater 复用）
    └── ...
```

- 状态流：`EventSource(/api/events)` → reducer → 视图；写操作走 REST 后以服务器事件回显为准（单一事实源在服务端）。
- 开发模式：`vite`（5173）代理 `/api` → `127.0.0.1:8000`，热更新；生产：内嵌静态资源。

## 9. 测试策略

| 层 | 手段 |
| --- | --- |
| 证书 | CA/叶子证书生成、SAN、有效期单测 |
| 存储 | 增改查、过滤、JSONL 落盘重载单测 |
| 代理引擎 | 集成测试：`httptest` 上游（明文/TLS）+ 信任 Pulse CA 的客户端走代理，断言 Flow 完整性、改写生效 |
| 拦截 | 并发挂起 → API 修改 → Forward 断言上游收到修改后请求；Drop 断言客户端 502 |
| 101 隧道 | 原始字节回显服务器经 MITM 隧道双向断言 |
| API | handlers 表驱动测试（列表/详情/SSE 事件/repeater 全链路） |
| 前端 | `tsc --noEmit` + `vite build` + 真实浏览器操作验证（核心流程走查） |

## 10. 演进预留（与路线图对应）
- **协议**：Dialer 已收敛为单点，HTTP/2(`http2.Transport`) 与上游代理链（`CONNECT` 级联）只改此层。
- **扩展点**：Engine 在「读请求后/写响应前」埋 event 点，未来插件按事件订阅（v0.5）。
- **桌面壳**：Web UI 与 API 完全解耦（同源 REST+SSE），Tauri 封装只需把静态资源与二进制打包。
