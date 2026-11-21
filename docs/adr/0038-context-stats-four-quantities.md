# 0038 上下文统计四量分离

状态：**已接受（2026-11-21，方向）**，3.3.1 实施；关联：GitLab #158。

## 背景

手机输入区已显示上下文百分比；用户要求点开抽屉查看构成、Token 用量和会话统计。DSH 宿主有四个语义不同的数据源，不能合成一个“上下文用量”：

| 数据 | 宿主来源 | 语义 |
|---|---|---|
| 上下文占用 | `contextPressure`（pressureTokens/projectedTokens/contextWindow） | 最近 provider usage 与下一次请求估算，非同一请求原子快照 |
| 构成 | `contextBreakdown`（system/tools/message） | 启发式 token 估算，不可相加冒充占用 |
| 累计用量 | `tokenUsage`（uncachedInput/output/cacheRead/cacheWrite） | 会话累计 provider 桶 |
| 时延/TPS | `sessionStats`（turn/step/llm/tool/ttft/decode） | 整份会话累计，不是每轮 |

## 决策

### 1. 四量分开

- **占用**：`projectedTokens ?? pressureTokens` / `contextWindow`，百分数按约数展示；
- **构成**：`contextBreakdown`，标注“估算构成”，不参与占用计算；
- **累计用量**：`tokenUsage` 四桶；cache hit 率单独计算；
- **时延/TPS**：`sessionStats` 整会话累计；TTFT = `ttftMs/ttftSteps`，TPS = `decodeTokens/(decodeMs/1000)`，不声称 per-turn。

### 2. 新只读投影

`GET /m/api/context-stats?sessionId=...`，按块返回 `pressure` / `breakdown` / `tokenUsage` / `timing`，并带：

- `asOfSeq`；
- `sources`：每块来源（provider、heuristic、session-stats）；
- `estimated` 标记；
- 缺投影时省略字段，不返回 0 冒充“没有”。

旧宿主无投影时退回现有 `/usage` + `contextWindow`；构成/时延明确不可用，不伪造。

### 3. UI

- 输入区上下文百分比/长度 ≥44dp 可点击；
- 底部抽屉，三 Tab：**上下文构成 / Token 用量 / 会话统计**；
- 只显示聚合数字，不返回/展示 prompt、工具定义、正文、文件路径；
- 切换会话/发送后不串数据；旧宿主各 Tab 独立降级。

### 4. 数据口径

- `percent` 用 projected/pressure 与窗口计算，上限 100，标注估算；
- 不把 breakdown 三项相加当作 projected/占用；
- 不使用本地接收时间伪造 TTFT；
- 不用累计 TPS 冒充每轮 TPS。

## 后果

### 收益

- 用户能区分“当前窗口用了多少”“本会话累计用了多少”“构成估算”“速度/时延”；
- 不再把启发式估算伪装成 provider 精确值；
- 旧宿主可部分降级，不阻塞输入区。

### 代价与约束

- 需要新增宿主投影/端点；`contextPressure` 的 pressure/projected 可能非原子，切模型时短暂错配。
- `contextBreakdown` 对 CJK/JSON schema 有系统性偏差，必须标“估算”。
- `sessionStats` 只有整会话累计；每轮 TTFT/TPS 需要客户端折叠或后续宿主支持，本版不承诺。

### 拒绝

- 一个“context usage”数混合四量；
- breakdown 相加冒充占用；
- 用本地接收时间伪造 TTFT；
- 累计 TPS 冒充每轮；
- 返回 prompt/正文/工具定义内容。
