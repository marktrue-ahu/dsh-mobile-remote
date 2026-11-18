# 0034 组折叠状态：widget State + 用户选择缓存（照搬 DSH 的存在性过滤）

状态：已接受（2026-11-18）。实现追踪 GitLab #122、#123；关联 ADR 0029（工作步骤四档）、#108（四档语义）。

本文**替换本 ADR 的此前版本全文**，不与旧文本叠加：
- v1「数据层稳定键 + 身份迁移」：三轮实现均被复核判不可交付（详见 §1）；
- v2「按逻辑事务保守失效」草案：**已废弃**。独立复核量化了代价——50 次工具调用轮次会产生
  100 次失效（每次 +10 参数 chunk 为 600 次，真实注释写明单 step 可达 1000 chunk 时为
  50,100 次）；而详细档组**默认展开**，用户手动收起会被下一个普通事件重置回展开。
  **正确但不可用**，不作为本 ADR 的内容。

## 1. 背景

过程段按真人插话分割；段内过程组按 step **连续**聚合。旧组键 `段键:step` 对
`step=1,2,1` 不是单射（同一段内两个 `step=1` 的组会撞键），旧方案为「状态跨键保持」逐步
长出一套身份匹配与迁移逻辑，每一版都以下一个更稳定的量为身份，逐版翻车：

| 版本 | 迁移身份 | 失效原因 |
|---|---|---|
| v1 | 工具行的 `seq` | `tool/result` 先到会把 `reportedSeq` 置为 result 的 seq，后到的 `tool/call` 又无条件覆盖为 call 的 seq |
| v2 | `(段键, step)` 精确匹配 | `tool/result` 可缺 `step`，补页的 `tool/call` 带来 step 后组键从 `…:x` 变 `…:<step>` |
| v3 | 组内成员令牌重叠 | 新旧键空间重叠时，合并阶段的 `containsKey` 把「另一旧组占用的键」误认作「目标已有状态」，清理阶段又删掉刚写入的键；互换/链式两例全丢 |

结论：**组是动态投影，没有内核下发的 durable 组 id；不要试图为它做数据层身份迁移。**

## 2. 决定一：展开状态由 widget State 持有

`_ProcessGroupHeader` 是 `StatefulWidget`，展开状态存在自己的 `State`；调用方提供
**身份**与**默认值**：

```dart
_ProcessGroupHeader(
  key: ValueKey(identity),          // 身份（见 §3）
  defaultExpanded: <由档位/阶段决定>,
  persistedExpanded: <用户选择缓存的当前值>, // 见 §4
  resetVersion: 0,                   // DSH useDisclosure(version) 的等价钩子
  ...
)
```

Flutter reconciliation 负责其余部分：`ValueKey` 相同 → 复用 State（保持）；不同 → 新 State
（回落 `defaultExpanded`）。**没有「迁移」这一步。** 组内行由 widget 懒构建（仅展开时）。

## 3. 决定二：组身份（`groupIdentityOf`）

`turn_process.dart` 的 `groupIdentityOf(group, turn)`，按优先级取：

| 条件 | identity |
|---|---|
| 组内含工具行 | `$turn#tool:<组内首个工具的 callId>` |
| 无工具、有 step | `$turn#think-step:<step>` |
| 无工具、无 step | `$turn#think-seq:<组内首行 seq>` |

- **唯一性**：每行只属于一个组、组首行互不相同 ⇒ 同段内 `1,2,1` / `null,2,null` 这两种
  「同 step 多组」形状也不会撞 `ValueKey`（重复 ValueKey 会在 debug 构建直接断言）。
- **不保证稳定性**：补页把更早的行插到组首会改变 identity。此时旧 State 被销毁、新 State
  回落默认——**失败模式是「回到默认」，不跨 identity 污染**；但同一 identity 被不同
  逻辑组复用时可能误继承（见 §5）。这是本方案明确接受的代价。
- `resetVersion` 是 DSH `useDisclosure(version)` 的等价钩子；当前没有「同一 identity 下需要
  结构性重置」的来源，恒为 0。

## 4. 决定三：数据层保留一份「用户选择缓存」，照搬 DSH

### 4.1 DSH 原体（`packages/client/ui-workspace/src/client/stores.ts:99-105`）

```ts
setGroupExpanded: (d, key, expanded) => { d.groupExpansion[key] = expanded },

retainAccountKeys: (d, workspaceKeys) => {
  const retained = new Set(workspaceKeys)
  d.groupExpansion = Object.fromEntries(
    Object.entries(d.groupExpansion).filter(([key]) => retained.has(key)),
  )
}
```

**写入就是赋值；唯一清理是「只保留仍然存在的 key」。零迁移。**

### 4.2 本仓库的等价实现

- 存储：`Map<String, bool> _groupUserExpanded`（identity → 用户选择）。
- 写入：组抬头切换时 `_groupUserExpanded[identity] = expanded`（与 widget State 同步更新）。
- 清理：`_retainExistingGroupExpansions(existing)` ——
  `_groupUserExpanded.removeWhere((key, _) => !existing.contains(key))`。
- 用途只有两个：
  1. 列表项被回收（滚动离开缓存，State 被销毁）后重建时恢复用户选择；
  2. 计划层在 widget 构建前派生 `visibleToolCallIds` / provisional 放置（活动条去重，
     `issue84` 的「手动收起运行组 → 活动条恢复」依赖它）。

