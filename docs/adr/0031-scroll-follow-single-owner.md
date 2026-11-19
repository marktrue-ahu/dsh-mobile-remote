# 0031 滚动跟随收口单一 owner（ScrollFollowCoordinator）

状态：已接受（2026-11-17），实现追踪 GitLab #114；随 `3.2.4` 发布。关联：ADR 0018（移动端轮次导航）、ADR 0027（轮次过程与轮末产出物）、ADR 0029（工作步骤四档 v4）。

> 2026-11-19：§6 的嵌套滚动由 **ADR 0035** 细化——允许“固定上限 + 内容溢出才滚动”的内层滚动，但必须保留 `depth != 0` 过滤；ADR 0035 明确不做边缘滚动交接。短内容顶对齐、删除底部占位的决策也在 ADR 0035；本 ADR 的意图/几何/世代/单一 owner 语义不变。

## 背景

手机聊天页的「内容是否跟着最新消息走」在 #52/#77/#89/#103 四轮修复中，逐步累积为**六处分散状态**加若干补丁式回调：

```dart
bool _pinnedToBottom;          // 是否钉住底部
bool _userDragActive;          // 用户是否在拖拽
bool _followBottomScheduled;   // 是否已排队贴底
bool _settledFollowScheduled;  // 是否已排队多帧收敛
int  _lastContentCount;        // 上次条目数（用于判「内容是否增长」）
void _settleToBottom(int)      // 固定 4 帧的收敛循环
```

这些字段各自被不同的调用点读取和改写，没有任何单一处能回答「当前意图是什么、谁改了它」。后果是三类**互相掩盖**的缺陷，且长期未被测出。

#114 按「先复现、再定位、后修复」推进，阶段 A 用真实 ChatScreen 动态回放（逐帧采样 `intent` / `tailResidual` / `anchorResidual` / `rangeError`）复现出三个真实缺陷：

| 编号 | 现象 | 实测 |
|---|---|---|
| A1-1 | 打开长会话，初始定位落在懒估值外的大块空白 | expanded30 首帧末端残差 **+79092px**，靠 ScrollSpringSimulation 需 **83 帧**才收敛 |
| A1-2 | 帧后校正被「饿死」 | 增长帧后在 post-frame 相位再注册 post-frame 回调，而该相位**不调度帧**；此后无帧源，`jumps` 停在 1 |
| A1-3 | 刚开始上翻的前 160px 内被已排队校正抢回 | 拖 96px 后 `pixels 599→820`、`anchorResidual=-245`、滚动 activity 由 `DragScrollActivity` 变 `IdleScrollActivity` |

阶段 A2 用临时补丁逐一验证根因，并证明「三行改动即可让行为集合通过」——但随后明确**不把这 3 行当最终修复**，因为它会成为 issue 自己警告的「第四套并行补丁」。

## 决策

### 1. 意图、几何、拖拽、世代、待执行校正收口为一个 owner

新增 `dsh-mobile-app/lib/scroll_follow.dart`（`ScrollFollowCoordinator`，447 行，**零 import，不依赖 Flutter**），把五件事收口：

- **意图**（`FollowIntent.followLatest` / `reading`）
- **几何事实**（`ScrollGeometry`：pixels / min / max / viewport，派生 `distanceToEnd`、`rangeError`）
- **用户拖拽**（只由带 `dragDetails` 的真实手势驱动）
- **会话与导航世代**（`generation`）
- **待执行校正**（`ScrollCorrection`，带 reason / budget / generation）

`chat_screen.dart` 删除上述六个字段与 `_settleToBottom`，只保留只读测量入口（`@visibleForTesting`）。

### 2. 三条不变量作为 owner 的性质

| 不变量 | 落点 | 对应缺陷 |
|---|---|---|
| **延后校正自己保证有帧** | `_book` 合并 → `_ensureFrameBooked` → 注入的 `ensureFrame`（生产实现为 post-frame + `ensureVisualUpdate()`）；有界预算、收敛即停、无空闲自激 | A1-2 |
| **校正执行时重查意图** | `takeCorrection` 依次检查 disposed → generation → dragging → intent → converged；用户手势立即 `cancelPending` | A1-3 |
| **强制定位统一有界收敛** | `_load` / `_backToLive` / `_send` / 显式回底全部走 `requestForcedFollow`，跳到懒估值后布局完成再校正一次 | A1-1 |

### 3. 意图判据改为「真正到底」

原本用 160px「接近底部」同时承担两种语义，互相污染。现拆分：

- **意图判定**：`|distanceToEnd| <= 1`（越过末端同样算）——只有**真正到底**才恢复跟随
- **派生展示**：160px 只服务回底按钮 / 刻度轨 / 活动条去重

维护者明确要求的用户语义：

> 用户拉到最底部就钉在最底部，有新消息就滚动，对话消息始终钉在最底部。如果用户上翻消息历史，则取消钉在最底部，有新消息就向下延长。

### 4. 阅读态始终显示回底入口

回底按钮显隐从 `!nearBottom` 改为 `intent == reading || !nearBottom`。

理由：意图判据改为「真正到底」后，用户停在距底 100–160px 处松手会是 `reading`，但按 160px 阈值按钮会**隐藏** —— 用户既不被跟随、也看不到恢复入口。这是产品死角，不是实现细节。

### 5. 几何不得反写意图

