# 0034 组折叠状态归属 widget 层，不做数据层身份迁移

状态：已接受（2026-11-18）。实现追踪 GitLab #122、#123。关联：ADR 0029（工作步骤四档）、#108（四档语义）。

## 背景

过程段内的「工具组」可以逐组折叠。该状态曾维护在数据层（`ProcessFoldState`，一张 `key → bool` 的全局 map），键是 `段键:step`。为了让这张 map 在「段/组的键发生变化」后仍能命中，实现逐步长出一套**身份迁移**逻辑。

问题是这个键不稳定，而每一版迁移都以下一个更稳的量为身份，逐版翻车：

| 版本 | 迁移身份 | 失效原因 |
|---|---|---|
| v1 | 工具行的 `seq` | `tool/result` 先到会把 `reportedSeq` 置为 result 的 seq，随后到达的 `tool/call` 无条件覆盖为 call 的 seq |
| v2 | `(段键, step)` 精确匹配 | `tool/result` 可以缺 `step`，补页的 `tool/call` 带来 `step` 后组键从 `…:x` 变 `…:<step>` |
| v3 | 组内成员令牌重叠（`tool:<callId>` / `think-step:<step>`） | 新旧键空间重叠时，合并阶段的 `containsKey` 把「另一个旧组占用的键」误认作「目标已有状态」，清理阶段又删掉刚写入的键 |

外部独立复核还发现更底层的事实：

1. **同一个键可能对应多个组**：`ProcessSegment.groups` 按 step **连续**聚合（`turn_process.dart:657`），合法序列 `step=1,2,1` 会产生两个 `step=1` 的组，而 `groupKeyOf` 只拼 `段键:step` → 键不唯一。这直接使「按 key 索引的迁移」失去定义基础。
2. **段的 `step` 可以被后到事件补上**（`if (step != null) tool.step = step`），这不是理论边界。

三轮实现 + 两轮规则文档，均被判定不可交付。复杂度（300+ 行迁移逻辑）已明显超出它要解决的问题。

## 决定

### 1. 组折叠状态归属 widget 层，不做数据层身份迁移

`_ProcessGroupHeader` 从 `StatelessWidget` 改为 `StatefulWidget`，由组件自身持有展开状态；调用方只提供**身份键**与**默认值**：

> 「不做数据层迁移」的准确含义是：不做**身份映射**（match / classify / migrate / 指纹）。
> 数据层仍保留一份「用户选择缓存」，理由与边界见 §8——它不参与任何映射计算。

```dart
_ProcessGroupHeader(
  key: ValueKey(identity),
  defaultExpanded: <由档位决定>,
  ...
)
```

Flutter 的 reconciliation 负责其余部分：

- `ValueKey` 相同 → 复用同一个 `State` → 用户的手动状态保持
- `ValueKey` 不同 → 销毁旧 `State`、创建新 `State` → 状态回落到 `defaultExpanded`

**不存在「迁移」这一步**：状态跟着组件实例走，不跟着数据键走。

### 2. 这与 DSH 本体的做法同构

DSH web 的组折叠就是组件局部状态，没有迁移逻辑：

```ts
// packages/client/ui-chat/src/client/chat/use-disclosure.ts:11-17
export function useDisclosure(version = 0) {
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null)
  const expanded = expandedVersion === version
  ...
}
```

工作区列表的折叠状态同样是「用户展开过的 key 集合」，读取时逐项 `has`，组出现/消失都不需要额外处理（`packages/client/ui-workspace/src/client/tree.ts:118,450`）。其键取自 `workspaceId` 这类 durable 业务身份，因此连「重置」都不需要显式设计。

本仓库的一部分（`ChatScreen` 的过程段/组）没有内核下发的 durable 组 id，所以采用「组件实例即身份」这一更保守的等价形式。

### 3. 组身份的三级取值规则

`identity` 按以下优先级取第一个可用值：

| 条件 | identity |
|---|---|
| 组内含工具行 | `tool:<组内首个工具行的 callId>` |
| 组内无工具行、有 step | `think-step:<step>` |
| 组内无工具行、无 step | `think-null:<段键>:<组内序号>` |

**为什么需要第三级**：null-step 的纯思考组如果统一用 `think-step:null`，同一段内所有这类组会撞同一个 identity，导致「展开一个，全部展开」。第三级用段键 + 组内在该段中的序号兜底——序号不稳定（补页可能插入更早的组），但**不稳定只会导致回落默认**，不会串组。

`ProcessRow` 已暴露 `callId` 字段（`turn_process.dart:324`），无需额外改造数据层。

### 4. `resetVersion` 保留接口，**恒为 0**

widget 的状态机保留一个 `resetVersion` 形参（对应 DSH 的 `version`）：

