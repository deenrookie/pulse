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

1. **写时**：`Check` 干跑编译，语法错误精确到 `行:列`；能立即看到钩子是否被识别（`hooks: request, response`）。
2. **改前**：`Test run` 用自定义夹具试跑 —— 看日志（`pulse.log`）、看修改后的报文、看抛错，全程零流量，不会污染真实请求。
3. **运行中**：
   - 加载错误（语法/顶层抛错）显示在插件卡片的红色错误条上；
   - 钩子内运行时抛错只影响当次调用，错误与 `pulse.log` 输出实时显示在插件卡片（面板每 4 秒刷新）；
   - 每次钩子执行都有 2 秒超时，死循环不会拖垮代理。
4. **禁用即止血**：插件卡片上的开关可立即停用某个插件，不影响其他插件。

## 运行规则（与安全）

- **执行顺序**：`onRequest` 钩子按文件名顺序执行 → Match & Replace 规则 → Intercept（你在拦截面板里看到的是最终形态）→ 上游。响应方向：`onResponse` → 响应规则 → 客户端。
- **隔离**：每次钩子调用都在**全新的 VM** 中执行，插件之间、请求之间不共享状态（闭包变量每次都是新的）。
- **超时**：单次钩子执行上限 **2 秒**，超时自动中断；死循环不会拖垮代理。
- **错误隔离**：语法错误在加载时记录到插件状态；运行时抛错只影响当次调用，其余插件与代理流程不受影响。错误显示在 Plugins 面板。
- **性能**：每个请求都会实例化 VM 并重新执行插件顶层代码。顶层应只做函数定义，不要放重计算。
- **能力边界**：无网络、无文件系统、无计时器——纯数据变换。需要发请求的插件能力在路线图（v0.5 将提供 `pulse.fetch`）。

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