明确禁止「由 pixels 移动方向推断意图」。曾有一版实现加过「无拖拽时 pixels 向顶部移动 → 转阅读」，用纯 Dart 探针可证明它会在程序性滚动后把 `follow` 改成 `reading`（`correction=null`、`cancelledByIntent=1`）。

真实布局探针在 3 类变化下（expanded 档 turn/end 详情骤缩、视口 390×600↔390×844、活动条显隐）统计「会被误判」次数均为 **0**——该规则的唯一可触发场景是测试里的程序性 `jumpTo`。**为让测试通过而给产品加意图推断规则是反向的**：应把测试改为真实手势驱动。

### 6. 嵌套滚动按 depth 过滤

`_onLiveScroll` 与 `_onLiveScrollMetrics` 入口加 `if (n.depth != 0) return false;`。

内层 `SingleChildScrollView`（展开的工具卡正文等）位于 `CustomScrollView` 子树内，其 `ScrollEnd` 会冒泡并被当作**外层用户手势结束**，按内层几何改写主列表意图。

### 7. 生产与测试穿同一 seam

owner 是纯 Dart，策略/调度层可独立单测（27 条）；widget 层用真实 ChatScreen + 真实 RenderObject 测量，不在测试里复制算法。

## 后果

### 收益

- 三类缺陷从「靠补丁掩盖」变为「由 owner 的不变量保证」；
- 意图变更来源可追踪（`cancelledByUserCount` / `staleGenerationCount` / `followJumps` 等只读探针）；
- 策略层可单测，不必每次验证都走 widget；
- 修掉了一个长期存在的**测试有效性**问题：A1-1 的大块空白被既有测试的 `pumpAndSettle` 掩盖，A1-2 被测试自己泵帧掩盖。

### 代价与约束

- **`lib/scroll_follow.dart` 是纯 Dart，禁止 import Flutter**——一旦引入 `BuildContext` / `ScrollPosition` 等类型，策略层单测就失效，seam 也随之消失。
- **owner 不得自己调用 `jumpTo`**：它只产出 `ScrollCorrection` 决策，由生产适配层执行。这样「谁移动了视口」始终只有一个入口。
- **新增的延后路径必须走 `_ensureFrameBooked`**，不得直接 `addPostFrameCallback`——A1-2 的根因就是漏了这一条。
- **`ensureFrame` 的实现必须在 post-frame 相位也调度帧**（`ensureVisualUpdate()`）。仅注册回调不调度帧是原缺陷的本质。
- **禁止恢复「pixels 移动方向推断意图」**。若将来出现需要由几何恢复意图的场景，必须先补差分用例证明它非测试专用，再讨论。
- 既有测试 `issue74` / `issue80` / `issue89` / `turn_navigation` 已改为**真实手势驱动**。这些改动是产品语义变更的必要同步，不是放宽断言；后续不得为了让测试变绿而改回程序性 `jumpTo`。

### 未采纳的替代方案

**只上三行临时补丁**：A2 已证明「执行时守卫 + 补帧调度 + 初始 settle」三处改动足以让全部用例通过。但那是围绕既有六字段结构打补丁，会让分散状态继续存在，成为第四套并行逻辑。选择重构为 owner。

**换列表结构 / 改 reverse / 一次性渲染全部历史**：A2 实验证明现有 center 懒列表配合「强制定位走有界收敛」即可满足验收，无需结构替换。故不在本决策内引入新列表依赖。

**放宽 160px 阈值到更小值**：治标。真正的语义是「真正到底」，阈值大小不改变「停在中间该不该跟随」的判断。

## 验证

- 正式门禁 5/5 PASS，`flutter test` **1513 例全绿**；
- A1 六条用例：修复前 3 红 → 修复后 6/6 全绿；A1-4/5/6 修复前后均为绿，作为对照；
- **12 项变异-变红对照全部实跑验证**（删 `ensureVisualUpdate` / 删请求级与执行级 dragging 守卫 / 删 generation 检查 / 删预算上限 / 删 owner `ensureFrame` / 意图判据改回 160px / 删 depth 过滤 / 删「仅用户 ScrollEnd 改意图」/ 删程序性滚动清拖拽态 / 按钮判据改回 `!nearBottom` / 重新引入像素逆推规则）；
- 独立审查者在隔离快照上复跑全量 1513/1513 通过，并独立复现 4 项变异变红。

## 残留风险（如实记录，未实证）

1. **`_autoCorrectionSettling` 删除无差分反证**。理论上存在「校正后延迟 max 收缩 + pending 已清 + 短列表」窗口内误触 `shouldLoadOlderFromScroll` 的可能（该函数不检查 `dragDetails`，只看 `delta < 0 && distanceToLeadingEdge < 80`）。方向分析确认路径存在但需同时满足三个条件，窗口窄；**未构造实验验证**。建议后续在 alpha 实机观察分页异常，或单独开 issue 做差分实验。
2. **`tailResidual` 口径**：测的是「最后已构建子项」到设计底部留白线的残差，不是普适的列表尾项定义。在 center 懒列表下与投影末端等价，换列表结构需重估。
3. **`debugPinnedToBottom` 命名**：实际代表意图（`isFollowing`），历史命名保留给阶段 A 测量层，建议后续加注释或更名。
4. **真机四档实机验收未做**：阶段 A 是 widget 层真实 RenderObject 测量，不是真机。真实 Android 滚动物理、惯性、手势竞技场需 alpha 实机复验。
