# 完整分享与 Intruder 优化：交付验证

日期：2026-09-16。环境：macOS arm64、Go 1.26.1、Node 20、Google Chrome 有窗口模式。工作区基于 e223756 加首轮未提交修改继续实现；未提交、推送或发布。

## 需求到产物的完成审计

| 用户要求 | 产物与行为 | 实际证据 |
| --- | --- | --- |
| Live Traffic 可以分享 | 工具栏 Share，流量行右键 Share complete traffic | Go API 完整快照测试、Chrome 分享/下载全量比对 |
| Repeater 可以分享 | Share exchange、标签右键 Share last exchange；选定历史请求与响应配对 | TestRepeaterSharePairsSentRequest；Chrome 选前一次响应并验证请求/响应均属 first |
| 完整 request / response，不过滤数据 | shareSnapshot 直接保存 Flow；删除脱敏/正文开关/额外截断 | 原 URL 用户信息/查询/fragment、认证、Cookie、重复头、0x00/0xff 正文、错误、WebSocket 均做完整结构比较 |
| Raw 风格、高亮、左右展示 | FlowSnapshot 复用 RawView；request 左、response 右；Raw/Hex | shared.png、intruder-results.png；DOM 高亮与两侧位置断言 |
| 右键、cURL、Python 等复制 | 两侧右键含 cURL/Python、URL、原始报文/头/体/选择文本 | Chrome 从剪贴板取出代码并实际运行；上游验证二进制正文和两个同名头均保留 |
| 搜索 | 两侧各自 Raw 搜索及命中跳转，完整内容搜索 | 匹配 response needle；220k 字符后的 needle-at-end 仍可找到 |
| 更长的过期时间 | 默认 7 天，1 小时/1 天/7/30/90 天/1 年；API 1..525600 分钟 | API 一年时间验证；UI 选择一年；实际 90 天分享跨进程重启后 JSON 完全相同 |
| 分享数量没有限制 | 移除 32 条、2 MiB/条、16 MiB 合计配额；磁盘文件保存完整载荷，内存仅索引元数据 | 40+ 分享创建；3 MiB 正文完整比对；无 maxShares/maxShareBytes 代码；无运行依赖增加 |
| Intruder 更接近 Burp | Positions / Payloads / Results；Sniper、Battering ram、Pitchfork；位置增删清除；载荷文件导入、去重；排序/搜索/基线；左右报文、右键重放分享复制 | 实际上游记录 Sniper 4 种、Battering ram 2 种、Pitchfork 2 种请求组合，均与期望完全相同 |
| 测试后交付 | 全量 Go race、vet、TypeScript/生产构建、本机编译应用真实操作 | 下方命令及 verification/r2 下原始结果 |

## 实现要点

分享目录位于数据目录 shares/。每份包含 metadata.json 和 snapshot.json，先写入临时目录、Sync，再 rename 发布，失败不返回可用 URL。文件权限 0600、目录 0700。保存全部 Flow 数据，接收者的 JSON 下载不经过文本解码。公开路由只提供该 token 的查看和下载，管理 API 仍需要原有权限。页面将不可信报文按文本渲染，CSP 不允许内联脚本。

长有效期需要持久化：重启恢复未过期索引；到期由每次读取检查，后续读取/管理列表/创建/启动会回收过期文件。撤销从磁盘删除成功后才移除索引；失败明确报告。不设应用层数量/容量配额，但仍受本机磁盘可用空间影响。

Repeater 每次历史新增对应 Request，避免将未发送的编辑器内容与旧 Response 混合分享。新增字段向后兼容；旧记录缺少原始 Request 时要求重新发送。已有最近 20 次历史上限不变，已经创建的分享独立保存。

Intruder 沿用浏览器顺序调度，无后台任务框架：Sniper 一次替换一个位置，Battering ram 同时替换所有位置，Pitchfork 逐组同步推进，短集合耗尽时停止。正文 Grep 解 base64 并解压 gzip/deflate/br 后匹配；字节长度按实际 base64 解码长度统计。Host 决定主机，Target URL 保留 HTTP/HTTPS。运行中配置/删除/保存锁定；Stop 完成当前请求后停队列，离开页面也停后续发送。草稿浏览器保存，显式 Save 原子写盘；存储失败回滚。

