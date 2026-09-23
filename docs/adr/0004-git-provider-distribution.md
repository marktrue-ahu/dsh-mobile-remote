# Git 只读 provider 采用外部优先、包内兜底

Status: accepted

移动端 Git 只读导航是用户可见的核心功能，同时 Git Service Definition 和 provider 可替换边界仍需保留。运行时优先使用已注册且兼容的外部 provider；没有外部 provider 时，由 mobile-remote 包内的只读 provider 实现同一服务定义，提供仓库识别、分支、tip 绑定提交图、提交详情和变化通知。包内 provider 是默认实现，不是移动 HTTP 路由中的 Git 命令特例，也不提供任何写操作。

## Consequences

- 默认安装无需额外插件即可浏览授权工作区中的 Git 仓库。
- 外部 provider 可在不改变 Flutter 或移动 API 的情况下替换包内实现；mobile-remote 继续拥有 DTO、错误码和兼容映射。
- 包内 provider 只能通过受控 argv、非交互环境、输出与时间上限读取已注册工作区中的仓库，不注册 stage、commit、branch mutation、fetch、pull、push 或其他写能力。
- provider 缺失、不兼容或仓库不可读时，Git 导航入口保持可见并报告稳定原因，不影响其他移动能力。
- 兼容矩阵只需覆盖 Git Service Definition、provider、mobile-remote 和 App 的只读契约，不再发布移动 Git 写操作协议。

## Considered Options

- 必须单独安装 provider：边界最清晰，但默认安装会出现可见却不可用的核心入口。
- 只使用包内实现：交付简单，但失去 provider 可替换性。
- 外部优先、包内只读兜底：默认可用且保留服务接缝；当前采用。