### 4.3 触发时机（不逐帧全量扫）

`existing` 集合在 **live 计划构建**时顺带收集：计划本来就要遍历所有轮次并计算
`segmentsOf`，这里对每个组取 `groupIdentityOf` 汇入集合，**零额外扫描**。
过滤本身只在 `_processVersion` 变化后执行一次（`_groupRetainVersion` 记录），
档位/展开态等 epoch 变化不会重复过滤。

**计划为空时不跳过过滤**：`_load` 的 `_items.clear()` 与重建在**同一个同步 `setState`
块内**（两者之间没有 `await`），不产生「旧列表已清空、新历史未到」的可渲染帧；因此
历史真的为空时 `existing` 为空 → 清空缓存是**正确结果**（否则陈旧选择会在同一 identity
再现时被误继承）。是否存在组由 `existingGroupIds` 判定，不看 `_items`——计划输入是
`[..._items, ..._olderItems]`，`_items` 为空不代表没有组。

### 4.4 明确不做的事（禁止回归）

- ❌ 不做**身份匹配**：不判断「这个 identity 是否对应同一个逻辑组」（那就是迁移）；
- ❌ 不做事务分类、危险/安全事务、保守失效、整轮清空；
- ❌ 不做视图访问世代；
- ❌ 不以行 seq / 成员重叠 / 指纹参与任何持久化判断。

## 5. 与 DSH 的唯一实质差异及接受的风险

DSH 的组键是 `workspaceId`：内核下发的 durable 业务 id，**同一个 id 不会对应另一个逻辑组**。
我们的 identity 是 `callId` 派生的等价物，**理论上可能被不同逻辑组复用**（例如同一
callId 集合在不同轮次/不同窗口位置重新组合成新组）：

- 极端情况下，新组可能「继承」旧组同一 identity 的用户选择（误继承）；
- 该风险**限于同一 identity 内部**：不影响其它 identity 的选择，不丢数据；但本组可能
  显示为错误的展开态；
- **接受该风险**，不为此增加身份校验或迁移逻辑（那正是 v1–v3 的老路）。

其余已知边界：
- 补页插行改变 identity → 旧条目暂时残留；**若该条目仍在缓存中**（即中间未执行过
  存在性过滤），后续 identity 变回旧值时它会被再次命中。若中间已过滤，旧条目已被删除，
  不会命中；
- 缺 step 的旧历史思考行用 `think-seq:<seq>` 兜底，seq 变则视为新组（回落默认）；
- 换会话时清空缓存（identity 只含 turn/callId，跨会话可能撞名；DSH 的 store 是
  账号/工作区作用域，这里是必要的隔离）；
- 缓存条目随存在性过滤回收，规模与「当前存在的组」同阶。
- **无法证明不存在所有未来异步竞态**：当前 `_items.clear()` 唯一出现在 `_load` 的同步
  重建块内（`:1978` 起），但新增异步路径可能引入中间态，届时需重新评估「空计划过滤」的
  前提。

## 6. 决定四：段级状态不变

段级折叠状态仍由数据层 `SegmentFoldState` 持有并沿用**段级身份迁移**：段键
`segmentKeyOf` 由 durable 的开段插话 seq 决定，只有 partial 窗口补入边界时的
`head → <seq>` 会变，迁移判据为成员身份令牌（工具 callId / 思考 step）。段级规则**不推广
到组**：组不做任何迁移，也不以段键做持久所有权。

## 7. 测试

- `issue123_d_plan_group_state_test.dart`：
  - D1 点击展开/收起 → 同 identity 保持；
  - D2 档位切换 → 未操作过的组跟随新默认；
  - D3 **不因普通工具事件重置**（与已废弃保守失效方案的关键区别）；
  - D4 存在性过滤：turn 数据移除后其 identity 条目被清理，且仍存在的轮次条目保留
    （证明不是整表清空）；
  - D5 真实空历史 → 空帧 → 同 identity 再现 → 回落默认（缓存确被清、不继承）；
  - D6 慢历史响应 → 请求等待期旧选择保留（不得因请求未回就清空）。
- 身份/段级：`issue123_fold_state_migration_test.dart`（段级迁移 5 例 + 组身份唯一性 5 例）。
- 既有回归：`issue122_*`（契约 + widget）、`issue123_p2_*`（补页四路径）、
  `issue84`（活动条去重）、`issue79`/`issue75`（段级折叠）。
- 变异反证：去掉存在性过滤 → D4 红；把过滤换成「结构变化清空」→ D3 红（并示明 D3 锁住
  的正是本 ADR 与 v2 草案的分界）。

## 8. 参考

- DSH：`packages/client/ui-workspace/src/client/stores.ts:99-105`（`setGroupExpanded` /
  `retainAccountKeys`）；`packages/client/ui-chat/src/client/chat/use-disclosure.ts:11-17`
  （`useDisclosure(version)`）；`packages/client/ui-workspace/src/client/tree.ts:118,450`
  （`expandedGroups` 集合 + 逐项 `has`）。
- 本仓库：`turn_process.dart`（`groupIdentityOf`、`SegmentFoldState`）、
  `chat_screen.dart`（`_ProcessGroupHeader`、`_groupUserExpanded`、
  `_retainExistingGroupExpansions`）。
- 历史：GitLab #122、#123 的审查记录（v1–v3 失败复盘、v2 草案的代价量化）。
