# Pulse

**通过浏览器操控的本地 Web 安全测试平台** —— 对标 Burp Suite / Caido 核心工作流的 MITM 抓包、拦截改包、重放、重写与插件扩展工具。

- 后端：Go（标准库 + goja JS 运行时，单二进制）
- 前端：React + TypeScript（构建产物内嵌进二进制）

```
┌────────────┐  代理流量(HTTP/HTTPS)   ┌─────────────┐   ┌──────────┐
│ 浏览器/客户端 ├──────────────────────▶│ Pulse :8080 ├──▶│ 目标服务器 │
└────────────┘                        │  (MITM 引擎) │   └──────────┘
┌────────────┐   REST + SSE (控制)    │             │
│ 控制台浏览器  ├──────────────────────▶│ Pulse :8000 │
└────────────┘                        └─────────────┘
```

## 功能（v0.3）

v0.3 对控制台做了整体重设计（对标 Caido 的工作台形态）并强化了流量表格，后端引擎与 API 不变。截图见 `gui-test-screenshots/redesign/`。

| 模块 | 能力 |
| --- | --- |
| **Shell** | 左侧图标导航栏（可折叠、徽章计数、连接状态、**双主题切换**：Warm 炭灰终端 / Midnight 午夜青柠，取自 awesome-design-md 的 Warp 与 Sentry 体系），顶栏全局 Intercept 开关与监听地址，`#/view` 直达路由，`Ctrl+1..5` 切换视图、`Ctrl+F` 聚焦过滤 |
| **WebSocket** | RFC 6455 帧级捕获：升级握手后透明转发并解析帧，text/binary/close/ping/pong 消息双向记录（64KB/条、1000 条上限，节流持久化+实时推送），检查器内 WebSocket 标签页查看；gzip/deflate/br 响应体自动解压展示 |
| **Proxy** | HTTP/HTTPS MITM 抓包，实时（SSE）**虚拟化**流量表格（5000 行流畅滚动、点击列头排序、**列宽可拖拽**），多维过滤（关键字、状态码分类、HTTP 方法、隐藏静态 + **高级过滤器**：字段×正则×反向排除、按类型隐藏、响应体大小范围），**高亮规则**（命中行着色，8 色），正文完整检查（Headers/Params/Pretty/Hex/Raw、图片预览、JSON 美化），JSONL 持久化重启恢复，**右键菜单**（Send to Repeater / Copy as cURL / 复制链接直达 / 浏览器查看响应 / 删除），表格/检查器分割可拖拽调整，`#/proxy?flow=` 深链接 |
| **Intercept** | 请求挂起队列，改方法/URL/头/体后放行或丢弃（502），键盘 `F`/`D` 快捷操作 |
| **Site Map** | 全部捕获端点聚合为 host→path→method 树（状态着色、计数、搜索、`Ctrl+6`），点击叶子检查最新请求/响应，右键联动 Repeater / Live Traffic |
| **Repeater** | 历史流量一键送入重放标签（持久化），**Burp 式 raw 编辑器**（请求行+头+体单缓冲区），空白标签一键新建，改包重发（`Ctrl+Enter`），标签搜索/标记/快速删除，响应即查 |
| **Extensions** | **Match & Replace**（5 作用域、正则/字面量、命中计数、持久化）；**JS 插件**（onRequest/onResponse 钩子，隔离 VM + 超时保护，热重载，日志面板；**插件目录可配置**，**在线编辑器**写入/Check 校验/沙箱 Test run，内置 **Samples** 样例代码） |
| **Settings** | CA 证书下载与各平台安装指引、运行状态与指纹、快捷键速查 |

WebSocket 已支持帧级捕获（非 WebSocket 的其他 Upgrade 协议仍为透明隧道）。
请求管线顺序：`插件 → 重写规则 → 拦截 → 上游`；存储的流量始终是实际发送/接收的最终形态。

## 快速开始

### 构建

前置：Go 1.21+、Node 18+。

```bash
# 前端
cd web && npm install && npm run build     # 产物 web/dist（内嵌进 Go）

# 后端
cd .. && go build -o pulse.exe ./cmd/pulse   # Linux/macOS: -o pulse
```

### 运行

```bash
./pulse.exe            # 代理 127.0.0.1:8080，控制台 127.0.0.1:8000
./pulse.exe --proxy :9090 --ui :9000 --data-dir D:/pulse-data
```

打开控制台 <http://127.0.0.1:8000>。

### 抓取 HTTPS（一次性）

1. Settings 页下载 CA 证书（`pulse-ca.pem`）。
2. 安装到信任库：
   - **Windows**：Win+R → `certmgr.msc` → 受信任的根证书颁发机构 → 导入 `pulse-ca.pem`（或 `certutil -addstore -user root pulse-ca.pem`）。
   - **macOS**：钥匙串访问 → 系统 → 导入 → 双击设为"始终信任"。
   - **Firefox**：设置 → 隐私与安全 → 证书 → 导入 → 勾选信任 CA。
3. 浏览器代理指向 `127.0.0.1:8080`（可配 SwitchyOmega 等插件），访问任意站点即出现在 Proxy 历史。

> 仅在测试环境信任 Pulse CA；测试结束建议移除。Pulse 永远不会自动修改你的系统信任库。

### 开发模式

```bash
# 终端 1：后端
go run ./cmd/pulse
# 终端 2：前端（热更新，/api 代理到 8000）
cd web && npm run dev    # http://127.0.0.1:5173
```

## 测试

```bash
go test ./...            # 引擎/拦截/隧道/存储/API 全量
cd web && npx tsc --noEmit && npm run build
```

## 文档

- [产品文档](docs/Product.md)：定位、竞品对比、范围、路线图
- [技术架构](docs/Architecture.md)：模块、数据流、管线顺序、安全模型、测试策略
- [API 参考](docs/API.md)：REST + SSE 接口规范
- [插件开发指南](docs/Plugins.md)：JS 插件 API、示例、安全模型

## 目录

```
cmd/pulse          入口
internal/          certs | proxy | store | repeater | rewrite | plugins | api
web/               React SPA
examples/plugins/  示例插件（复制到 <数据目录>/plugins/ 即可用）
docs/              文档
```

## 许可

未定（交付评估中）。
