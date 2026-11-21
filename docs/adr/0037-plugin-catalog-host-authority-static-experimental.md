# 0037 插件目录以宿主为权威、实验性用版本化静态表

状态：**已接受（2026-11-21，方向）**，3.3.1 实施；关联：GitLab #153、#107/#145/#146/#147。

## 背景

用户要求手机端对齐 DSH Web 主页面插件管理（不是设置页内置插件清单）：安装、搜索、分类、一键检查全部更新。

调研当前 DSH Web 插件管理器后确认：

- 主页面实际分组为 **内置插件配置 / 实验性插件 / 已安装插件**；
- “实验性”不是 `BundleInfo` 字段，而是 `@deepseek-ai/dsh-official-bundles` 的 `EXPERIMENTAL_BUNDLES` 静态名单；
- 插件市场（Discover）是可选 `pluginMarket` bundle；已安装管理走 `pluginManager`；
- Web 主页面与 `Settings → Built-in plugins` 不是同一数据面，不能混用。

产品侧决定采用产品三分类：**内置 / 实验性 / 自定义**。

## 决策

### 1. 宿主是安装与目录的权威

- 已安装清单/生命周期继续复用 `pluginManager`（#145/#146/#147）；
- 发现/安装优先使用宿主可选 `pluginMarket` 的搜索、分类和 `MarketInstallTarget`；
- Remote 插件只做投影和事务发起，不自建 registry、不抓 Web HTML、不接收 App 任意 URL/tarball。

### 2. 产品三分类

| 分类 | 来源 |
|---|---|
| 内置 | `BundleInfo.official === true && optional !== true` |
| 实验性 | 命中 App/Remote **版本化静态 `EXPERIMENTAL_BUNDLES` 表** |
| 自定义 | 其他已安装 profile bundle（official optional、非官方、本地 registry/git 来源） |

- 静态表不得按包名前缀、`optional` 或名称猜测；未命中显示“未标注”，不伪造实验性。
- 静态表必须注明目标 DSH 版本/来源，随 DSH 升级评审更新；发布说明记录表版本。
- 分类、启用状态、更新状态、兼容性分别表达，不互相替代。

### 3. 搜索、安装、检查更新

- 已安装搜索可客户端过滤 title/description/packageName；发现搜索交给宿主市场索引。
- 安装只接受宿主解析后的目标：
  - 已安装清单的 `installTarget` → `installBundle`；
  - 市场条目 → `MarketInstallTarget` + `installBundle`；
- 安装确认、进度、失败回滚、需重启沿用宿主事务，不另造安装器。
- “检查全部更新”是逐插件 advisory 检查：串行/有界并发、失败隔离、可取消；不自动批量安装，更新逐项确认。
- Git 更新明确 `git-update-desktop-required` 等桌面端要求。

### 4. 降级

- 无 `pluginManager`：保留现有 inventory；
- 无 `pluginMarket`：发现入口显示“宿主未提供插件市场”，不返回可安装假项；
- 静态表与当前 DSH 版本不匹配：仍可展示分类，但标记 table version，并允许“未标注”兜底；不得把未知包强行归为实验性。

## 后果

### 收益

- 分类和安装来源可追溯到宿主权威字段；
- 复用现有生命周期/事务/回滚，安全边界不扩散；
- 产品三分类符合用户心智，实验性有明确名单。

### 代价与风险

- **静态表会漂移**：DSH 新增/移除实验性包时，App/Remote 需要同步更新；这是明确接受的维护成本。
- `pluginMarket` 是可选 bundle；不同宿主能力差异大，Discover 可能不可用。
- 批量检查更新会引发多次 registry/pnpm 查询；必须限流、可取消、失败隔离。
- 自定义分类的“来源”只显示 registry/local/git 类别，不暴露绝对路径。

### 拒绝

- 抓取 Web 页面；
- App 内置市场源或任意 URL/tarball 安装；
- 按包名前缀/optional 猜 Experimental；
- 自动批量更新；
- 把 Web 设置页内置插件清单当成主页面插件目录。
