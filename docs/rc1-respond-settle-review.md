# RC1 问询/审批结算复盘与兼容性补充审查

> 状态：respond 修复已实现；R1 事件读取/冷会话恢复修复已实现并定向验证；问询/审批闭环待验证 · 未发布 · 分支 `feature/dsh-0.1.2-rc1-compat`
> 证据：前轮真实 DSH 0.1.2-rc.1 宿主记录；2026-09-06 源码审查、函数级最小复现及真实 RC1 Web CLI/Linux 定向回归
> 配套：`docs/specs/dsh-0.1.2-rc1-compatibility.md`、`docs/09-compatibility.md`、`docs/rc1-acceptance-checklist.md`

## 1. 背景

`dsh-mobile-remote` 插件在 DSH 0.1.2-rc.1 上用 Typert Gateway 替代旧 `apiProxy`，其中问询/审批（`ask_user_question` / 工具审批）经 Gateway 的 `$events` stream 入站、经 `$events/result` 结算。前轮真实宿主测试发现结算 HTTP 401，随后实现了修复，但修复后的回答闭环尚未完成。

补充审查范围为提交 `8e913b27c0c521f2470b086519f5a9bb7b18011e` 之上的改动，以及与其相关的当前分支调用链。第 5 节区分本次修改的接口依赖与既有兼容遗漏，不把所有问题都归因于这次修改。审查发现的 R1 已在当前工作树实施修复；其余缺陷仍按证据边界记录，当前未提交或推送。

## 2. 验证环境（真实宿主）

- `dsh --version` = **0.1.2-rc.1**（精确）
- 宿主数据目录配置：`DSH_HOME=/tmp/dsh-rc1-home`；webserver `:3210`，插件 LAN 桥 `:3180`
- 插件经 `file:` 链接加载仓库 `dsh-mobile-remote`，配置 `lanBridge.enabled + authToken`
- 模型：`deepseek-official` / `deepseek-v4-flash`，使用真实 `DEEPSEEK_API_KEY`

以上环境与运行结果沿用前轮记录，本次未重新启动该宿主。隔离性证据尚不完整：插件在 `lib/index.js` 中使用 `homedir()/.dsh/mobile-remote` 保存队列、回执、通知已读和活跃时间，单独设置 `DSH_HOME` 不能证明插件数据也被隔离。需补记测试进程的 `HOME`、实际 `homedir()`、插件解析后的加载路径和源码版本；在证据补齐前撤回“未触碰真实 `~/.dsh`”的确定表述。报告不记录密钥值。

## 3. 已验证通过（真实运行时）

| 项 | 结果 |
|---|---|
| 协议选择 | `diagnostics.protocol = "typert-rc1"`（证明 `ctx.inject(["typertGateway"])` 生效）|
| 服务面 | `services.typertGateway: true`、`services.apiProxy: false` |
| `$events` stream | `remoteEventClientId` 非空 UUID → `wireStream.open("$events")` 收到 `ready` |
| 桥状态 | `checks.respondBridge: true`、`checks.frameBridge: true`；当前探测不检查 `dispatchRpc`，不能据此认定出站结算可用 |
| **问询入站** | 真实模型调用 `ask_user_question` → SSE 收到正确的 `mobile/frame` `question/requested`（`rpcId`/`sessionId`/`questions[].options` 字段全部一致），并触发 `needs-answer` |

入站链路的字段映射（`event:"user-questions/request"`、`eventId`→`rpcId`、`request.questions`）与真实宿主运行时一致。

## 4. 缺陷（阻断性）

`POST /m/api/respond` 返回：

```
{"error":"respond-failed","detail":"rpc transport failed: HTTP 401"}
```

### 4.1 根因

结算问询/审批时，`respondRemoteWaterfall`（`lib/index.js`）调用了 `apiRpcTransport(RC1_REMOTE_EVENT_RESULT, { args: result }, 30_000)`：