## 已执行验证

- `go test -race ./...`：全部通过，见 [Go 输出](verification/r2/go-test-race.txt)。新测试覆盖完整数据、原流量不变、撤销、鉴权、无旧容量配额、长期限、磁盘错误、重启/到期、Repeater 配对和 Intruder 保存回滚。
- `go vet ./...`：通过。
- `cd web && npm run build`：TypeScript 与生产构建通过；[构建输出](verification/r2/frontend-build.txt)。JS 806.33 kB / gzip 262.37 kB，CSS 72.02 kB / gzip 13.23 kB。现有单 chunk >500 kB 提示仍在，未新增 npm/Go 运行依赖。
- `go build -o /tmp/pulse-r2-verification/pulse ./cmd/pulse`：通过，该二进制在 8000 实际运行。
- `GOOS=windows GOARCH=amd64 go build -o /tmp/pulse-r2-verification/pulse-windows-amd64.exe ./cmd/pulse`：交叉编译通过。
- `PULSE_TEST_UI=http://127.0.0.1:8000 PULSE_TEST_OUT=/tmp/pulse-r2-verification/final python3 scripts/verify-sharing-ui.py`：7 组核心场景通过，见 [核心操作结果](verification/r2/ui-results.json)。测试复制的 Python 用标准库 http.client，cURL 用 POSIX shell/openssl 解码原始字节，均实际请求本地上游并校验。
- `PULSE_TEST_UI=http://127.0.0.1:8000 PULSE_TEST_OUT=/tmp/pulse-r2-verification/final python3 scripts/verify-intruder-ui.py`：4 组边界场景通过，见 [边界操作结果](verification/r2/edge-results.json)。包括位置、文件、保存恢复、gzip Grep、运行锁定、离开停发、长报文搜索、900px 与减少动态效果。
- 真实重启：先创建 90 天分享，停止旧进程，再启动最终二进制，原分享 JSON 与重启前逐字段完全一致。

两个 UI 脚本需要本机 Chrome 与 Python playwright，必须对隔离数据目录运行，会创建测试流量、标签、攻击并修改分享设置。它们是验证依赖，不是产品运行依赖。

截图：[完整分享](verification/r2/shared.png)、[Intruder 结果](verification/r2/intruder-results.png)。使用合成数据，未分享用户真实流量。

补验通过：Live Traffic 行右键创建分享；Intruder 上游拒绝连接时仍可检查发送请求与错误；根 URL 直接带 query 的 Raw 导出保留查询串。

回归修复：Live Traffic → Send to Repeater 现在记录创建出的精确 tab ID，并在异步标签列表包含该 ID 后才消费导航意图；不再用 mount-only 的“跳最新”布尔值。Vite 和最终内嵌二进制均模拟 Send 后立即点击 Repeater，分别从旧 tab-30/tab-34 跳到新 tab-31/tab-35，普通离开再返回也保持新 tab。证据见 [repeater-navigation.json](verification/r2/repeater-navigation.json)。

最终构建、跨重启及分享清理证据：[artifact-checks.json](verification/r2/artifact-checks.json)。

后续界面完善：分享页将长 URL 拆为固定方法 + 单行省略 URL；Request-only 使用单列 Request 与非阻塞提示；Raw 展示和复制正文复用 Live Traffic 自动解码，公开 token 提供受限 gzip/deflate/br/bzip2 解码端点，完整 JSON/Hex 仍保留原压缩字节。Intruder 移除 Attack name，默认打开最新记录并保存最后一轮结果摘要/Flow ID；左栏对齐 Repeater 的请求首行、悬浮快速删除和右键发送。验证脚本见 [verify-share-intruder-polish.py](../scripts/verify-share-intruder-polish.py)。

