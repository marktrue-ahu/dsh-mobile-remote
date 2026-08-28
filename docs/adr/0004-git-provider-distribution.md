# Git provider 随移动 Git 能力提供受支持版本

Status: proposed

移动 Git 是用户可见的核心功能，但 provider 在 DSH 中应保持可替换，因此推荐把默认 provider 作为独立包随对应版本的 mobile-remote 一起安装和发布，并维护 Service Definition、provider、mobile-remote 与 App 的兼容矩阵；运行时仍把 provider 视为可选能力，缺失或不兼容时明确报告不可用原因。待默认 provider 的代码归属、发布权限和升级路径验证后再将本决策改为 accepted。

## Considered Options

- 仅要求用户自行安装社区插件：发布简单，但默认安装没有 Git 功能，支持矩阵不可控。
- 把 Git 命令直接放进 mobile-remote：交付简单，但破坏 provider/consumer 边界并扩大插件职责。
- 独立 provider 与项目版本线共同发布：边界清晰且默认可用，但增加一个发布物和兼容性测试成本；当前推荐。