1. `apiRpcTransport` 是**旧版 0.1.1-rc.2 的 `/api` HTTP envelope** helper，执行裸
   `fetch("http://127.0.0.1:${port}/api/$events/result", { headers: { "content-type": "application/json" } })`，**不带任何认证**。
2. RC1 的 `$events/result` HTTP 入口经 `connection.rpc.intercept("/api")`（浏览器连接 RPC）处理，
   被 `requestRejection → browserAuth.isAuthenticated`（签名 cookie）栅挡住；loopback 只过
   403/信任栅，过不了 401 cookie 栅。
3. Gateway **没有暴露进程内结算 `$events/result` 的标准 Remote 方法**：`invoke()` 只解析注册过的
   `<namespace>/<method>`，`wireStream` 只有 `open` + `failure`。

后果：该次移动端回答无法完成结算，待答卡片不能通过这次回答清除；如果没有另一端结算或宿主取消，交互会继续等待。审批结算与问询走同一路径，源码上存在相同故障路径，但前轮未单独触发审批实测。

最小复现：

```bash
curl -X POST 'http://127.0.0.1:3210/api/$events/result'   # 前轮记录：HTTP/1.1 401
```

### 4.2 修复

**当前实现通过宿主私有方法尝试进程内结算。** DSH 0.1.2-rc.1 的 `TypertGatewayService` 是进程内可达的 Cordis 服务
（`ctx.inject(["typertGateway"])` 已取得实例），但 `dispatchRpc(endpoint, payload, signal)` 在源码中声明为 **TypeScript `private` 方法**，并非公共扩展契约。
它的 `$events/result` 分支直接调用 `receiveRemoteEventResult`。TypeScript `private` 不等同于 JavaScript `#private`，不能据此断言当前 JavaScript 调用必然失败；同样不能把它描述为稳定的公共接口。当前改动没有修改 DSH 本体，实际出站能力仍须闭环验证。

修改 `lib/index.js` 的 `respondRemoteWaterfall`，把「旧 HTTP envelope」换成「进程内 gateway.dispatchRpc」：

```js
// 修复前
await apiRpcTransport(RC1_REMOTE_EVENT_RESULT, { args: result }, 30_000);

// 修复后
const settle = await remoteGateway.dispatchRpc(
  RC1_REMOTE_EVENT_RESULT,
  { args: result },
  AbortSignal.timeout(30_000),
);
if (settle?.ok !== true) {
  const err = new Error(settle?.error?.message ?? `$events/result failed`);
  if (settle?.error?.code) err.code = settle.error.code;
  err.status = 400;
  throw err;
}
```

要点：

- RC1 源码中，`dispatchRpc` 的 `$events/result` 分支捕获处理错误并返回 `{ ok: false, error }`；正常返回 `{ ok: true, value: void 0 }`。需检查 `ok`，但方法不存在等调用边界错误仍可能抛出。
- `{ ok: true }` 不保证本次答案改变了宿主状态：已结束事件或已被替换的投递会被 `receiveRemoteEventResult` 幂等忽略。客户端有效性和事件重放必须一起考虑，见 R2。
- `result` 形状 `{ clientId, eventId, outcome }` 与 Gateway `parseRemoteEventResult` 完全一致，无需改字段。

### 4.3 修复验证边界（诚实记录）

- ✅ 源码层：调用参数形状与 RC1 私有实现的 `dispatchRpc`、`parseRemoteEventResultPayload` 一致；这不构成公共接口兼容性保证。
- ✅ 语法：`node --check lib/index.js` 通过。
- ✅ 运行时加载：修复后的宿主重新 boot，`diagnostics` 仍为 `protocol: "typert-rc1"`、`typertGateway: true`、`respondBridge: true`。
- ⚠️ **闭环复测未完成**：前轮重新触发问询时，隔离宿主的**冷会话模型绑定**暴露了另一个独立问题
  （新会话 persona 模板 `{{model}}` 变量缺值 → `turn/end` reason `error`；`session-config` 写模型返回 500 `internal`），
  导致当时未能产生新的 pending question 来完成 `respond → question/resolved` 闭环。当前工作树已修复 R1；在真实 RC1 Web CLI/Linux 运行时定向验证了活跃配置、历史、用量、无模型创建默认选模和 dormant 发送恢复，但尚未重新产生问询/审批并完成出站闭环。