```dart
class _ProcessGroupHeaderState extends State<_ProcessGroupHeader> {
  int? _expandedVersion;   // null = 用户从未手动操作
  bool get _expanded => _expandedVersion == null
      ? widget.defaultExpanded
      : _expandedVersion == widget.resetVersion;
}
```

但**当前没有任何来源推进它**，实现中恒传 `0`（`chat_screen.dart:7819`）。实际效果：

| 用户状态 | 档位切换后 |
|---|---|
| 从未手动操作过（`null`） | 跟随新档位的 `defaultExpanded` |
| 手动操作过 | **保持用户选择**（不因档位切换而回落） |

**这是有意的**：用户的显式操作优先级高于档位默认值。用户既然手动展开/收起过某个组，就不应因切换展示档位而被覆盖——否则用户会感到「我的选择被系统改掉了」。

保留 `resetVersion` 接口而非直接删掉，是为了将来若出现「必须让手动状态失效」的确定场景（例如某个开关要求重置全部折叠态）时有明确落点，而不必临时改造状态机。

**与 DSH 的差异**：DSH 的 `useDisclosure(version)` 中 `version` 由「seat 被 Turn 隐藏」推进，属于「组件即将被销毁前主动作废旧状态」；本仓库当前没有等价需求，故不推进。

### 5. 段级折叠保留数据层迁移

段键用 `ProcessSegment.boundarySeq`（开段插话的持久 seq，轮首段为 `head` 哨兵）。该值是 durable 的——与行内容、reasoning seq、历史正/倒序无关——因此段级的迁移逻辑保留。

组级与段级的区别是**有无 durable 身份**，不是实现风格偏好。

### 6. 两个视图不共享组状态

`ChatScreen` 有 live 与历史两棵独立的 sliver 树（`historyView: false` / `true` 分别 build）。同一个组在两边 `identity` 相同，但**widget 树位置不同，`State` 不共享**，因此：

- 在 live 视图展开某组 → 上翻进入历史视图 → 该组回落到 `defaultExpanded`
- 反之亦然

**这是有意接受的**：要共享就得把组状态搬回数据层，那正是本 ADR 否决的路径。用户可感知的影响是「跨视图切换时组折叠状态不连续」，不构成数据错误。

### 7. 段收起时组状态随之销毁

段收起后其组 widget 被移出树 → 组 `State` 销毁 → 组状态丢失；段重新展开时回到 `defaultExpanded`。

**这是 `StatefulWidget` 生命周期的自然行为，不做额外处理。** 不为此引入「段收起时暂存组状态」的机制——那等于在数据层重建一份组状态。

### 8. 保留一份「用户选择缓存」，但它**不是**身份映射

数据层保留 `Map<String, bool> _groupUserExpanded`（identity → 用户显式选择）。这是本 ADR 允许的唯一数据层组状态，因为两个需求无法只靠 widget `State` 满足：

**理由 1：列表回收会销毁 `State`**

对话列表懒构建并回收离屏项（无 `cacheExtent` / `keepAlive` 配置）。用户收起某组后向下滚动几屏，该组 widget 被回收 → `State` 销毁 → 滚回来时新建 `State` → 回到档位默认。这是 `StatefulWidget` 生命周期的必然结果，不是实现缺陷。

**理由 2：计划层计算早于 widget 构建**

`visibleToolCallIds`（`chat_screen.dart:7460`）在渲染前、由数据层派生出「哪些工具行的组当前可见」，供活动条去重（`:5801-5831`，`issue84` 覆盖）。数据层计算时 widget 尚不存在，拿不到 `State`。

**它与被否决的迁移的本质区别**：

| | v1–v3 迁移 | 本缓存的 |
|---|---|---|
| 计算旧→新身份映射 | 是（match / classify / migrate） | **否** |
| 快照、指纹、触发条件 | 是 | **否** |
| identity 变化时 | 尝试迁移，出错即串状态 | **直接视为新组，取档位默认** |
| 代码量 | 300+ 行 | 数个读写点 |

**它只是缓存，不是映射。** 最坏情况是「identity 变了导致缓存未命中 → 回落默认」，不会串到别的组。

**护栏**：这张表只能有 `identity → bool` 的读写，**不得**引入快照、指纹、匹配或迁移。若将来有需求要以这张表为基础做迁移，说明本 ADR 的前提被推翻，应先回到 §「未采纳的替代方案」重新论证。

### 9. 接受「identity 变化时状态回落默认」

组身份在某些场景（例如补页把更早的 `tool/call` 插到组首）会变化。此时状态回落到 `defaultExpanded`。

**这是有意的取舍**：契约从「任何重建后都保持手动状态」放宽为「身份不变时保持」。

## 后果

### 收益

