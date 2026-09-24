# Pulse 产品定位与路线图

Pulse 是本地优先的轻量网络调试工作台：**快速抓到问题、复现请求、分享必要证据，用小插件适配业务流程**。

产品采用 Go 单二进制和 React 浏览器界面，面向需要随时抓包、联调和验证请求的开发者、安全工程师。保留熟悉的 Proxy / Intercept / Repeater 操作习惯，作为 Burp 等专业审计工具的日常补充。

## 核心工作流

1. 启动二进制，打开默认 `http://127.0.0.1:8787`，把客户端代理指向 `127.0.0.1:8080`。
2. Live Traffic 实时捕获，使用过滤、Scope、搜索和标注聚焦问题。
3. 检查报文并 Send to Repeater，修改、重放、比较；必要时使用 Intercept 和 Match & Replace；批量验证用 Intruder。
4. 需要同事查看时，配置 Settings → Temporary sharing 的 IP，再从 Live Traffic 或 Repeater 创建完整、有时限、可搜索和复制代码的只读分享。
5. 特定业务规则通过 Extensions → Plugins 完成；Skills 页提供 AI 开发说明、模板与沙箱测试工具。

## 路线图

以下状态以实际代码与已发布版本为准，不保留「计划中」的过期表述；一项能力发布后即从规划区移入已实现区。

### 已实现（按发布版本）

| 能力 | 版本 | 说明 |
| --- | --- | --- |
| HTTP/HTTPS MITM、双向拦截（请求+响应）、WebSocket 帧捕获 | ≤ v0.3.0 | 响应拦截与 WS 帧查看均已上线，不再是路线图项 |
| **HTTP/2**：下游 ALPN MITM + 上游 h2（失败自动回退 HTTP/1.1） | v0.3.0 | 见 `internal/proxy/engine.go`（`h2` ALPN）与 `forward.go`（`http2.Transport`） |
| Site Map、Comparer、HAR 导出 | v0.3.0 | 端点树聚合、状态变体、raw 比对工具 |
| Lean 省内存模式（binary/static/JS 响应体打桩） | v0.3.6 | 开启前二次确认；请求行、状态与头保留 |
| JS 插件平台 R0–R3 全量 | v0.3.7 / v0.3.8 | 隔离 VM、pulse SDK、`pulse.http.send` 主动请求、`ctx.respond/drop`、Mock 测试、Actions、目录项目、沙箱 UI 面板、`pulse.files` 授权访问、SDK `.d.ts` + CLI |
| 插件流量高亮 `ctx.highlight` + CORS 检测示例插件 + 插件日志控制台拖拽调高 | v0.3.11 | 任意钩子把当前 Flow 标成白名单 10 色（持久化 + SSE，优先于用户高亮规则）；`cors-check.js` 被动分析 + 攻击者 Origin 无凭证主动验证并打印可窃取数据、漏洞流量标红 |
| 生成 CSRF PoC（表单 / XHR 双技术、请求可编辑重生成、浏览器实测） | v0.3.10 | 对齐 Burp Engagement tools；Live Traffic 与 Repeater 四处右键入口 |
| 临时流量分享（完整快照、持久化、可撤销） | v0.3.9 | 默认 7 天最长 1 年；无条数/容量配额；不脱敏不裁剪 |
| Intruder（Sniper / Battering ram / Pitchfork、结果持久化） | v0.3.9 | Positions / Payloads / Results 分页，解码后 Grep |
| 深搜（traffic + repeater 全文检索） | v0.3.3 | `Ctrl+Shift+F`，命中可右键送 Repeater |
| 插件 AI 开发技能（pulse-plugin-dev kit 内嵌可下载） | v0.3.9 | SKILL.md、模板、夹具、SDK 类型、Python 沙箱断言脚本 |
| ★收藏与备注、代码生成（Go/Python/JS） | 已随各版本累积 | 以 README 功能表为准 |

> 历史设计文档（JS 插件设计方案、2026-09 首轮优化方案）在全部落地后已删除；交付验证证据保存在 [docs/verification/](verification/)。

### 规划评估中（有明确触发条件才启动）

| 方向 | 触发条件 |
| --- | --- |
| Intruder：Cluster bomb 模式、并行发送、暂停恢复 | 用户实际跑过多集合组合场景且串行太慢 |
| 多条请求组成一次分享证据包 | 单条快照不足以表达问题的真实反馈出现 |
| 插件 WebSocket 帧级钩子、流式/SSE/gRPC 改写 | 对应协议的真实业务任务与协议级证据 |
| 插件通用定时任务、跨插件服务调用 | 出现具体编排场景，而非「平台感」推理 |
| 插件 CLI 断言增强 / CI 集成 | 用户确需不启动实例的完整断言流水线 |
| 会话退出清空与项目文件加密 | 敏感数据落盘防护的实际需求 |
| 桌面壳（Tauri 封装） | Web UI 与 API 已解耦，封装成本低；待用户明确提出 |

### 明确不做

- 主动漏洞扫描器、全面替代 Burp 的审计项目。
- 云端账户、实时协作、工作区（分享是用户显式选择的本地行为，不演变为云中转）。
- 插件市场、云端插件执行。
- 完整 Node.js 兼容运行时（goja + ES5.1 + 打包纯 JS 依赖已覆盖现有场景）。

## 产品约束

- 单二进制、现有依赖优先，避免为小需求搭建平台。
- 本地流量默认不外传；分享由用户选择，并明确显示内容、有效期和撤销边界。
- 界面以信息清楚、数据稳定和错误可恢复为先，支持键盘和减少动态效果。
- 当前仓库没有 Tauri/Rust 工程；应用运行验证指本机二进制与真实浏览器。跨平台编译不能冒充 Windows 实机验证。