- 结论：已实现绕开旧 HTTP 401 路径的修改，入站已在前轮验证，出站结算标记为“待闭环验证”。私有接口、答案校验、取消和重连问题仍未解决，不能宣称 respond 链路正确性已经完整确立。

## 5. 补充审查发现（2026-09-06）

严重度：**BLOCKING** 为阻断兼容验收，**WARNING** 为应修正的问题或需明确控制的依赖。R1–R5 是当前分支原有兼容遗漏，R6 直接涉及本次未提交修改；其中 R1 已在当前工作树修复并做定向验证，R2–R6 仍待处理。文件行号对应本次审查快照，后续以函数名定位。

### R1 [已修复，仍需扩展验收] 会话事件读取接口未适配

- **位置**：[lib/index.js](../lib/index.js) 的 `foldAgentPreset`（1536）、`readSessionConfig`（1558 起）、`/history`（2389）及 `/usage`（3036、3056）。
- **历史证据**：RC1 `packages/core/session/src/index.ts` 的 `Session` 提供 `snapshotEvents()`，不再公开旧 `.events` 数组；原实现读取 `session.events.length`、调用 `.filter()` 或直接遍历。
- **影响**：存在活跃 RC1 Session 时，配置读取、历史和用量路径会抛异常。`POST /session-config` 即使选模成功，读取返回配置仍可失败。无显式模型创建会话时，`readSessionConfig` 抛错发生在默认 `session.selectModel` 之前，外层“附加配置失败不阻断创建”的 catch 又吞掉该异常，可能留下未完成默认模型绑定的会话。这与 T10 现象吻合，但未证明所有 `{{model}}` 错误都只有这一个原因。
- **最小复现**：从当前文件提取原始 `foldAgentPreset` 函数，用 `{ snapshotEvents: () => [] }` 模拟 RC1 Session 接口调用，得到读取 `length` 的 `TypeError`。这是函数级复现，不是实际宿主 HTTP 复测。
- **当前修复**：新增 `sessionEventsOf()` 兼容读取层，RC1 使用 `snapshotEvents()`，旧宿主使用 `.events`；配置、历史、用量及标题/事件折叠路径已接入。冷 RC1 会话发送时优先调用通过 `ctx.inject` 获取的 `sessionController.prompt`，由 Host 恢复后投递；没有该服务时才回退 Gateway，避免仅查 live agent。默认模型绑定仍需继续覆盖失败场景，不能被当作可选配置吞掉。
- **定向验证**：`verify-rc1-adapter.mjs`、`node --check lib/index.js`、真实 RC1 的 `/session-config`、`/history`、`/usage`、无模型创建配置及 dormant `/send` 均通过；重启后诊断显示 `services.sessionController=true`，dormant `/send` 实际走进程内 `sessionController.prompt` 并返回 `accepted:true`。此前一次 `services.sessionController=false` 的启动状态也验证了 Gateway 回退路径。两种路径均不替代两版本完整 E2E。
- **补测**：两种宿主的无显式模型创建、显式选模、配置读写、已有历史读取、用量查询；RC1 创建后首轮 persona 渲染和正常回复；绑定失败时不可返回可用会话的成功回执。

### R2 [WARNING] 桥接流重连后残留已结算交互

