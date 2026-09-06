# RC1 兼容验收 T01–T19 验证情况记录

> 状态：进行中（前轮宿主记录 + 2026-09-06 增量修复验证；完整 T01–T19 未重跑）· 分支 `feature/dsh-0.1.2-rc1-compat`
> 前轮验证环境：真实 DSH **0.1.2-rc.1** 宿主（配置 `DSH_HOME=/tmp/dsh-rc1-home`，Web CLI 形态，Linux；
> webserver `:3210` + 插件 LAN 桥 `:3180`，`file:` 链接加载仓库插件，模型 `deepseek-official/deepseek-v4-flash`，真实 `DEEPSEEK_API_KEY`）
> 目标环境（Desktop 形态、Windows、0.1.1-rc.2 回归）**尚未验证**。
> 状态口径：✅ 已实测通过 ｜ ◐ 部分验证 ｜ ⬜ 未验证 ｜ ⛔ 存在已知阻塞；源码发现与宿主实测在证据列分别标明

> 说明：T01–T19 来自 `docs/rc1-acceptance-checklist.md`。前轮已执行项沿用原记录，本次增加真实 RC1 运行时的定向回归；不把源码或函数级测试当作完整宿主 E2E 通过。R1–R7 详见 [补充审查报告](rc1-respond-settle-review.md)。审查基线为 `8e913b27c0c521f2470b086519f5a9bb7b18011e` 及其上的工作树改动。

环境证据待补：插件持久化使用 `homedir()/.dsh/mobile-remote`，仅设置 `DSH_HOME` 不能证明插件数据隔离。后续记录需包含测试进程的 `HOME`、实际 `homedir()`、宿主版本/制品校验值和插件实际加载路径/源码版本；当前不作“未触碰真实 `~/.dsh`”的确定判断。

## 环境矩阵

| 内核 | Desktop | Web |
| --- | --- | --- |
| 0.1.1-rc.2 | ⬜ 未验证 | ⬜ 未验证 |
| 0.1.2-rc.1 | ⬜ 未验证 | ◐ Web CLI（Linux）部分验证；本轮增加配置/历史/用量及冷会话发送定向回归 |

前轮及本轮定向运行时证据来自 **0.1.2-rc.1 + Web CLI + Linux** 这一格；其余三格待补。Desktop 内置内核版本未核实。本轮只增加该格的定向证据，不改变其“部分验证”状态。

## T01–T19 逐项验证情况

