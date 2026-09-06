# RC1 兼容验收 T01–T19 验证情况记录

> 状态：进行中（前轮宿主记录 + 2026-09-06 RC1 定向回归；完整 T01–T19 未完成）· 当前工作树分支 `feature/app-auto-update`（RC1 兼容提交已合入）
> 本轮验证环境：真实 DSH **0.1.2-rc.1** 宿主（Web CLI 形态，Linux；`dsh --profile web --host 192.168.50.142 --port 3080`），profile 的 `file:` 插件副本已刷新为当前工作区代码，插件 `3.1.1`，协议 `typert-rc1`，默认模型 `gpt-5.6-luna`。
> 目标环境（Desktop 形态、Windows、0.1.1-rc.2 回归）**尚未验证**。
> 状态口径：✅ 已实测通过 ｜ ◐ 部分验证 ｜ ⬜ 未验证 ｜ ⛔ 存在已知阻塞；源码发现与宿主实测在证据列分别标明

> 说明：T01–T19 来自 `docs/rc1-acceptance-checklist.md`。前轮已执行项沿用原记录，本次增加真实 RC1 运行时的定向回归；不把源码或函数级测试当作完整宿主 E2E 通过。R1–R7 详见 [补充审查报告](rc1-respond-settle-review.md)。审查基线为 `8e913b27c0c521f2470b086519f5a9bb7b18011e` 及其上的工作树改动。

环境证据：本轮测试进程 `HOME=/home/mark`，Node `homedir()` 为 `/home/mark`；插件因此使用真实 `/home/mark/.dsh/mobile-remote` 持久化目录（未读取或记录其中的口令/密钥）。宿主版本为 `dsh --version = 0.1.2-rc.1`；实际插件路径为 `/home/mark/.dsh/profiles/web/node_modules/dsh-mobile-remote`，刷新后与当前工作区源码哈希一致。临时会话目录均在 `/tmp`，测试结束已停止/归档；profile 刷新前配置和锁文件已备份到 `/tmp/dsh-web-profile-backup-20260906-235225`。

## 环境矩阵

| 内核 | Desktop | Web |
| --- | --- | --- |
| 0.1.1-rc.2 | ⬜ 未验证 | ⬜ 未验证 |
| 0.1.2-rc.1 | ⬜ 未验证 | ◐ Web CLI（Linux）部分验证；本轮增加配置/历史/用量及冷会话发送定向回归 |

前轮及本轮定向运行时证据来自 **0.1.2-rc.1 + Web CLI + Linux** 这一格；其余三格待补。Desktop 内置内核版本未核实。本轮只增加该格的定向证据，不改变其“部分验证”状态。

## T01–T19 逐项验证情况