- **位置**：[lib/index.js](../lib/index.js) 的 `consumeRemoteFrame`（1239）和 `startRemoteEventBridge`（1280 起）。
- **证据**：断线只把 pending 的 `clientId` 置空；新 `ready` 又给全部旧 pending 赋新值。RC1 Gateway 只重放仍待结算的事件，已断开的客户端不会收到另一端结算时发出的 cancel；向已结束事件提交结果会被幂等忽略并返回成功。
- **复现顺序**：手机收到问题 → 插件与 Gateway 的事件流断开 → 电脑回答 → 插件流重连，仅收到 `ready`，没有该问题重放 → 旧卡片仍保留 → 手机提交得到成功，但未改变宿主答案。这里断开的是插件的上游事件流，不能用仅断开手机 SSE 的测试替代。
- **验证边界**：提取当前发布、消费和结算函数，以符合上述 Gateway 行为的 `{ ok: true }` 替身复现了旧 pending 被重新启用及本地 resolved；真实双端竞态尚未执行。
- **建议**：按连接代际和实际重放重建待答集合，明确清除未被重放的旧卡片；不能仅以 `ready` 认定全部旧事件仍有效。设计时保留仍待答事件的稳定标识和通知去重。
- **补测**：断线期间另一端回答、宿主取消、仍未回答的重放恢复，以及提交过程中重连；问询与审批都需覆盖。

### R3 [WARNING] 问答结果缺少结构校验

- **位置**：[lib/index.js](../lib/index.js) 的 `respondRemoteWaterfall`（1183）。
- **证据**：当前只检查 `Array.isArray(body.answers)`。RC1 `packages/interaction/user-questions/src/index.ts` 直接返回 waterfall 结果；`packages/interaction/tool-ask-user/src/index.ts` 随后执行 `result.answers.map(...)` 和 `[...answer.selected]`。
- **影响**：`answers: [{}]` 可以进入宿主结算，之后工具展开缺失的 `selected` 时抛异常；问题已结束，用户不能修正原回答后重试。Gateway 的通用结果解析不能代替问答字段校验。
- **建议**：保留原问题结构，在结算前校验每项答案的类型、问题 ID、选项和多选约束，以及自定义回答的契约；非法答案返回明确 400，保持原问题待答。
- **补测**：缺失或非数组 `selected`、未知/重复问题 ID、非法选项、单选提交多个选项、合法自定义回答；拒绝非法结果后可再次正确回答。该项当前为源码证据，尚无真实宿主负向测试。

### R4 [WARNING] 主动取消与运行中止的语义混淆

- **位置**：[lib/index.js](../lib/index.js) 的 `respondRemoteWaterfall`（1200）。
- **证据**：插件主动取消问题返回 `ASK_ABORTED`。RC1 `packages/client/ui-user-questions/src/client/contract/slots.ts` 中，`PendingQuestion.cancel()` 使用 `ASK_CANCELLED`，AbortSignal 中止使用 `ASK_ABORTED`。
- **影响**：同一用户动作在电脑和手机上被宿主记录为不同结果，消费错误码的逻辑无法正确区分用户关闭与运行中止。
- **建议及补测**：主动关闭问题对齐 `ASK_CANCELLED`，保留宿主中止的 `ASK_ABORTED` 语义；分别验证手机取消、电脑取消和宿主中止。审批继续按其独立 outcome 契约验证。

### R5 [WARNING] RC1 队列实时同步缺少事件转换

- **位置**：[lib/index.js](../lib/index.js) 的 `onSessionEvent`（1324）和旧 mux `session/queue` 分支（3516）；[App store](../dsh-mobile-app/lib/store.dart) 的 `mobile/queue` 处理。
- **证据**：启用 RC1 后旧 mux 被停用；`onSessionEvent` 虽转发通用会话事件，但没有把 `agent/inbox/spliced` 转为 App 队列镜像使用的 `mobile/queue`。RC1 的 `packages/api/session-controller/src/control.ts` 以该 inbox 事件更新队列控制视图，App 当前也没有对应 inbox 事件处理。
- **影响**：电脑端编辑、删除队列或内核消费队列后，手机可能继续显示旧队列，直到其他操作触发补拉。端点可以读取空队列不能证明此行为通过。
- **建议及补测**：为 RC1 inbox 变化补充队列快照转换，沿用 `queueRowsOf` 合并插件持存项；验证电脑编辑/删除、内核认领、手机修改和持存项释放后的实时一致性与去重。当前为源码证据，尚未做真实跨端复测。