| # | 功能 | 状态 | 已验证证据 / 未覆盖项 |
|---|---|---|---|
| T01 | 安装与生命周期 | ◐ | ✅ 插件 `file:` 链入 RC1 profile 后加载成功、`/m/api/diagnostics` 可访问；重启宿主后插件随配置重载、`protocol` 仍为 `typert-rc1`，诊断可见 `services.sessionController`。⬜ 未验证：设置页 UI 注册、卸载后监听/连接释放、重复加载不重复监听 |
| T02 | 连接与二维码 | ◐ | ✅ LAN 桥 `:3180` 实际监听成功（`diagnostics.runtime.lanBridge.listening: true`），bootstrap 返回地址列表含 LAN IP 与回环。⬜ 未验证：扫码、手动连接、地址切换、桌面设置页二维码 UI |
| T03 | 访问控制 | ◐ | ✅ 无口令→`401`；错误口令→`401`；正确口令→`200`；`qr-config` 经 loopback 可读。⬜ 未验证：限流及恢复、Host 校验、LAN 桥不转发宿主 `/api`、qr-config 非回环拒绝 |
| T04 | 会话管理 | ◐ | 前轮会话列表可读，创建返回 `{"ok":true,"sessionId","preset":"standard"}`。本轮验证不带 `model` 及 App 新建参数创建后 `/session-config` 均返回 200 且含 `model/provider/reasoningEffort`；R7 修复后无 model 默认创建的首轮回复正常完成；⬜ 未验证绑定失败处理、空列表、目录归属、切换、归档/恢复、分叉、取消当前运行、标题/最近活跃排序 |
| T05 | 文本发送 | ◐ | ✅ `/m/api/send` 返回 `{ok,agentId,messageId,mode:"followup"}`；空闲会话接受消息并触发了 agent 运行（`agent/status running→idle`）。本轮另验证 dormant RC1 会话进入 `session.prompt` 恢复路径，返回 `accepted:true,note:"session-resumed"`；重启后 `services.sessionController=true` 的宿主实测走进程内服务，另有 Gateway 回退实测。R7 修复后默认会话首轮及冷会话恢复均收到非空模型回复并正常结束；⬜ 未验证运行中排队/插队、空消息与不存在会话的错误码 |
| T06 | 发送回执 | ⬜ | 未验证（requestId 幂等、回执查询、过期回执均未在 RC1 上实测） |
| T07 | 图片和附件 | ⬜ | 未验证（纯图/图文/多图、历史取图、限额、大请求过 LAN 桥） |
| T08 | 队列 | ⬜ | 真实队列行为未验证。源码发现 R5：RC1 未把 `agent/inbox/spliced` 转成 `mobile/queue`，存在跨端队列同步缺口。待修复并验证显示/编辑/删除/插队、电脑端修改和内核认领后的手机更新、空闲释放、重启恢复、竞态 |
| T09 | 历史与实时事件 | ◐ | 前轮 SSE 收到 `hello`、`session/event`（`turn/start`、`assistant/message`、`turn/end`、`session/title`）、`agent/status`、`mobile/notify`、`notifications/changed`。本轮已将活跃 RC1 `snapshotEvents()` 接入 `/history`，真实 RC1 定向检查返回 200；⬜ 未验证历史查询完整事件内容、分页/增量顺序、实时与历史一致性、断线重连补漏 |
| T10 | 模型及预设 | ◐ | 前轮冷会话 persona 报 `prompt variable "{{model}}" has no value`，`POST /m/api/session-config` 返回 `500 internal`；本轮统一事件读取并验证不带 `model` 及 App 新建参数创建后配置返回模型/提供商/推理强度，活跃 RC1 `session-config` 也返回 200。R7 修复后默认模型首轮回复通过；⬜ 未验证各 persona、配置写入及异常绑定处理；不能据此宣称模型/预设全覆盖 |
| T11 | 提供商配置与余额 | ⬜ | 未验证（提供商读取/保存/探测、凭证不回显、余额） |
| T12 | 工作区与目录 | ◐ | ✅ `/m/api/directories?path=` 返回 `{dirs:["/"],sep:"/"}`（Linux 分隔符 `sep` 正确）；`/m/api/workspaces` 返回 `{workspaces:[]}`。⬜ 未验证：浏览/新建文件夹、选 cwd、Windows 盘符、空格/中文路径、旧 App 回归 |
| T13 | 问询 | ◐ | 前轮真实模型 `ask_user_question` → SSE `question/requested` 字段正确并有 `needs-answer` 通知。出站曾 401，当前已改为进程内调用，闭环仍待验证。补充 R2：函数级复现重连残留；R3：答案校验缺失；R4：主动取消错误码不一致；R6：依赖私有方法且诊断不足。待修复并验证选项/自定义/非法答案后重试、主动取消、宿主中止、双端竞争、上游流断线期间另一端回答和未答事件重放 |
| T14 | 审批 | ⬜ | 审批入站和结算均未单独实测。与问询共用已改为进程内结算路径，但不能沿用问询入站结果认定审批通过。需验证 R2/R6、允许一次/拒绝/取消、宿主中止、跨端竞争及断线恢复 |
| T15 | 通知与推送 | ◐ | ✅ SSE 收到 `mobile/notify`（`kind:failed` 任务失败通知）与 `notifications/changed` 帧。⬜ 未验证：未读数/已读/删除、点击跳转、去重、子代理抑制、真实推送渠道 |
| T16 | 后台任务/子代理/目标 | ◐ | ✅ `/m/api/jobs`→`{jobs:[]}`、`/m/api/subagents`→`{parentAvailable:true,subagents:[]}`、`/m/api/goal`→`{goal:null}` 均 `ok`（端点通、RC1 映射未报错）。⬜ 未验证：任务终止、子代理中断、目标创建/暂停/继续/完成、失效对象报错 |
| T17 | 命令/动作/反馈 | ◐ | ✅ `/m/api/commands` 返回真实命令目录（compact/export/feedback/goal/…）；`/m/api/actions`→`{actions:[]}`。⬜ 未验证：命令执行、动作调用/卸载、消息赞踩与 PC 端一致性 |
| T18 | 用量与诊断 | ◐ | 前轮 `diagnostics` 可读，协议为 `typert-rc1`、Gateway 存在、桥状态为 true、`remoteEventClientId` 非空。本轮 `/usage` 已改用统一事件读取，真实 RC1 定向检查返回 200；R6：这些探测不证明出站结算可用。⬜ 未验证 token 用量样本、上下文窗口、结算方法缺失/错误时的诊断；本项不能标为完整通过 |
| T19 | App 交互回归 | ⬜ | 未验证（需真实 Android App + 真机：首页/会话/聊天/通知/设置、悬浮球、推理折叠、图片、主题、链接） |

