# 本轮交付与验证记录

日期：2026-09-16。环境：macOS arm64，Go 1.26.1，Node 20，实际安装的 Google Chrome；初始代码 e223756。交付为工作区源码与本地构建，未创建 PR、提交、发布或部署。

## 需求到证据的完成审计

| 目标 / 验收项 | 具体产物 | 核验结果 |
| --- | --- | --- |
| 阅读理解已有代码 | Optimization-2026-09.md 中的真实调用路径表 | 对照 main、proxy、store、api、Settings、Extensions 和插件 SDK/CLI 完成 |
| 提出有特色、轻量、补充 Burp 的优化方案 | Product.md、Optimization-2026-09.md、双语 README | 明确定位、首期范围、优先级、不做范围、上限及升级条件；未新增运行依赖 |
| 临时网络流量分享 | api/shares.go、ShareDialog.tsx | 选中完成态单条流量、预览、创建、只读接收页面已实现并实操 |
| 地址来自 Settings IP | Settings.ShareIP、SharingSettings.tsx、shareBase | 设置持久化；Chrome 打开本机 LAN IP 链接；实际端口 8000 而非前端 5176；IPv6 [::1] 实测通过 |
| 临时语义 | timer、DELETE 管理路由、进程内 map | 撤销即时 404；1 分钟实际到期 404；同一时刻 30 分钟链接仍 200；重启后旧链接 404、列表空、IP 保留 |
| 分享内容与访问隔离 | 头/查询值脱敏、独立 Flow、HTML template、CSP | 默认正文不含；原 Flow 不变；显式含正文时 HTML 仍是转义文字；LAN 分享无需 key、管理 API 401；token 无管理权限 |
| 轻量边界 / 失败处理 | 32 链接、2 MiB/条、16 MiB 合计 | 超量拒绝；撤销后回收容量；缺失/待完成 Flow、非法 IP/TTL、设置写入失败均有测试 |
| extension plugins 开发 Skill | internal/plugins/skills/pulse-plugin-dev | SKILL.md、metadata、作用域模板、正反夹具、Python 沙箱断言客户端；格式验证通过 |
| 页面展示 Skills | PluginSkills.tsx、ExtensionsView.tsx | 深链、刷新保留、复制、ZIP 下载、编辑器跳转；加载失败 Retry 实测恢复 |
| 方便 AI 写代码与调试 | 内嵌 SDK、kit helper、现有 Editor | 下载包实际解压运行，正反断言通过；错误断言和 HTTP 200 内 runtime error 都非零退出；UI 手写插件 Check/Test 通过；模板安装后通过真实本地代理观察正反结果 |
| 自动化测试和实际操作 | 下方命令、verify-sharing-ui.py、verification/ | 全量 race 通过、前端构建通过、macOS 单二进制浏览器操作通过 |
| UI 开发实时预览 | Vite 127.0.0.1:5176 | 在第一行 UI 修改前提供并验证 main.tsx 源路径；5175 属其他项目，未误用 |
| 设计/动画/无障碍 | 原生 dialog、主题 token、语义标签 | Escape、焦点恢复、900px 宽度、减少动态效果检查通过；浅色主题对比缺陷已修复并重验；高频数据与键盘动作不加动画 |

## 自动化结果

- `go test -race ./...`：通过。真实输出保存在 [go-test-race.txt](go-test-race.txt)。新分享测试覆盖生命周期、原数据保护、内容转义、鉴权、设置校验/落盘、并发、单条/总量/条数限制和 Skill 下载契约。
- `go vet ./...`：通过。
- `cd web && npm run typecheck`：通过；`npm run build`：通过并更新仓库内 web/dist。最终 JS 793.32 kB / gzip 258.13 kB，CSS 68.90 kB / gzip 12.65 kB。Vite 仍有单 chunk 超过 500 kB 的提示；本期未引入新依赖或进行无实测依据的构建拆分。
- `go build -o /tmp/pulse-verification/pulse ./cmd/pulse`：通过，并实际运行该 Mach-O arm64 二进制。
- `GOOS=windows GOARCH=amd64 go build -o /tmp/pulse-verification/pulse-windows-amd64.exe ./cmd/pulse`：交叉编译通过，仅代表编译。
- `python3 .../skill-creator/scripts/quick_validate.py internal/plugins/skills/pulse-plugin-dev`：`Skill is valid!`。
- 下载后 `scripts/check_plugin.py`：匹配 3 个断言、非匹配 2 个断言通过；错误预期和 runtime error 均退出 1，见 [kit-results.json](kit-results.json)。