### R6 [WARNING] 新结算路径依赖私有方法，诊断未覆盖

- **位置**：[lib/index.js](../lib/index.js) 的 `remoteGateway.dispatchRpc` 调用（1214）和 `hasRc1EventBridge`（1070 起）。
- **证据**：RC1 `packages/api/gateway/src/index.ts` 将 `dispatchRpc` 声明为 `private async`。当前桥接诊断检查 `invoke`、流控制器和 `clientId`，不检查结算方法；启动成功不曾执行回答路径。
- **影响**：报告误把私有实现当公共契约，且 `respondBridge: true` 不能证明结算函数存在或调用成功。该依赖本身不证明精确 RC1 版本一定失败，也不能据此推断未来版本必然失败。
- **建议**：集中封装该私有实现依赖，明确限定适配版本，增加方法可调用性探测与明确不可用错误；诊断应区分流连接状态、结算方法可用性和实际闭环证据。评估公共入口时不能退回已知会 401 的裸 HTTP 路径。
- **补测**：方法不存在、失败 envelope、实际成功结算、重复提交、已结束事件的幂等结果；至少完成真实宿主问询和审批各一次闭环。

### R7 [已修复，RC1 Web 定向验证] profile 旧内核依赖覆盖新宿主，首轮读取 length 失败

- **实际症状**：创建及发送均返回 200，随后 `turn/end.reason` 为 `error`，消息为 `Cannot read properties of undefined (reading 'length')`。与 R1 的配置接口异常不同，本次错误发生在 Agent 组装系统提示阶段。
- **调用栈证据**：在已安装宿主的 `dsh-agent-loop/lib/index.js` 异常处理处设置临时调试断点，捕获 `effectiveSandboxMode → SandboxPolicyService.overrideOf → resolve → systemPrompt.assemble → ReactLoopAgent.preStep`。首个栈帧指向 **profile 内**的 `dsh-sandbox-policy/lib/index.js:40`，其 `overrideOf` 仍传入 `session.events`。断点及调试端口已关闭，未修改宿主源码。
- **安装证据**：全局宿主为 `0.1.2-rc.1`，profile 锁文件却保留 `dsh-sandbox-policy@0.1.0-rc.6` 和 `dsh-credentials@0.1.0-rc.6`。前者是此次抛错的直接来源。插件把内核包列为普通依赖，宽版本范围允许包管理器继续复用旧锁定版本；此前安装说明中“应优先复用宿主”没有机制保证。
- **修复**：三个内核包 `dsh-credentials`、`dsh-llm`、`dsh-sandbox-policy` 改为 `peerDependencies`；保留 DSH profile 的 `nodeLinker: hoisted`、`autoInstallPeers: false`，通过宿主维护的模块回退目录解析。完整备份真实 web profile 后，移除此前临时显式安装的 `dsh-llm` 声明，执行 `pnpm install --offline --ignore-scripts`，确认三个 profile 副本均已移除，再重启。未改鉴权配置、配对信息或沙箱权限。
- **回归**：新增 `node tools/verify-rc1-first-reply.mjs`（口令仅由环境变量提供），修复前断言复现同一错误、退出 1；修复后 `create → send → assistant/message → completed`，退出 0。另对重启前已失败的独立测试会话验证 cold send，得到 `session-resumed`、非空回复和正常结束。测试会话均已归档。
- **影响与边界**：首轮脚本调用真实模型，运行于宿主本机；不代替 Android UI、问询/审批、旧 Host 或其他第三方插件验收。peer 变更依赖 DSH 的 profile 安装方式，不应在任意目录自动安装一套内核包。旧安装需迁移锁文件；其他插件引入的旧依赖不能靠本插件声明自动修复。

## 6. 本轮检查、证据边界与验收顺序