## 补充审查检查结果与回归要求

R7 增量证据：实际 web profile 中旧 `dsh-sandbox-policy@0.1.0-rc.6` 覆盖 RC1，导致发送接受后首轮读取 `.length` 失败。改用宿主 peer 依赖并迁移锁文件后，`tools/verify-rc1-first-reply.mjs` 从失败转为通过；重启前失败的独立测试会话恢复后也收到非空回复并正常结束。完整 profile 已备份；未更新 Android APK，真机交互仍待用户验证。

2026-09-06 执行的映射断言、`node --check lib/index.js` 和 `git diff --check` 均通过。真实 0.1.2-rc.1 Web CLI/Linux 运行时的 `/session-config`、`/history`、`/usage` 三条活跃会话路径均返回 200；不带 `model` 及 App 新建参数创建会话后配置均含模型/提供商/推理强度；dormant 会话进入 RC1 `session.prompt` 恢复路径，返回 `accepted:true,note:"session-resumed"`。重启后诊断显示 `sessionController=true`，冷发送实测走进程内服务；另一次启动状态为 false 时验证了 Gateway 回退。使用当前源码原函数和 RC1 形状对象复现了 R1；使用当前源码与 Gateway 行为替身复现了 R2。R3–R6 为源码对照发现。没有执行新的 Android 测试，完整证据边界见 [复盘报告第 6 节](rc1-respond-settle-review.md#6-本轮检查证据边界与验收顺序)。

| 补充项 | 对应验收项 | 需要观察的结果 |
| --- | --- | --- |
| R1 会话事件接口及默认模型绑定 | T04、T09、T10、T18 | RC1 事件读取、配置/历史/用量定向路径已修复并验证；R7 修复后默认模型首轮回复通过；仍需两版本完整回归和必要绑定失败场景 |
| R2 上游流重连竞态 | T13、T14 | 另一端已答或宿主已取消的卡片消失；仍待答的事件可恢复；重复提交不改变既有答案 |
| R3 非法问答结果 | T13 | 非法结构返回明确错误且问题保持待答，随后合法回答可成功 |
| R4 主动取消语义 | T13 | 手机与电脑主动取消均为 `ASK_CANCELLED`，宿主中止保留 `ASK_ABORTED` |
| R5 队列变化转发 | T08 | 电脑修改、内核消费和手机修改都能即时更新手机队列，并保留插件持存项 |
| R6 结算能力及诊断 | T01、T13、T14、T18 | 方法不可用时明确报错；真实问询/审批闭环成功；启动探测不冒充闭环验证 |

## 当前结论

- 前轮在**单一格子**（0.1.2-rc.1 + Web CLI + Linux）完成了协议生效、问询入站和若干端点的部分验证；本轮在同一格子补充了 R1 定向运行时回归，但没有扩展环境矩阵或完成 T01–T19。
- respond 结算 401 的修复已实现，真实出站闭环待验证。R1 的事件读取/冷会话恢复修复已在工作树完成并通过上述定向检查；R2–R6 及完整 T01–T19 仍待验收，不能把本轮定向通过当作完整兼容声明。
- 所有已知阻塞、未覆盖项及其余环境矩阵仍需逐项验收；**当前不得对外宣称「完整兼容」**。

## 变更清单（本轮新增）

| 文件 | 变更 |
|---|---|
| `lib/index.js` | 统一 RC1/旧版事件读取；冷 RC1 会话发送优先经注入的 `sessionController.prompt` 恢复，Gateway 作为回退 |
| `lib/rc1-adapter.js` | 新增事件快照读取和发送路由兼容层 |
| `tools/verify-rc1-adapter.mjs` | 增加事件读取、live/cold/missing 路由断言 |
| `package.json` | 三个 DSH 内核包改为宿主 peer 依赖 |
| `tools/verify-rc1-first-reply.mjs` | 创建测试会话并断言非空模型回复和正常轮次结束，最后归档 |
| `tools/verify-rc1-live-routes.mjs` | 新增真实 RC1 活跃会话配置/历史/用量定向回归 |
| `dsh-mobile-app/lib/screens/chat_screen.dart` | RC1 缺少 `messageId` 时保留未绑定乐观消息，避免 SSE 回显重复 |
| `docs/09-compatibility.md` | 记录 RC1 事件读取与冷会话发送修复边界 |
| `docs/rc1-t01-t19-verification.md` | 本记录（T01–T19 逐项验证情况） |
