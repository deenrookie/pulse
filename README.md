# Pulse

**通过浏览器操控的本地 Web 安全测试平台** —— 对标 Burp Suite / Caido 核心工作流的 MITM 抓包、拦截改包、重放工具。

- 后端：Go（纯标准库，零第三方依赖，单二进制）
- 前端：React + TypeScript（构建产物内嵌进二进制）

```
┌────────────┐  代理流量(HTTP/HTTPS)   ┌─────────────┐   ┌──────────┐
│ 浏览器/客户端 ├──────────────────────▶│ Pulse :8080 ├──▶│ 目标服务器 │
└────────────┘                        │  (MITM 引擎) │   └──────────┘
┌────────────┐   REST + SSE (控制)    │             │
│ 控制台浏览器  ├──────────────────────▶│ Pulse :8000 │
└────────────┘                        └─────────────┘
```

## 功能（v0.1 MVP）

| 模块 | 能力 |
| --- | --- |
| **Proxy** | HTTP/HTTPS MITM 抓包，实时（SSE）流量表格，关键字过滤，正文完整检查（Headers/Params/Pretty/Hex），JSONL 持久化重启恢复 |
| **Intercept** | 请求挂起队列，改方法/URL/头/体后放行或丢弃（502） |
| **Repeater** | 历史流量一键送入重放标签（持久化），改包重发，响应即查 |
| **Settings** | CA 证书下载与各平台安装指引、运行状态与指纹 |

WebSocket 等升级流量以透明隧道转发（握手后逐字节双向透传）。

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
- [技术架构](docs/Architecture.md)：模块、数据流、安全模型、测试策略
- [API 参考](docs/API.md)：REST + SSE 接口规范

## 目录

```
cmd/pulse     入口
internal/     certs | proxy | store | repeater | api
web/          React SPA
docs/         文档
```

## 许可

未定（交付评估中）。
