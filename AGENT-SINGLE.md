# Agent instructions

## Git remotes

- `origin` is the user's GitHub fork: `git@github.com:marktrue-ahu/dsh-mobile-remote.git`.
- `source` is the original upstream repository: `git@github.com:201222-L/dsh-mobile-remote.git`.
- Fetch and compare upstream changes from `source`.
- Push the user's branches and tags to `origin`.
- Treat `source` as read-only unless the user explicitly authorizes a push to the original project.
- Before any pull, rebase, merge, push, or tag operation, verify the target remote and current branch.

## 测试 APK 更新

- 测试性质的手机更新不得修改 App 内部版本（`pubspec.yaml`、Android `versionName`/`versionCode`）。
- 使用当前正式版本号构建 APK 后，仅修改主机更新目录
  `/home/mark/.dsh/mobile-remote/update/manifest.json` 的 `version` 字段，临时使用
  `<版本号>+99`（例如 `3.1.0+99`）触发手机端自动更新检查。
- manifest 的 `apk`、`size`、`sha256` 必须仍与实际 APK 一致；测试结束后再恢复正式 manifest 版本。

## 测试发布流程

按以下顺序执行测试发布：

1. 提交当前开发分支的改动。
2. 将开发分支合并到 `main`。
3. 如果 App 有更新，在 `main` 上构建 APK，并按上面的测试 APK 更新约定发布。
4. 如果服务端脚本有更新，将服务端代码安装到 DSH，并重启 DSH。
5. 完成验证后切回开发分支。
