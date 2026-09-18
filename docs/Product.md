# Pulse 产品定位

Pulse 是本地优先的轻量网络调试工作台：**快速抓到问题、复现请求、分享必要证据，用小插件适配业务流程**。

产品采用 Go 单二进制和 React 浏览器界面，面向需要随时抓包、联调和验证请求的开发者、安全工程师。保留熟悉的 Proxy / Intercept / Repeater 操作习惯，作为 Burp 等专业审计工具的日常补充。

## 核心工作流

1. 启动二进制，打开默认 `http://127.0.0.1:8787`，把客户端代理指向 `127.0.0.1:8080`。
2. Live Traffic 实时捕获，使用过滤、Scope、搜索和标注聚焦问题。
3. 检查报文并 Send to Repeater，修改、重放、比较；必要时使用 Intercept 和 Match & Replace。
4. 需要同事查看时，配置 Settings → Temporary sharing 的 IP，再从 Live Traffic 或 Repeater 创建完整、有时限、可搜索和复制代码的只读分享。
5. 特定业务规则通过 Extensions → Plugins 完成；Skills 页提供 AI 开发说明、模板与沙箱测试工具。

## 已有能力

HTTP/HTTPS MITM、HTTP/2 上游、WebSocket 帧捕获、双向拦截、持久化重放、Intruder、Site Map、HAR、主题与快捷键、JS/goja SDK、配置与状态、Mock HTTP、手动 Actions、目录插件、隔离 UI 面板和授权文件访问。能力详情以 [README](../README.zh-CN.md)、[API](API.md) 和 [Plugins](Plugins.md) 为准。

## 产品约束

- 单二进制、现有依赖优先，避免为小需求搭建平台。
- 本地流量默认不外传；分享由用户选择，并明确显示内容、有效期和撤销边界。
- 界面以信息清楚、数据稳定和错误可恢复为先，支持键盘和减少动态效果。
- 不把主动漏洞扫描器、云端账户协作或全面替代 Burp 作为当前目标。
- 当前仓库没有 Tauri/Rust 工程；应用运行验证指本机二进制与真实浏览器。跨平台编译不能冒充 Windows 实机验证。

## 本轮优化与验收

见 [2026-09 优化方案](Optimization-2026-09.md)：说明现有代码依据、交付范围、优先级、容量限制与后续升级条件。实际检查结果与未验证范围记录在 [验证记录](Verification.md)。
