# 跨端接口契约（Lead 定稿，2026-10-20）

> 适用于 GitLab #35 / task-4（App）与 task-5（Node 下载面）。两侧都按本文件实现，任何改动必须先同步给 Lead。
> 设计依据：`app-carrier-design.md` §5.3 / §5.6 / §5.7 / §5.10。

## 1. bootstrap 新增字段（鉴权接口）

| 字段 | 形态 | 语义 |
|---|---|---|
| `currentRelease` | `{ releaseId: string, release: <schema1 快照> } \| null` | **当前发布**。`release.app.url` / `release.plugin.url` 必须是**手机可达的宿主固定绝对地址**；若是固定目标，`release`/`sha256` 查询参数由**宿主**拼好。App 只消费、不拼接。 |
| `currentReleaseHealth` | `{ state: 'confirmed'\|'waiting'\|'failed', runningContentSha256: string\|null, instanceId: string, transaction: { opId: string, generation: number }\|null } \| null` | 健康结果与运行身份分开报告；`confirmed` 不得在安装中/等待重启/回滚中给出。 |
| `updateTarget` | `{ releaseId: string, release: <schema1 快照> } \| null` | 用户选中、宿主已验证可解析的候选；不得把首装入口提前指向它。 |
| `appArtifact` | `{ state: 'ok'\|'missing'\|'mismatch', reason?: string }` | bootstrap 可选；`/api/diagnostics` 必须提供。reason 为稳定字符串，不含凭据与本机绝对路径。 |

兼容：`pluginUpdate.release` / `pluginUpdate.transaction` 保留，但**不作为新流程的权威**。

## 2. 稳定错误码（App 按码分流文案与行为）

| 码 | 含义 | App 行为 |
|---|---|---|
| `401 auth-not-configured` | **罕见**：口令生成或状态落盘失败（状态目录不可写等） | 专门文案：检查插件状态目录权限；不要显示成网络错误 |
| `401 auth-required` | 口令缺失或错误（空口令已自动生成 → 认证视为启用，这是普通 401） | 提示重新扫码（迁移期即此路径） |
| `410 app-artifact-expired` | 固定目标已过保留窗口 | 退出旧候选、提示重新检查；**不要**重定向到新版 |
| `503 app-artifact-not-ready` | APK 暂不可服务 | 保留目标、稍后重试 |
| `404 app-artifact-unknown` | 固定标识未知 | 退出候选、提示重新检查 |
| `400 bad-request` | 参数非法 | 不重试相同参数 |

## 3. 硬规则

1. App 只使用宿主下发的绝对地址；**不得**自行拼接或改写 query，**不得**回退到 GitHub 资产地址。
2. 固定目标身份 = `releaseId` + `appSha256`，两者都须合法且与宿主记录一致；宿主不得把固定目标替换为 current/latest。
3. 内部 worker 使用受信/回环定位；**不得**把手机可达地址写回内部事务。
4. 匿名例外只匹配精确的 APK 下载路由 + 方法 + 被校验标识；其它移动接口一律鉴权。
5. 口令为空时宿主自动生成（存插件状态，不写用户 profile 配置），经本机特权入口下发到连接二维码。
6. 空口令 ≠ 关闭认证：宿主自动生成即视为启用；普通无 token 请求返回 `auth-required`，`auth-not-configured` 仅表示生成/落盘失败。
