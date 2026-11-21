# 0036 连接档案身份与单活动多连接

状态：**已接受（2026-11-21，方向）**，3.3.1 实施前仍需 UI 细节与契约落地。关联：GitLab #152、#106、#153；#134（SSE 代理泄漏）。

## 背景

当前 App 只保存一份 `baseUrl`/`path`/`token`，token 在 SharedPreferences；`hostId` 只在 bootstrap 下发，SSE hello 不带宿主身份；会话缓存、草稿、通知 ledger、图片缓存、插件更新 journal 等大量 key 只按 `sessionId` 或全局单例存储。跨宿主时 `sessionId` 可能重复，直接切换会串数据。

用户需求是保存多个 DSH 宿主连接实例；本版范围已确认为：

- 保存多个连接档案；
- 同一时刻只激活一个宿主；
- 多宿主同时在线/同时收通知延后。

## 决策

### 1. 身份模型

- `profileId`：本地稳定 UUID，作为连接档案主键；新建/扫码/迁移时生成。
- `hostId`：宿主稳定 UUID，连接成功后从 bootstrap 绑定到档案；作为宿主身份，不因重启变化。
- `instanceId`：宿主运行实例，仅表示本次运行；不作为档案身份。
- `baseUrls[]`、`path`、`displayName`、`tokenRef`、`tlsPolicy`、`lastSeen/lastAppVersion/lastPluginVersion` 存在档案中；地址候选不跨档案合并。
- token 不进入身份字符串、不走日志、不进二维码回显。

### 2. 单活动连接 + staged switch

1. 用目标档案的独立探测客户端执行 bootstrap，不先改当前 `Api`；
2. 校验返回的 `hostId`：
   - 与档案已记录值不同 → 提示“宿主身份变化”，不静默继承 token/cache；
3. 探测成功后原子替换 `baseUrl/path/token/hostIdentity`；
4. 递增 `connectionEpoch` 与 `_refreshGeneration`，取消旧 SSE/重连/刷新/超时；
5. 清空当前会话 UI、能力位、agent 状态、pending 问询/审批、jobs、usage、图片缓存等；
6. 加载目标档案的会话缓存/选中会话/工作区/草稿；
7. 任一步失败保留旧活动连接，不删除档案、不进入半切换状态。

旧 SSE 迟到帧必须同时被 `connectionEpoch + generation + hostId` 门禁丢弃。

### 3. 缓存与通知命名空间

至少以下状态以 `(profileId, hostId)` + 原 key 命名空间隔离：

- session cache / selected session / workspace；
- drafts；
- git recent files；
- workspace image cache；
- plugin update journal / last update op；
- local notification ledger；
- attention/pending 状态。

通知只跟随活动宿主；首版不做跨宿主聚合、不在切换时把旧宿主通知当成新宿主通知。

### 4. 凭据与传输

- token 放 Android Keystore/安全存储；普通 prefs 只存非敏感元数据。
- 迁移：读取旧 token → 写 Keystore → 成功后清除旧 key；迁移窗口外不再读旧字段。
- 保持 `allowBackup=false`；token 不允许备份。
- 现有局域网 HTTP 档案迁移为 `http-private` 并保留“未加密”警告。
- 新建非私有地址默认 HTTPS；不提供全局证书校验绕过；证书 pin 可后续按档案配置。

### 5. 宿主侧身份

- SSE hello 增加 `hostId` / `instanceId`；旧插件缺失时 App 用 bootstrap 结果补，不因此断连。
- bootstrap 已有 `hostId` 保持不变；新增字段必须向后兼容。

## 后果

### 收益

- 语义清晰：档案是“本地连接配置”，`hostId` 是宿主，`instanceId` 是运行实例；
- 单活动连接显著降低 SSE、审批、通知、缓存并发复杂度；
- 切换事务化，失败不破坏当前连接；
- 多宿主通知需求可在未来基于 `(profileId,hostId)` 命名空间扩展。

### 代价与约束

- 所有使用 `sessionId` 作为缓存 key 的路径都要审计并迁移；漏一处就会串台。
- 旧插件无 SSE `hostId` 时需要 bootstrap 兜底；切换期间旧流可能晚到，必须保留 generation 门禁。
- token 迁移失败不能清旧值，否则会丢连接；迁移需可重试。
- 本版不做多宿主同时在线；通知/审批不跨宿主聚合。

### 拒绝

- 用 token 当连接身份；
- 用 `hostId` 当档案主键（连接前未知）；
- 首版多宿主并发；
- 默认允许公网明文；
- 把旧 `baseUrls` 合并到新档案。