- 删掉全部组级迁移逻辑（`_groupManual` 的组部分、组指纹、`_migrateGroups` 及其冲突规则）
- **失败模式变安全**：身份变化时「回到默认」，而不是 v1–v3 那样的「串到别的组」或「静默丢失」
- 与框架设计意图一致：Flutter 的 `State` + `Key` 本来就是为「跨重建保持局部状态」设计的，此前是在数据层重复实现了一遍
- 新增组级状态不再需要设计身份规则

### 代价与约束

- **`#122` 验收第 65 行的严格语义被放宽**：「该组仍保持用户设定的状态」现在只在身份不变时成立。此放宽已由维护者确认，验收文本需同步更新（见下）。
- **三处状态不连续是预期行为，不是缺陷**：
  1. `identity` 变化（如补页把更早的 `tool/call` 插到组首）→ 回落 `defaultExpanded`
  2. live 视图 ↔ 历史视图切换 → 组状态不共享，回落 `defaultExpanded`
  3. 段收起再展开 → 组 `State` 已销毁，回落 `defaultExpanded`

  三者的共同点：**只丢失「用户手动状态」，从不串到别的组**。区分这一点很重要——将来收到「折叠状态丢了」的反馈时，应先判断属于哪一类，而不是直接加迁移。
- 组身份的选择仍然重要：它决定「什么时候算同一个组」。取值规则见 §3；不稳定时的表现是状态回落默认，不构成串组或数据错误。
- **禁止重新引入组级迁移**。若将来出现「必须跨身份保持」的强需求，应先证明存在 durable 的组身份，再讨论迁移；不得以「加一层匹配」的方式回到 v1–v3 的路径。
- 段级迁移与组级状态现在分属两层，理解成本需要注意：段状态在 `ProcessFoldState`，组状态在 widget `State`。

### 需要同步更新的验收文本

`#122` 验收第 65 行原文：

> 同一轮内展开/收起某个工具组 → 插入一条真人对话 → **该组仍保持用户设定的状态**（不自动展开、不串到别的段）；

应改为：

> 同一轮内展开/收起某个工具组 → 插入一条真人对话 → 若组身份未变则保持用户设定的状态；若身份变化则回落该档位默认值。**任何情况下不得串到别的段/组。**

### 不受影响

- 四档语义（ADR 0029）、段的折叠与摘要行、分批（`processBatchSize`）、轮次导航均不变。
- `segmentKeyOf` / `groupKeyOf` 仍用于**渲染键**（段收起行的 `ValueKey`、组抬头的观测 key），只是不再承载「状态身份」的职责。

## 未采纳的替代方案

**继续加固数据层迁移（v4 规则文档路线）**。规则文档两轮复审共暴露 5 项阻断：组键不唯一、段/组匹配语义互相矛盾、`classify` 对旧独有键误判、原型验证不成立（只打印不抛异常、未独立断言不变式）、段级规则不完整。其中「组键唯一性」需要改动渲染键与历史兼容才能解决，属于显著扩大改造面。放弃。

**补页后重置全部手动状态并提示用户**。实现最简，但直接违反 `#122` 验收第 65 行，且用户已展开的内容会无提示地收起，比「身份变化时回落」更差。未采纳。

**给组分配内核级 durable id**。这是最彻底的方案，但需要宿主侧配合下发，超出本仓库范围。

## 验证

### 1. 方案前提：`State` 实例复用

必须先独立验证 Flutter 的 reconciliation 行为，**判据是 `State` 实例本身，不是 UI 上的展开状态**：

| 场景 | 期望 |
|---|---|
| 重建，`ValueKey` 相同 | 复用同一个 `State` 实例（可用实例计数器/`debugState` 断言） |
| 重建，`ValueKey` 不同 | 旧 `State` 销毁、新实例创建 |

只看 UI 状态不足：UI 保持也可能来自「恰好重建后默认值相同」，无法区分「State 真的被复用」与「碰巧」。

### 2. 行为用例

- **点击**：展开/收起后保持；同一 identity 下重建仍保持
- **档位切换**：未操作过的组跟随新默认；操作过的组在同一世代内保持、跨世代回落
- **补页**：identity 不变 → 保持；identity 变化 → 回落 `defaultExpanded`，且**不串到别的组**
- **段级**：段折叠/展开、段级迁移不回归（`boundarySeq` 路径已通过复审）
- **跨视图**：live ↔ 历史切换后组状态不连续是预期行为，用例应断言「回落默认」而非「保持」
- **段收起**：段收起再展开 → 组回到 `defaultExpanded`（预期行为）
- **identity 三级规则**：混合组取工具 `callId`；纯思考组取 `step`；null-step 纯思考组取组内序号且互不碰撞

### 3. 门禁

`flutter analyze`、`flutter test`、隔离 `node --test`、timeline-contract、account-usage、Kotlin `UsagePanelModelTest`。