边界补验：有历史的 Repeater tab 在编辑但未再次发送时，Share request 只分享当前 Request；只有显式 historyAt 才分享对应历史 Request/Response，避免把当前请求与旧响应配对。公开分享实际捕获 Brotli 响应并在浏览器中显示解码文本；全新数据目录的 Intruder 显示可操作空状态。

本轮最终证据：[Request-only 分享](verification/r4/request-only-share.png)、[Brotli 分享](verification/r4/brotli-share.png)、[Intruder 结果恢复](verification/r4/intruder-restored.png)、[全新实例空状态](verification/r4/intruder-empty.png)、[浏览器结果](verification/r4/ui-results.json)、[Go race](verification/r4/go-test-race.txt) 与 [前端构建](verification/r4/frontend-build.txt)。

### 本轮需求到产物审计

| 明确要求 | 当前产物 | 覆盖证据 |
| --- | --- | --- |
| Share 长 URL 不破坏布局 | SharedTrafficView 将 method 与单行省略 URL 分层，完整值保留于 title 与 Raw | 1280px 页面无横向溢出，URL 元素自身确认溢出并省略；request-only-share.png |
| Share 自动解码 br / zip | FlowSnapshot 复用 bodyToTextDecoded；公开 token 增加只读 decode；支持 gzip/x-gzip、deflate、br、bzip2/x-bzip2 | Go gzip+Brotli 用例；真实 Brotli 上游经代理捕获后在最终公开页显示解码正文；Raw/Copy 用解码文本，Hex/JSON 保留原字节 |
| 只分享 Request | Live Traffic pending/intercepted 可分享；Repeater 无 historyAt 分享当前保存 Request | Go 验证 pending Flow 与有旧历史但当前未发送的 Repeater 请求均无虚构 Response；浏览器显示单列 Request + 小型说明 |
| Intruder 保存上次结果 | attacks.json 保存最后一轮摘要、Flow ID 与 lastRunAt，计划更新不清空结果 | Go 重启恢复/删除/写盘回滚；浏览器运行后 reload 仍显示两条，结果详情按需读取 Flow |
| Intruder 首次进入状态 | 有记录自动选择最新并打开 Results；无记录显示说明和 New attack | 最终应用裸 #/intruder 验证自动选择；全新数据目录截图验证可操作空状态 |
| 左侧列表快速删除与右键 | Repeater 风格两行项、悬浮 x；右键 Open / Send template to Repeater / Delete | Chrome 验证右键发送后 Repeater 精确选中新标签；快速删除后自动选下一条或空状态 |
| 删除 Attack name | 前端 Draft、输入框、API IntruderAttack 与文档均移除 title | TypeScript/Go 编译；公开 API 实查不含 title；Chrome locator 确认没有 Attack name |

## 明确边界

- 分享的是 Pulse 已捕获的全部记录，不是原始 TCP 字节流重建。原抓包阶段的截断、Lean 和丢弃标记保留，不能恢复从未存入的数据。Raw 是文本视图；二进制精确值在 Hex 和 JSON 下载中保留。
- 本期 Intruder 不含 Cluster bomb、并行/后台任务、暂停恢复、自动参数扫描或结果数据库。Stop 不强行中断已经发出的请求；结果暂存在当前页面，发过的请求仍在 Live Traffic 中。
- Windows 没有实机，交叉编译不能代表 Windows 交互已验证。仓库没有 Rust/Tauri 工程，本机实际应用就是 Go 二进制加浏览器。
- computer-use 技能已在首轮读取，当前工具仍没有该桌面控制接口；使用本机有窗口 Chrome/Playwright 验证，不声称调用过不可用接口。
- 分享扩展依据本轮明确要求执行。Intruder 范围问题没有收到选择回复，按已说明的推荐基础操作闭环实施，不把默认方案写成用户确认。
- 实时预览 5176 在 UI 修改前已经核对源码路径并提供，保留运行。最终 8000 应用内嵌资源已与 web/dist 比对。

首轮实现的“默认脱敏、正文可选、32 条/2 MiB、重启失效”已被本轮明确需求替换。[首轮记录](verification/first-round.md) 仅保留历史证据，不作为当前行为说明。