| 检查 | 结果 | 证明范围 |
| --- | --- | --- |
| `node tools/verify-rc1-adapter.mjs` | 通过 | 静态映射断言，包括删除 `goal.block` 映射及丢弃 `goal.pause` 的 `reason` |
| `node --check lib/index.js` | 通过 | JavaScript 语法 |
| `git diff --check` | 通过 | 已跟踪改动的空白格式；不验证运行时行为 |
| R1 原函数 + RC1 形状对象 | 复现异常；修复后适配器断言通过 | 记录旧实现缺陷及当前兼容层；未实例化真实 Session |
| R2 原函数 + Gateway 行为替身 | 复现残留及本地结算 | 插件重连状态处理；未执行真实双端连接 |
| 修复后的真实宿主问询/审批闭环 | 未执行 | 不能认定出站已通过 |
| 真实 RC1 定向 live route | 通过 | `/session-config`、`/history`、`/usage` 均 HTTP 200；不覆盖完整内容、分页或 Android |
| RC1 dormant send | 通过 | 初次只验证接受回执；R7 修复后另验证冷会话恢复、非空模型回复和正常轮次结束 |
| 无 model / App 参数创建配置 | 通过 | 两种创建方式返回配置均含 `model/provider/reasoningEffort`；R7 修复后增加无 model 默认创建的完整首轮回复 |
| R7 首轮回归脚本 | 修复前失败、修复后通过 | 真实 web profile、RC1、Linux；必须收到非空回复及 completed，HTTP 200 不足以通过 |

本次对照的是本地 RC1 源码副本 `/tmp/dsh-src-rc1-new`，关键上游相对路径已列于各发现；该临时路径不是仓库依赖。新增定向运行时检查使用已安装的 DSH 0.1.2-rc.1 Web CLI/Linux profile，但尚未补齐宿主制品校验值、双版本矩阵或 Android 证据；前轮宿主记录、定向运行时检查与源码/函数测试不得合并标为完整 E2E 通过。

R1 已修复并恢复配置、历史、用量和冷会话投递的定向能力；R7 修复后默认模型首轮及冷会话回复已通过。下一步应完成 R3/R4/R6 的问询与审批结算，随后覆盖 R2 双端竞态和 R5 队列同步。最终仍按 [T01–T19 验收记录](rc1-t01-t19-verification.md) 执行两版本及 Desktop/Web、Windows/WSL 要求；静态映射通过和空端点可读不代表完整兼容。

`goal.block` 映射移除及 `pause/resume/complete/clear` 参数精简与所审 RC1 源码一致。本轮未发现这部分未提交改动的新增缺陷；目标的创建、暂停、恢复、完成等真实行为仍待验收。

## 7. 变更清单

| 文件 | 变更 |
|---|---|
| `lib/index.js` | `respondRemoteWaterfall` 结算改用 `remoteGateway.dispatchRpc`（进程内），替代旧 HTTP `apiRpcTransport`；冷会话发送优先调用注入的 `sessionController.prompt`，Gateway 作为回退 |
| `lib/rc1-adapter.js` | 移除 `goal.block` 映射；`goal.pause/resume/complete/clear` 去掉 `reason` 字段；新增 RC1 事件读取与冷会话发送路由 |
| `tools/verify-rc1-adapter.mjs` | 新增 `goal.pause` 丢弃 `reason`、`goal.block` 抛 `rc1-method-unmapped`、事件读取和发送路由断言 |
| `package.json` | 三个 DSH 内核包改为宿主提供的 peer 依赖，避免旧包覆盖新宿主 |
| `tools/verify-rc1-first-reply.mjs` | 新增真实模型首轮回归，失败与成功均归档测试会话 |
| `tools/verify-rc1-live-routes.mjs` | 新增真实 RC1 活跃会话配置/历史/用量定向回归 |
| `dsh-mobile-app/lib/screens/chat_screen.dart` | RC1 prompt 无 `messageId` 时保留未绑定状态，交给 SSE/历史回显合并 |
| `docs/rc1-respond-settle-review.md` | 本记录 |
