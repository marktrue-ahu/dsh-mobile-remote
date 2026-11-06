# Issue 跟踪：GitLab

本仓库的 issue 与规格存放在自建 GitLab 实例上的 `ahedu/dsh-mobile-remote`（项目内 ID **53**，默认分支 `main`，可见性 private）。所有 issue 操作都必须显式指定该项目。

## CLI 环境

开发容器（2026-11 起）内 `glab` 是 Linux 原生二进制，已在 PATH 中：

```sh
DSH_GLAB=glab   # 直接调用即可；不要再引用 /mnt/d/... 下的 Windows 版本
```

- 已登录 `gitlab.local`（用户 `luxiao`），凭据在 `~/.config/glab-cli/config.yml`；REST 端点为 `https://gitlab.local/api/v4/`。用 `glab auth status` 自检。
- **不需要 HTTP 代理**；中文输出正常，无需 hex 之类的变通（glab 自身配置了 socks5 代理）。
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

`glab issue create` 只提供 `-d/--description` 字符串参数，没有从文件读取正文的选项。规格这类长正文一律用 `glab api` 的 `@-` 从 stdin 读（容器内 glab 是原生二进制，也能读本地路径；但 stdin 方式不受 shell 引号与转义影响）：

```sh
"$DSH_GLAB" api "projects/53/issues" --method POST \
  --field "title=..." \
  --field "labels=ready-for-agent" \
  --field "description=@-" < spec.md
```

`glab api` 的项目引用支持数字 ID（`projects/53`）与 URL 编码 path（`projects/ahedu%2Fdsh-mobile-remote`）两种写法。

### 上传附件（图片）优先用 curl

容器内 glab 是原生二进制，`glab api "projects/53/uploads" --field "file=@<路径>"` 理论上可用；
但附件上传属于低频操作，已验证可用的是原生 `curl` 打 multipart。

**curl 直接调 API 必须满足三个条件**（缺一不可，均为实测）：

1. `gitlab.local` 能解析 —— 容器 **`/etc/hosts` 不持久**，重建后需重新补：
   ```sh
   grep -q gitlab.local /etc/hosts || echo '117.68.9.95 gitlab.local' >> /etc/hosts
   ```
2. 该实例使用**自签名证书**，curl 默认校验会报
   `SSL certificate problem: unable to get local issuer certificate`，需 `-k`
   （glab 在配置里已设 `skip_tls_verify: true`，所以 glab 不需要这个参数）
3. 必须**经 SOCKS5 代理**：直连会被拒，用 `--socks5-hostname 192.168.50.33:1088`
   （glab 配置里已设 `proxy: socks5://192.168.50.33:1088`）

```sh
TOKEN=$(sed -n '76s/.*token: *//p' ~/.config/glab-cli/config.yml | tr -d '"'"'"' \r')
curl -sk --socks5-hostname 192.168.50.33:1088 -X POST -H "PRIVATE-TOKEN: $TOKEN" \
  -F "file=@overview.png" \
  https://gitlab.local/api/v4/projects/53/uploads
```

> 用 `glab api` 时以上三点都由 glab 配置自动处理，不需要额外参数——这是优先用 glab 的原因。

返回 `{"alt":..., "url":"/uploads/<hash>/<name>", "markdown":"![...](/uploads/...)"}`；
把 `markdown` 字段原样贴进 issue 正文即可内嵌显示（`url` 是**项目级**的，同一文件可被多个 issue 复用）。

### 已知问题：REST `PUT /projects/:id/issues/:iid` 卡在读响应

该实例上走 REST 的 issue 更新（关闭 / 重启 / 改标签）会**超时无响应**（超时后服务端有时仍会后台生效）：

```text
read tcp 172.17.255.182:…->117.68.9.95:80: connection attempt failed
```

> 该现象记录于 WSL 时期；**迁移到开发容器后尚未复测**。如再遇到，可先按下面的 GraphQL 替代路径处理。

`gitlab.local` 解析到 `117.68.9.95` 就是这套 GitLab 的实际地址，**不是解析错误**。创建 issue 与发表评论（POST）不受影响。

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
