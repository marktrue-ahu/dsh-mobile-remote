# Git 能力采用 DSH 服务接缝

Status: accepted

Git 能力按 Service Definition、Provider、Consumer 三个角色分离：独立且稳定的 Git Service Definition 拥有服务键、类型和语义；一个或多个 provider 实现仓库事实与操作；dsh-mobile-remote 作为 consumer 把服务投影为移动 API；Flutter 只消费移动契约。项目不把任何社区插件的私有 HTTP/RPC 当作长期协议，也不在 Flutter 或 mobile-remote 路由层重复实现 Git 命令。

## Consequences

- mobile-remote 的公开 DTO、错误码和兼容策略独立于 provider DTO，provider 可以替换而不要求 App 随之改版。
- Git Service Definition 必须是 DSH/Cordis Service，而不是只有编译期作用的 TypeScript interface。
- Git 适配器以可选能力运行；provider 缺失、版本不兼容或运行中卸载时，只禁用 Git 功能并报告原因，不影响 mobile-remote 的其他能力。
- `dsh-wending-git-workbench`、`dock-git` 等只作为 provider 候选或实现参考；本 ADR 不接受任何具体候选为稳定依赖。