回归发现并修复：`spool` 先 Peek 再 io.Copy 导致缓冲前缀重复转发；Store 保留生产者可变元数据导致数据竞争及历史内存记账失准。各新增直接回归用例。原有测试修正了拦截结果无同步读取、重开时误用新状态目录、macOS /var 符号链接比较，以及更新测试把平台写死 Windows 的夹具问题；未删减断言以绕过真实错误。

## 真实操作路径

运行一次 Vite 开发界面，另一次运行带生产资源的编译二进制。Chrome 为有窗口模式，使用隔离浏览器上下文和 /tmp/pulse-goal-dev 数据目录，不修改用户常用实例。

可复现脚本：`scripts/verify-sharing-ui.py`。依赖本机 Google Chrome 与 Python playwright，仅用于测试，不是产品运行依赖。**只针对隔离测试实例执行**：它会设置分享 IP 并创建合成流量。脚本参数来自 PULSE_TEST_API、PULSE_TEST_UI、PULSE_TEST_PROXY、PULSE_TEST_IP、PULSE_TEST_OUT；默认 8000 / 5176 / 18081，macOS 自动读取 en0 IP。

```sh
PULSE_TEST_UI=http://127.0.0.1:8000 PULSE_TEST_OUT=/tmp/pulse-verification/final python3 scripts/verify-sharing-ui.py
```

11 项结果保存在 [ui-results.json](ui-results.json)：非法 IP 就地反馈、IP 持久化、预览隐藏凭据、Escape/焦点恢复、正确生成地址、LAN 只读访问及控制 API 拒绝、撤销、Skill 复制/下载/深链、Editor Check/Test、900px 减少动态效果、零浏览器运行错误。

额外实测：IPv6 链接可读取；Skills 模拟 503 → Retry 恢复；分享预览模拟失败 → 创建按钮不可用。将 Skill 模板临时安装到测试目录后，真实代理请求 /v1/items 的上游观察到 X-Debug-Client=pulse，/unrelated 没有此头，测试插件已移除。

截图：[分享预览](share-preview.png)、[接收者页面](recipient.png)、[Skills](skills.png)。截图中均为合成数据。

附加证据：[真实到期与重启结果](lifecycle-results.json)、[最终二进制哈希与资源一致性](artifact-checks.json)。最终构建再次执行上述 11 项浏览器操作，已清除测试分享与临时插件，实时预览和本地应用保留运行。

## 边界与未执行项

- 当前仓库没有 Rust/Tauri 项目，因此没有虚构 Cargo、Tauri 或原生桌面壳测试。macOS 实际验证的是产品现有 Go 二进制加 Chrome 形态。
- Windows 仅交叉编译；没有 Windows 实机，未声称其 UI、系统集成或 runtime 通过。LAN 在同一台 macOS 上经真实 LAN 接口连接，不代表另一物理机器的防火墙/网络已验证。
- 已安装读取 grill-me 和 Emil 技能；AskUserQuestion 不可用，改用结构化异步问题。用户未回复分享范围，按已说明的单条快照默认执行，没有将默认选择写成已确认结论。
- computer-use 技能文件存在并已读取，但本会话没有桌面控制接口；用实际 Chrome/Playwright 完成 UI 操作并记录证据，不声称调用过不可用工具。
- 按 skill-creator 启动的独立 AI 试用未产生可核验产物，已停止，不计为通过。Skill 可执行验证依据为本地 helper、下载包、UI 和真实代理路径。
- 多条打包分享、实时共享会话、云中转、账户协作、插件市场不在已说明的首期范围。HTTP 分享用于可信网络；正文包含需自行检查，已经复制的内容不可收回。

审计结论：本期显式交付项均有实现及验证证据；平台和工具限制已明确记录，不把编译成功或单次测试当作真实操作的替代。
