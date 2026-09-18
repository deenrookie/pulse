<div align="center">

# ⚡ Pulse

**通过浏览器操控的本地 Web 安全测试平台**

本地优先的轻量流量调试工作台：快速抓包、重放、分享必要证据，并用小型 JavaScript 插件适配业务流程，作为专业安全审计工具的日常补充。

[English](README.md) · [简体中文](README.zh-CN.md)

<img src="https://img.shields.io/badge/Go-1.25+-00ADD8?logo=go&logoColor=white" alt="Go 1.25+"/>
<img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white" alt="React 18"/>
<img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="platform"/>
<img src="https://img.shields.io/badge/%E5%8D%95%E4%BA%8C%E8%BF%9B%E5%88%B6-%E9%9B%B6%E8%BF%90%E8%A1%8C%E6%97%B6%E4%BE%9D%E8%B5%96-8A2BE2" alt="single binary"/>

[快速开始](#-快速开始) · [核心能力](#-核心能力) · [插件系统](#-插件系统) · [文档](#-文档)

</div>

---

## 📸 核心界面

**Live Traffic** —— 实时 MITM 抓包：虚拟化流量表格（5000 行流畅滚动）、多维过滤与高亮、右键联动 Repeater / cURL，检查器内 Headers / Params / Pretty / Hex / WebSocket 逐帧查看：

<div align="center"><img src="docs/screenshots/proxy.png" alt="Pulse Live Traffic — MITM 抓包与流量检查" width="880"/></div>

**Repeater** —— Burp 式 raw 重放编辑器：请求行 + 头 + 体单缓冲区改包，`Ctrl+Enter` 即改即发，响应实时渲染，标签自动保存：

<div align="center"><img src="docs/screenshots/repeater.png" alt="Pulse Repeater — raw 编辑与重放" width="880"/></div>

> 内置 **Linear（默认）/ Warm 炭灰 / Midnight 午夜** 三套主题，全程离线本地运行，流量不出你的机器。

## ✨ 核心能力

| 模块 | 能力 |
| --- | --- |
| **Proxy** | HTTP/HTTPS MITM 抓包，SSE 实时**虚拟化**表格（5000 行、列宽拖拽、列头排序），多维过滤 + 高级过滤器 + 8 色高亮规则，gzip/br 自动解压，JSONL 持久化重启恢复，**★ 收藏与备注**（仅看收藏过滤），右键 Send to Repeater / Copy as cURL / 深链接直达；**Scope 目标范围**（右键加入 host，一键只看目标流量，规则含子域，站点地图盾牌标记）；**全局深搜**（`Ctrl+Shift+F`，覆盖 traffic + repeater 的请求与响应）；**HAR 导出** |
| **Intercept** | 请求挂起队列，改方法/URL/头/体后放行或丢弃，`F` / `D` 快捷操作；**响应拦截**（回包到达客户端前挂起） |
| **Intruder** | Burp 式批量模糊测试：raw 模板中用 `§…§` 标记位置 + 载荷列表，逐发比对状态/长度/耗时，基线偏差高亮、**Grep 命中列**、单集 & **Pitchfork 每位置载荷集**模式、响应检查器（`Ctrl+7`，流量右键 Send to Intruder） |
| **Site Map** | host→path→method 端点树聚合（状态着色、搜索），端点级**状态变体**分组（200·12 / 500·2），点击检查最新请求/响应；页脚 **Comparer** 工具比对任意两段 raw |
| **Repeater** | raw 编辑器改包重发，标签持久化/搜索/标记，响应即查，**与上次响应 Diff**（字级高亮）；**Params 标签可编辑**直写回 raw |
| **Extensions** | **Match & Replace**（5 作用域、正则/字面量、命中计数）；**JS 插件**（onRequest/onResponse 钩子，隔离 VM + 超时，热加载，日志面板，**CodeMirror 在线编辑器**：Check 干跑校验 / 沙箱 Test run / 一键写入插件目录，**插件目录可配置**，内置样例代码）；**SDK**（`pulse.headers/url/query/cookies/body/encoding/crypto`，`ctx.state` + 内存/持久存储，配置表单且 secret 不回显）；**主动插件**（`pulse.http.send` 异步请求带超时/防递归，`ctx.respond`/`ctx.drop`，`onComplete`，Mock 网络测试模式，右键 Actions，Repeater *Apply plugin*）；**目录项目**（`pulse.plugin.json` 清单、SDK `.d.ts` + CLI `plugins check/test`、沙箱 UI 面板、授权 `pulse.files` 访问） |
| **WebSocket** | RFC 6455 帧级捕获：text/binary/close/ping/pong 双向记录，检查器内专页查看 |
| **Settings** | CA 证书下载与各平台安装指引、**运行时代理地址热重绑**、内存防护、运行状态、快捷键速查 |

请求管线顺序：`插件 → 重写规则 → 拦截 → 上游`；存储的流量始终是实际发送/接收的最终形态。Repeater 发送不经插件与重写（与 Burp 默认一致）。

## 🚀 快速开始

**免构建** — 从 [Releases](https://github.com/deenrookie/pulse/releases) 一行命令下载运行（单文件、零运行时依赖）：

```bash
# macOS（Apple Silicon）
curl -L https://github.com/deenrookie/pulse/releases/download/v0.3.9/pulse_0.3.9_darwin_arm64.tar.gz | tar xz && chmod +x pulse && ./pulse

# Linux（x64）
curl -L https://github.com/deenrookie/pulse/releases/download/v0.3.9/pulse_0.3.9_linux_amd64.tar.gz | tar xz && chmod +x pulse && ./pulse
```

```powershell
# Windows（x64）— PowerShell
curl.exe -L -o pulse.zip https://github.com/deenrookie/pulse/releases/download/v0.3.9/pulse_0.3.9_windows_amd64.zip
Expand-Archive pulse.zip -Force; .\pulse.exe
```

压缩包内含 `pulse`（内嵌 Web UI 的二进制）和 `README.md`；升级版本时替换 URL 中的版本号即可。

或者从源码构建：

前置：Go 1.25+，Node 18+（仅构建前端需要）。

```bash
# 构建单一二进制（前端产物内嵌）
cd web && npm install && npm run build && cd ..
go build -o pulse.exe ./cmd/pulse        # Linux/macOS: -o pulse

# 运行：代理 127.0.0.1:8080，控制台 127.0.0.1:8787
./pulse.exe
# 自定义：--proxy :9090 --ui :9000 --data-dir D:/pulse-data
```

打开控制台 <http://127.0.0.1:8787>。同一构建也托管在 <https://pulsesec.vercel.app/>（经 CORS 驱动本地实例）。

### 远程 / 托管面板访问

控制台默认只监听回环地址。通过托管面板（或局域网其他机器）操控时：

1. UI 绑定可达地址启动：`pulse --ui 0.0.0.0:8787`
2. 固定或查看访问密钥：`PULSE_KEY=... pulse ...`（不指定则随机生成并打印在启动日志；回环访问无需密钥）
3. 托管面板打开 **Settings → Remote instance**，填实例地址（如 `http://192.168.1.5:8787`）与密钥（仅存该浏览器 localStorage）

非回环 API 调用必须带密钥（`X-Pulse-Key` 头，或 SSE 流的 `?key=`）。

> **Chrome 局域网权限** —— HTTPS 页面（如托管面板）需授予 *local network access* 权限后才能访问 `127.0.0.1` / 局域网服务：点击地址栏左侧 🔒 → **Site settings** → **Local network access** → **Allow** 后刷新。直接打开 <http://127.0.0.1:8787> 则无需该权限。

### 抓取 HTTPS（一次性）

1. Settings 页下载 CA 证书（`pulse-ca.pem`）。
2. 安装到信任库：
   - **Windows**：`certmgr.msc` → 受信任的根证书颁发机构 → 导入（或 `certutil -addstore -user root pulse-ca.pem`）。
   - **macOS**：钥匙串访问 → 系统 → 导入 → 双击设为“始终信任”。
   - **Firefox**：设置 → 隐私与安全 → 证书 → 导入 → 勾选信任 CA。
3. 浏览器代理指向 `127.0.0.1:8080`（可配 SwitchyOmega），访问任意站点即出现在流量表。

> 仅在测试环境信任 Pulse CA，测试结束建议移除。Pulse 永远不会自动修改你的系统信任库。

<details>
<summary><b>架构</b></summary>

```
┌────────────┐  代理流量(HTTP/HTTPS)   ┌─────────────┐   ┌──────────┐
│ 浏览器/客户端 ├──────────────────────▶│ Pulse :8080 ├──▶│ 目标服务器 │
└────────────┘                        │  (MITM 引擎) │   └──────────┘
┌────────────┐   REST + SSE (控制)    │             │
│ 控制台浏览器  ├──────────────────────▶│ Pulse :8787 │
└────────────┘                        └─────────────┘
```

- 后端：Go（标准库 + goja JS 运行时，单二进制内嵌前端）
- 前端：React + TypeScript + CodeMirror 6（构建产物内嵌，运行时零外部依赖、零网络请求）

</details>

<details>
<summary><b>开发模式</b></summary>

```bash
# 一键开发环境（macOS / Linux / Git Bash）：后端 + Vite 热更新，Ctrl+C 一并停止
./dev.sh                     # 控制台 http://127.0.0.1:5175，代理 :8080
PROXY_PORT=9090 ./dev.sh     # 换代理端口

# 或手动分开跑：
# 终端 1：后端
go run ./cmd/pulse
# 终端 2：前端（热更新，/api 代理到 8000）
cd web && npm run dev    # http://127.0.0.1:5175
```

</details>

## 🧩 插件系统

**流量分享（v0.3.9）**：Live Traffic → **Share**、Repeater → **Share exchange** 分享完整捕获请求和响应，地址使用 **Settings → Temporary sharing** 的 IP。接收页面左右高亮 Raw、搜索、右键 cURL/Python、完整 JSON 下载；分享层不脱敏、不裁剪正文、不限制条数或容量。默认 7 天、最长 1 年，持久化后重启仍有效，可主动撤销。局域网需以可达 UI 地址启动，例如 `--ui 0.0.0.0:8787`。验证证据见 [docs/verification/](docs/verification/)。

**Intruder** 提供 Positions / Payloads / Results 分页、Sniper / Battering ram / Pitchfork、位置按钮、载荷文件导入、结果排序搜索、解码后 Grep 和左右请求/响应检查。默认打开最新记录并恢复上次结果；请求首行列表支持快速删除和右键操作。停止会等待当前请求结束，不再发出后续请求。

**Extensions → Plugins → Skills** 提供可复制的 `SKILL.md` 和完整插件开发包（模板、夹具、SDK 类型、Python 沙箱断言脚本），方便 AI 编写并调试插件。将下载的 `pulse-plugin-dev` 放到 AI 工具的 skills 目录后重新加载，或直接粘贴说明。Pulse 不连接任何 AI 云服务。

放在插件目录下的 JavaScript 文件（ES5.1+，goja 运行时），可观察并修改经过代理的每一个请求与响应——无需安装任何东西：

```js
plugin = { name: "Add Header", version: "1.0" };

function onRequest(ctx) {
  ctx.request.headers.push({ name: "X-Powered-By", value: "pulse" });
  pulse.log("tagged " + ctx.request.url);
}
```

控制台内置在线编辑器：**Check** 干跑编译（错误精确到行列）、**Test run** 沙箱试跑（零流量，可从捕获 Flow 导入夹具）、草稿自动保存，坏源码不落盘生效——上一个有效修订继续运行，插件目录可随时在界面上更换。

更完整的 SDK：报文助手（`pulse.headers/url/query/cookies/body`）、编码与 SHA-256/HMAC、按事务 `ctx.state`、跨请求内存 + 持久存储、`plugin.config` 配置表单（secret 不回显）、异步 `pulse.http.send`（记录为 `source: plugin`，防递归）、`ctx.respond`/`ctx.drop`、`onComplete` 分析、Mock 网络测试模式、右键 Actions、Repeater *Apply plugin*；大型插件可组织为**目录项目**（`pulse.plugin.json` 清单、SDK `.d.ts` + `pulse plugins check/test` CLI、沙箱 UI 面板、授权 `pulse.files` 目录访问）。详见[插件开发指南](docs/Plugins.md)（[English](docs/Plugins.en.md)）。

## 📚 文档

- [产品文档](docs/Product.md)：定位、范围、**路线图**（已实现 / 规划评估 / 明确不做）
- [技术架构](docs/Architecture.md)：模块、数据流、管线顺序、安全模型、测试策略
- [API 参考](docs/API.md)：REST + SSE 接口规范
- [插件开发指南](docs/Plugins.md)（[English](docs/Plugins.en.md)）：JS 插件 API、示例、安全模型
- [验证证据](docs/verification/)：各轮交付的测试运行、截图与 UI 走查结果

## 🧪 测试

```bash
go test ./...                            # 引擎/拦截/隧道/存储/API/插件 全量
cd web && npx tsc --noEmit && npm run build
```

## 📁 目录

```
cmd/pulse          入口
internal/          certs | proxy | store | repeater | rewrite | plugins | api
web/               React SPA（CodeMirror 在线插件编辑器）
examples/plugins/  示例插件（Samples 标签内同款，可一键载入）
docs/              文档与截图
```

## 📄 许可

未定（交付评估中）。

---

<div align="center">

**Pulse** — 为安全工程师打造的本地抓包重放工具

⭐ 如果对你有帮助，欢迎 Star 关注进展

</div>