| # | 功能 | 状态 | 已验证证据 / 未覆盖项 |
|---|---|---|---|
| T01 | 安装与生命周期 | ◐ | ✅ 刷新 Web profile 后实际加载插件 `3.1.1`，`lib/index.js`/`lib/rc1-adapter.js` 与工作区哈希一致；重启宿主后诊断可读且 `protocol=typert-rc1`、`services.sessionController=true`。⬜ 未验证：设置页 UI 注册、卸载后监听/连接释放、重复加载不重复监听 |
| T02 | 连接与二维码 | ◐ | ✅ 本轮 `/m/qr.png?text=...` 返回 512×512 PNG，loopback `qr-config` 可读。⬜ 未验证：扫码、手动连接、地址切换、桌面设置页二维码 UI；当前 Web CLI 未启用 LAN bridge |
| T03 | 访问控制 | ◐ | ✅ 无口令/错误口令→`401`；正确口令→`200`；错误口令限流→`429`，等待窗口后恢复为 `401`；错误 Host→`403`；非 loopback `qr-config`→`403`。⬜ 未验证：LAN bridge 不转发宿主 `/api` |
| T04 | 会话管理 | ◐ | ✅ 临时会话创建、`touch`、配置读取、历史、归档、恢复、分叉均通过；停止/归档清理→`200`。发现：不存在会话的 GET `/session-config` 当前返回 `200` 空配置，绑定失败语义仍需确认；⬜ 未验证空列表、Windows 目录归属、标题/最近活跃排序的完整断言 |
| T05 | 文本发送 | ◐ | ✅ 当前 RC1 默认模型首轮真实回复完成；空文本→`400 empty-text`，不存在会话→`404 session-not-found`；冷会话恢复和运行中 followup 分别在本轮/前轮通过。⬜ 未验证 steer 真实行为及跨端排队后的执行顺序 |
| T06 | 发送回执 | ◐ | ✅ 同一 `requestId` 重复提交返回稳定相同结果；回执查询从 `in-progress`/完成路径可读，真实临时会话最终 `done` 且与首次响应一致；非法 requestId→`400`，未知回执→`404`。⬜ 未验证响应丢失模拟、重启恢复和过期回执 |
| T07 | 图片和附件 | ◐ | ✅ 最小 PNG 图文消息真实接受；历史包含 `attachmentId`；`/attachment` 返回原始 PNG 字节；模型回复正常完成。⬜ 未验证纯图/多图、格式/大小/张数限额、非视觉模型、损坏图片和 LAN bridge 大请求 |
| T08 | 队列 | ◐ | ✅ 真实运行中 followup 进入插件持存队列，GET 可见，编辑和删除即时生效。⬜ 未验证插队、空闲释放、重启恢复、电脑端/内核队列变化与认领竞态；RC1 `session/queue` 跨端事件仍需专门验证 |
| T09 | 历史与实时事件 | ◐ | ✅ RC1 活跃会话 `session-config`/`history`/`usage` 返回 `200`；真实 SSE 收到 `hello`、`session/event`、`agent/status`、`session/context`、`mobile/notify` 等，问询闭环也收到 `mobile/frame`；`before`/`after` 分页边界、排序和 `limit` 上限通过。⬜ 未验证实时与历史去重一致性、断线重连补漏 |
| T10 | 模型及预设 | ◐ | ✅ RC1 `catalog` 返回真实模型/提供商/推理/权限/Agent 预设；新建会话及配置读取含 `model/provider/reasoningEffort`；危险权限未确认→`400 risk-confirmation-required`；默认模型首轮通过。⬜ 未验证切换写入、各 persona、视觉能力和电脑/手机配置一致性 |
| T11 | 提供商配置与余额 | ◐ | ✅ 提供商列表和余额端点在 RC1 返回 `200`；未知提供商→`400 unknown-provider`，可配置提供商的不可达探测→`400 probe-failed`，响应仅返回凭据引用/状态而非原始密钥。⬜ 未验证保存/真实凭证探测、无凭证/错误凭证/超时，以及余额字段完整展示 |
| T12 | 工作区与目录 | ◐ | ✅ 根目录返回 `dirs` 与 Linux `sep`；临时目录新建、中文/空格目录创建与浏览通过；工作区列表端点可读。⬜ 未验证 Windows 盘符、完整目录选择和旧 App 回归 |
| T13 | 问询 | ◐ | ✅ 合法答案闭环通过：SSE 收到 `question/requested`，Gateway 接受答案并收到 `question/resolved`，模型轮次正常完成且有非空回复；取消请求也返回 `200 accepted:true` 并结束轮次。✅ 修复 R3 后非法选项返回 `400 question-answer-invalid`，随后合法答案仍可接受。⬜ 未验证取消的上游错误码、电脑/手机竞争、断线重连和自定义/多选组合 |
| T14 | 审批 | ◐ | ✅ 真实审批请求已送达 Android App，并由手机端人工批准；服务端历史包含审批请求和后续工具结果，临时目标操作完成。⬜ 未验证拒绝、取消、手机/电脑竞争、断线重连，以及更严格的“允许一次”重复调用语义 |
| T15 | 通知与推送 | ◐ | ✅ SSE 收到 `mobile/notify`、`notifications/changed`，临时问询/任务测试产生相应事件。⬜ 未验证未读/已读/删除、点击跳转、去重、子代理抑制和真实推送渠道 |
| T16 | 后台任务/子代理/目标 | ◐ | ✅ RC1 `/jobs`、`/subagents?parentSessionId=...`、`/goal` 均返回 `200` 且结构正确；失效 job kill 与未知对象错误路径已探测。⬜ 未验证任务终止、子代理中断、目标创建/暂停/继续/完成及非法状态 |
| T17 | 命令/动作/反馈 | ◐ | ✅ RC1 commands/actions/feedback 列表端点均返回 `200`；未知命令→`404 command-not-found`。⬜ 未验证命令执行、动作注册/调用/卸载、消息赞踩及电脑端一致性 |
| T18 | 用量与诊断 | ◐ | ✅ 诊断报告 `protocol=typert-rc1`、`typertGateway/sessionController/respondBridge/frameBridge=true`，`remoteEventClientId` 非空；usage 返回 `200`，首轮事件含完成结果。⬜ 未验证 token 样本、上下文窗口真实更新、结算失败诊断和两版宿主对照 |
| T19 | App 交互回归 | ⬜ | 未验证：环境无 `flutter`/`adb`，需真实 Android App/真机：首页/会话/聊天/通知/设置、扫码、悬浮球、推理折叠、图片、主题、链接 |

