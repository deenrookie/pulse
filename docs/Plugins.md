# Pulse 插件开发指南

Pulse 插件是一个放在数据目录 `plugins/` 下的 **JavaScript 文件**（ES5.1+，由内嵌的 [goja](https://github.com/dop251/goja) 运行时执行，无需安装任何东西）。插件可以观察并修改经过代理的每一个请求和响应。

## 快速开始

1. 把 `examples/plugins/` 里的示例复制到你的插件目录（Settings → Runtime 可见数据目录；Extensions → Plugins 面板也直接显示插件目录路径）。
2. 打开 **Extensions → Plugins → Reload**。
3. 浏览器经代理访问任意站点，插件立即生效。

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

仓库 `examples/plugins/`：

| 文件 | 作用 |
| --- | --- |
| `add-header.js` | 为所有请求注入自定义头，并演示 `pulse.log` |
| `redact-tokens.js` | 响应中的 Bearer token / API key 打码（正则） |

## 路线图

- `pulse.fetch(url, options)` —— 插件内发起 HTTP 请求
- 脚本化 UI 面板（自定义 tab）
- 按作用域（scope）过滤钩子触发
