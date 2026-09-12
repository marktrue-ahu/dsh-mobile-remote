# Issue 跟踪：GitHub

本仓库的 issue 与规格存放在 GitHub Issues（`marktrue-ahu/dsh-mobile-remote`）。所有 issue 操作必须显式传仓库参数，确保操作目标是用户的 `origin` fork，而不是只读的 `source` 仓库。

## CLI 环境

GitHub CLI 安装在 Windows 宿主机，从 WSL 访问：

```sh
DSH_GH='/mnt/c/Program Files/GitHub CLI/gh.exe'
```

所有 GitHub CLI 请求必须走本地 HTTP 代理：

```sh
env HTTP_PROXY=http://127.0.0.1:1080/ HTTPS_PROXY=http://127.0.0.1:1080/ "$DSH_GH" ...
```

## 约定

- **创建 issue**：`"$DSH_GH" issue create --repo marktrue-ahu/dsh-mobile-remote --title "..." --body-file <path>`。
- **读取 issue**：`"$DSH_GH" issue view <number> --repo marktrue-ahu/dsh-mobile-remote --comments`；需要过滤标签或评论时请求 JSON。
- **列出 issue**：`"$DSH_GH" issue list --repo marktrue-ahu/dsh-mobile-remote --state open --json number,title,body,labels,comments`；按需添加标签与状态过滤。
- **评论 issue**：`"$DSH_GH" issue comment <number> --repo marktrue-ahu/dsh-mobile-remote --body-file <path>`。
- **增删标签**：`"$DSH_GH" issue edit <number> --repo marktrue-ahu/dsh-mobile-remote --add-label "..."` 或 `--remove-label "..."`。
- **关闭 issue**：`"$DSH_GH" issue close <number> --repo marktrue-ahu/dsh-mobile-remote --comment "..."`。

每次 GitHub CLI 调用都要带上上面的代理环境变量；多行正文优先用 `--body-file`。

## 技能指令

技能说「发布到 issue 跟踪器」时，在 `marktrue-ahu/dsh-mobile-remote` 创建 issue。

技能说「获取相关工单」时，从该仓库读取对应 issue 及其标签、评论。