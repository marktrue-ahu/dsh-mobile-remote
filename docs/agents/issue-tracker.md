# Issue 跟踪：GitLab

本仓库的 issue 与规格存放在自建 GitLab 实例上的 `ahedu/dsh-mobile-remote`（项目内 ID **53**，默认分支 `main`，可见性 private）。所有 issue 操作都必须显式指定该项目。

## CLI 环境

glab 安装在 Windows 宿主机，从 WSL 直接调用：

```sh
DSH_GLAB='/mnt/d/Program Files (x86)/glab/glab.exe'
```

- 已登录 `gitlab.local`（用户 `luxiao`，token 存在 Windows 凭据管理器），REST 端点为 `http://gitlab.local/api/v4/`。用 `"$DSH_GLAB" auth status` 自检。
- **不需要 HTTP 代理**；WSL 下中文输出正常，无需 hex 之类的变通。
- 原生子命令可用，但**必须带 `-R`**，否则会按当前目录的 remote 推断目标。

## 约定

- **创建 issue**：`"$DSH_GLAB" issue create -R ahedu/dsh-mobile-remote --title "..." -l ready-for-agent`
- **读取 issue**：`"$DSH_GLAB" issue view <iid> -R ahedu/dsh-mobile-remote --comments`
- **列出 issue**：`"$DSH_GLAB" api "projects/53/issues?state=opened&per_page=50"`
  （⚠ 本机的 glab 构建**不支持** `issue list --state`，会报 `Unknown flag: --state`；用上面的 api 形式按状态过滤，别用原生子命令）
- **评论 issue**：`"$DSH_GLAB" issue note <iid> -R ahedu/dsh-mobile-remote -m "..."`
- **增删标签**：`"$DSH_GLAB" issue update <iid> -R ahedu/dsh-mobile-remote -l "..."` / `-u "..."`
- **关闭 issue**：`"$DSH_GLAB" issue close <iid> -R ahedu/dsh-mobile-remote`
- **创建缺失标签**：`"$DSH_GLAB" label create -R ahedu/dsh-mobile-remote --name "..."`

### 长多行正文走 stdin

`glab issue create` 只提供 `-d/--description` 字符串参数，没有从文件读取正文的选项；而 glab 是 Windows 二进制，**解析不了 WSL 侧传进去的绝对路径**。规格这类长正文一律用 `glab api` 的 `@-` 从 stdin 读：

```sh
"$DSH_GLAB" api "projects/53/issues" --method POST \
  --field "title=..." \
  --field "labels=ready-for-agent" \
  --field "description=@-" < spec.md
```

`glab api` 的项目引用支持数字 ID（`projects/53`）与 URL 编码 path（`projects/ahedu%2Fdsh-mobile-remote`）两种写法。

### 上传附件（图片）走 curl，不要用 glab

`glab api "projects/53/uploads" --field "file=@<路径>"` **会失败**（HTTP 400）：glab 是 Windows 二进制，
既读不了 WSL 侧路径，换成 `\\wsl.localhost\...` 的 UNC 路径也报 400。改用 WSL 原生 `curl` 直接打 multipart：

```sh
TOKEN=$(/mnt/d/Program\ Files\ \(x86\)/glab/glab.exe auth status --show-token 2>/dev/null \
        | grep -oP 'keyring:\s*\K\S+')
curl -sS -X POST -H "PRIVATE-TOKEN: $TOKEN" \
  -F "file=@overview.png" \
  http://gitlab.local/api/v4/projects/53/uploads
```

返回 `{"alt":..., "url":"/uploads/<hash>/<name>", "markdown":"![...](/uploads/...)"}`；
把 `markdown` 字段原样贴进 issue 正文即可内嵌显示（`url` 是**项目级**的，同一文件可被多个 issue 复用）。
WSL 能直连 `gitlab.local`（解析到 Windows hosts 里配置的地址，不是解析错误）。

### 已知问题：REST `PUT /projects/:id/issues/:iid` 卡在读响应

该实例上走 REST 的 issue 更新（关闭 / 重启 / 改标签）会**超时无响应**（超时后服务端有时仍会后台生效）：

```text
read tcp 172.17.255.182:…->117.68.9.95:80: connection attempt failed
```

WSL 直连 `curl -X PUT` 与 Windows 侧 `glab` 现象一致。注意 `gitlab.local` 解析到 `117.68.9.95` 是 Windows hosts 的显式配置（该地址上就是这套 GitLab），**不是解析错误**。创建 issue 与发表评论（POST）不受影响。

替代路径（已验证）：

- **关闭 / 重启 issue → GraphQL `updateIssue`**：

  ```sh
  "$DSH_GLAB" api graphql -f query='mutation { updateIssue(input: { projectPath: "ahedu/dsh-mobile-remote", iid: "9", stateEvent: CLOSE }) { issue { iid state } errors } }'
  ```

  `stateEvent` 取 `CLOSE` / `REOPEN`；GraphQL 的 mutation 名是 `updateIssue`（该实例没有 `issueSetState`）。

- **改标签**：GraphQL `updateIssue` 的 `addLabelIds` / `removeLabelIds`（需 label 的数字 ID），或重试 REST PUT 后用 GET 复核 `labels` 字段（曾观察到 `?add_labels=` 超时但实际已生效）。

- **改标题 / 正文 → 同样是 GraphQL `updateIssue`**（已验证）：

  ```sh
  "$DSH_GLAB" api graphql -f query='mutation { updateIssue(input: { projectPath: "ahedu/dsh-mobile-remote", iid: "19", title: "新标题" }) { issue { iid title } errors } }'
  ```

  `title` 与 `description` 都是 `UpdateIssueInput` 的字段。**长多行中文正文往返无损**（已验证：换行、`` ` `` 反引号、单双引号、反斜杠、`<>&%$#@!*()[]{}` 均原样保留），因此**规格正文不必一次写死**，事后补验收标准或贴结果都可以。

  长正文的实操：GraphQL 的 query 只能内联传入（`-f query=...`），没有 `@-` 读文件。把正文按 **JSON 规则转义**（`\n` / `\"` / `\\`）后嵌进 GraphQL 字符串字面量即可——JSON 与 GraphQL 的字符串转义在这里兼容。转义在脚本里做（如 Python 的 `json.dumps(body)[1:-1]`），**不要手写**，然后用 argv 数组直接调 glab，避免 shell 引号干扰。

- **删除 issue**：REST `DELETE /projects/53/issues/<iid>` **可用**（被挡的只有 PUT）。删除后用 GET 复核应得 404。

> 被挡的**只有 PUT**。`POST`（创建、评论）与 `DELETE` 实测正常；`GET` 正常；GraphQL 的 mutation 走 POST，因此不受影响。

任何写操作后都复核一次状态：

```sh
"$DSH_GLAB" api "projects/53/issues/<iid>" | grep -o '"state":"[a-z]*"'
```

## 技能指令

技能说「发布到 issue 跟踪器」时，在 `ahedu/dsh-mobile-remote` 创建 issue，并按 `triage-labels.md` 打标签（`/to-spec` 用 `ready-for-agent`）。

技能说「获取相关工单」时，从该项目读取对应 issue 及其标签、评论。