## 补充审查检查结果与回归要求

R7 增量证据：实际 web profile 中旧 `dsh-sandbox-policy@0.1.0-rc.6` 覆盖 RC1，导致发送接受后首轮读取 `.length` 失败。改用宿主 peer 依赖并迁移锁文件后，`tools/verify-rc1-first-reply.mjs` 从失败转为通过；重启前失败的独立测试会话恢复后也收到非空回复并正常结束。完整 profile 已备份；未更新 Android APK，真机交互仍待用户验证。

2026-09-06 执行的映射断言、`node --check lib/index.js` 和 `git diff --check` 均通过。真实 0.1.2-rc.1 Web CLI/Linux 运行时的 `/session-config`、`/history`、`/usage` 三条活跃会话路径均返回 200；不带 `model` 及 App 新建参数创建会话后配置均含模型/提供商/推理强度；dormant 会话进入 RC1 `session.prompt` 恢复路径，返回 `accepted:true,note:"session-resumed"`。重启后诊断显示 `sessionController=true`，冷发送实测走进程内服务；另一次启动状态为 false 时验证了 Gateway 回退。使用当前源码原函数和 RC1 形状对象复现了 R1；使用当前源码与 Gateway 行为替身复现了 R2。R3–R6 为源码对照发现。没有执行新的 Android 测试，完整证据边界见 [复盘报告第 6 节](rc1-respond-settle-review.md#6-本轮检查证据边界与验收顺序)。

本轮追加运行时证据（同一 RC1 Web CLI/Linux 环境）：profile 刷新后已加载插件与工作区源码哈希一致（插件 `3.1.1`），重启后 `protocol=typert-rc1`、`typertGateway/sessionController/respondBridge/frameBridge=true`。T04 临时会话的创建、touch、历史、归档、恢复、分叉通过；T05 默认模型首轮真实回复、空文本和不存在会话错误通过；T06 requestId 重复提交结果稳定、回执最终 `done` 且与首次响应一致；T07 最小 PNG 图文发送、历史 `attachmentId` 和附件字节取回通过；T08 运行中 followup 的持存队列、编辑、删除通过；T09 `before`/`after` 历史分页、排序和 `limit` 上限通过；T12 中文/空格目录创建和浏览通过；T13 合法问询从 `question/requested` 到 Gateway 接受、`question/resolved` 和正常轮次完成通过；R3 修复后非法选项返回 `400 question-answer-invalid`，合法答案仍可接受。T02 二维码 PNG、T03 Host/限流/恢复/loopback 边界、T10 危险权限确认、T11 提供商校验/探测错误、T16/T17/T18 结构和错误路径也已定向验证。Web CLI 自动审批探测未触发 `approval/requested`；另有人工 Android 审批批准证据，T14 仍需拒绝/取消/竞争/重连覆盖。

| 补充项 | 对应验收项 | 需要观察的结果 |
| --- | --- | --- |
| R1 会话事件接口及默认模型绑定 | T04、T09、T10、T18 | RC1 事件读取、配置/历史/用量定向路径已修复并验证；R7 修复后默认模型首轮回复通过；仍需两版本完整回归和必要绑定失败场景 |
| R2 上游流重连竞态 | T13、T14 | 本轮未验证；仍需证明另一端已答/宿主取消后卡片消失、未答事件可恢复、重复提交不改变既有答案 |
| R3 非法问答结果 | T13 | 已修复并实测：未声明选项返回 `400 question-answer-invalid`，不会结算；随后合法答案仍可接受。仍需补充多问、多选、自定义答案组合 |
| R4 主动取消语义 | T13 | 取消请求实测被 RC1 接受并结束轮次，但历史只显示 `turn/end=completed`，未暴露上游错误码；当前源码构造 `ASK_ABORTED`，与清单期望的手机主动取消 `ASK_CANCELLED` 存在差异，仍需上游/双端确认 |
| R5 队列变化转发 | T08 | 本轮仅验证手机持存队列的显示/编辑/删除；电脑修改、内核消费、RC1 `session/queue` 跨端事件和重启恢复仍未验证 |
| R6 结算能力及诊断 | T01、T13、T14、T18 | 本轮真实问询结算成功且诊断桥状态准确；审批未触发，`dispatchRpc` 仍是宿主私有方法，不能据此宣称两类交互均完成兼容 |

## 当前结论

- 当前仍只有**单一格子**（0.1.2-rc.1 + Web CLI + Linux）获得定向运行时证据；0.1.1-rc.2、Desktop、Windows/WSL 路径和 Android App 尚未完成，T01–T19 不能视为完整验收。
- respond 401 的修复已在真实 RC1 问询闭环中验证；文本、回执、图片、持存队列及多项只读/错误路径也已定向通过。R3 非法答案校验已修复并回归通过；T14 已有 Android 允许一次证据，但拒绝/取消/竞争/重连，以及 R2/R4–R6 仍待验证。
- 已发现不存在会话 GET `/session-config` 返回空配置的边界，需确认是否修复或明确契约；**当前不得对外宣称「完整兼容」**。

## 变更清单（本轮新增）

| 文件 | 变更 |
|---|---|
| `lib/index.js` | 统一 RC1/旧版事件读取；冷 RC1 会话发送优先经注入的 `sessionController.prompt` 恢复，Gateway 作为回退；新增 RC1 问询答案约束校验 |
| `lib/rc1-adapter.js` | 新增事件快照读取和发送路由兼容层 |
| `tools/verify-rc1-adapter.mjs` | 增加事件读取、live/cold/missing 路由断言 |
| `package.json` | 三个 DSH 内核包改为宿主 peer 依赖 |
| `tools/verify-rc1-first-reply.mjs` | 创建测试会话并断言非空模型回复和正常轮次结束，最后归档 |
| `tools/verify-rc1-question-answers.mjs` | 校验 RC1 问询合法/非法选项、单多选、自定义答案和缺答路径 |
| `tools/verify-rc1-live-routes.mjs` | 新增真实 RC1 活跃会话配置/历史/用量定向回归 |
| `dsh-mobile-app/lib/screens/chat_screen.dart` | RC1 缺少 `messageId` 时保留未绑定乐观消息，避免 SSE 回显重复 |
| `docs/09-compatibility.md` | 记录 RC1 事件读取与冷会话发送修复边界 |
| `docs/rc1-t01-t19-verification.md` | 本记录（T01–T19 逐项验证情况） |
