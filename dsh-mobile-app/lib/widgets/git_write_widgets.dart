import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../git_models.dart';
import '../git_write_models.dart';
import '../store.dart';
import '../theme.dart';

String _short(String? value, [int length = 10]) {
  final text = value ?? '';
  return text.length <= length ? text : text.substring(0, length);
}

String _kindTitle(String kind) =>
    const {
      'git.stage': '暂存',
      'git.unstage': '取消暂存',
      'git.commit': '提交',
      'git.branch-create': '创建分支',
      'git.branch-rename': '重命名分支',
      'git.branch-switch': '切换分支',
      'git.fetch': 'Fetch',
      'git.pull': 'Pull',
      'git.push': 'Push',
      'git.sync': '同步',
      'git.abort': '放弃冲突操作',
    }[kind] ??
    kind;

String _statusTitle(String status) =>
    const {
      'queued': '排队中',
      'running': '执行中',
      'succeeded': '已完成',
      'failed': '失败',
      'cancelled': '已取消',
      'conflicted': '需要处理冲突',
      'unknown-result': '结果不确定',
    }[status] ??
    status;

Future<bool> _confirm(
  BuildContext context, {
  required String title,
  required Widget content,
  String action = '确认',
  bool destructive = false,
}) async =>
    await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(title),
        content: content,
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('取消'),
          ),
          FilledButton(
            style: destructive
                ? FilledButton.styleFrom(
                    backgroundColor: Theme.of(context).colorScheme.error,
                  )
                : null,
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text(action),
          ),
        ],
      ),
    ) ??
    false;

void _showError(BuildContext context, Object error) {
  final message = error is ApiException
      ? '${error.code == null ? '' : '${error.code}: '}${error.message}'
      : error.toString();
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
}

class GitWriteSheetHeader extends StatelessWidget {
  final String title;
  final String? subtitle;
  final Widget? trailing;

  const GitWriteSheetHeader({
    super.key,
    required this.title,
    this.subtitle,
    this.trailing,
  });

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(18, 10, 12, 8),
    child: Column(
      children: [
        Center(
          child: Container(
            width: 36,
            height: 4,
            decoration: BoxDecoration(
              color: DshColors.line(context),
              borderRadius: BorderRadius.circular(2),
            ),
          ),
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            const SizedBox(width: 40),
            Expanded(
              child: Column(
                children: [
                  Text(
                    title,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  if (subtitle != null)
                    Text(
                      subtitle!,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 11.5,
                        color: DshColors.ink3(context),
                      ),
                    ),
                ],
              ),
            ),
            SizedBox(width: 40, child: trailing),
          ],
        ),
      ],
    ),
  );
}

class GitOperationCard extends StatefulWidget {
  final AppStore store;
  final GitOperation operation;

  const GitOperationCard({
    super.key,
    required this.store,
    required this.operation,
  });

  @override
  State<GitOperationCard> createState() => _GitOperationCardState();
}

class _GitOperationCardState extends State<GitOperationCard> {
  bool busy = false;

  Future<void> _run(Future<void> Function() action) async {
    if (busy) return;
    setState(() => busy = true);
    try {
      await action();
    } catch (error) {
      if (mounted) _showError(context, error);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _abort() async {
    final live =
        widget.store.gitOperations.byId(widget.operation.operationId) ??
        widget.operation;
    final preflight = await widget.store.prepareGitAbort(live.repositoryId);
    if (!mounted) return;
    final summary =
        preflight.summary ??
        preflight.data['intermediateState']?.toString() ??
        '这会放弃当前 merge/rebase 的中间状态。';
    final accepted = await _confirm(
      context,
      title: '放弃当前冲突操作？',
      content: Text('$summary\n\n服务端将签发一次性确认挑战；此操作与普通取消不同。'),
      action: '放弃并恢复',
      destructive: true,
    );
    if (accepted) await widget.store.submitGitAbort(preflight);
  }

  @override
  Widget build(BuildContext context) {
    final live =
        widget.store.gitOperations.byId(widget.operation.operationId) ??
        widget.operation;
    final color = live.succeeded
        ? Colors.green
        : live.needsRecovery || live.status == 'failed'
        ? Theme.of(context).colorScheme.error
        : DshColors.brand(context);
    return Card(
      key: ValueKey('git-operation-${live.operationId}'),
      margin: const EdgeInsets.symmetric(vertical: 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    _kindTitle(live.kind),
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                ),
                Text(
                  _statusTitle(live.status),
                  style: TextStyle(color: color, fontWeight: FontWeight.w600),
                ),
              ],
            ),
            const SizedBox(height: 6),
            if (live.running)
              LinearProgressIndicator(
                value: live.phaseCount > 1
                    ? (live.phaseIndex + 1) / live.phaseCount
                    : null,
              ),
            if (live.phase != null)
              Padding(
                padding: const EdgeInsets.only(top: 5),
                child: Text(
                  '${live.phase} · ${live.phaseIndex + 1}/${live.phaseCount}',
                  style: TextStyle(
                    fontSize: 12,
                    color: DshColors.ink3(context),
                  ),
                ),
              ),
            for (final stage in live.stages)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: Icon(
                  stage.status == 'succeeded'
                      ? Icons.check_circle_outline
                      : stage.status == 'failed' || stage.status == 'conflicted'
                      ? Icons.error_outline
                      : stage.status == 'skipped'
                      ? Icons.skip_next
                      : Icons.pending_outlined,
                  size: 18,
                ),
                title: Text(_kindTitle('git.${stage.kind}')),
                subtitle: stage.skipReason == null
                    ? null
                    : Text('已跳过：${stage.skipReason}'),
                trailing: Text(_statusTitle(stage.status)),
              ),
            if (live.errorCode != null || live.detail != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  '${live.errorCode ?? ''}${live.detail == null ? '' : ': ${live.detail}'}',
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            if (live.status == 'unknown-result')
              const Padding(
                padding: EdgeInsets.only(top: 6),
                child: Text('结果无法证明，已禁止自动重试。请先刷新并在电脑端核对仓库事实。'),
              ),
            if (live.status == 'conflicted')
              const Padding(
                padding: EdgeInsets.only(top: 6),
                child: Text('仓库处于冲突中。移动端不会自动 continue、commit 或 push。'),
              ),
            Wrap(
              spacing: 8,
              children: [
                TextButton.icon(
                  onPressed: busy
                      ? null
                      : () => _run(() async {
                          await widget.store.gitOperations.reconcile(
                            live.operationId,
                          );
                        }),
                  icon: const Icon(Icons.refresh, size: 17),
                  label: const Text('查询状态'),
                ),
                if (live.canCancel)
                  TextButton.icon(
                    key: const ValueKey('git-operation-cancel'),
                    onPressed: busy
                        ? null
                        : () => _run(() async {
                            await widget.store.cancelGitOperation(live);
                          }),
                    icon: const Icon(Icons.stop_circle_outlined, size: 17),
                    label: const Text('取消任务（不回滚）'),
                  ),
                if (live.needsRecovery)
                  TextButton(
                    onPressed: busy
                        ? null
                        : () => _run(() async {
                            await widget.store.handoffGitOperation(
                              live,
                              'computer',
                            );
                          }),
                    child: const Text('转电脑处理'),
                  ),
                if (live.status == 'conflicted')
                  TextButton(
                    onPressed: busy
                        ? null
                        : () => _run(() async {
                            await widget.store.handoffGitOperation(
                              live,
                              'model',
                            );
                          }),
                    child: const Text('交给模型'),
                  ),
                if (live.status == 'conflicted')
                  TextButton(
                    key: const ValueKey('git-conflict-abort'),
                    onPressed: busy ? null : () => _run(_abort),
                    child: const Text('放弃 merge/rebase'),
                  ),
                if (live.status == 'unknown-result')
                  TextButton(
                    onPressed: busy
                        ? null
                        : () => _run(() async {
                            final inspection = await widget.store
                                .inspectGitRecovery(live);
                            if (!context.mounted) return;
                            final confirmed = await _confirm(
                              context,
                              title: '已核对以下仓库事实？',
                              content: Text(
                                '${inspection.summary}\n\n只有确认这些刷新后的本地与远端事实，才能解除写阻塞；旧任务仍保持 unknown-result，原操作不会重放。',
                              ),
                              action: '确认已核对',
                            );
                            if (confirmed) {
                              final current =
                                  widget.store.gitOperations.byId(
                                    live.operationId,
                                  ) ??
                                  live;
                              await widget.store.acknowledgeGitOperation(
                                current,
                                inspection.stateVersion,
                              );
                            }
                          }),
                    child: const Text('解除恢复阻塞'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class GitStatusWriteSheet extends StatefulWidget {
  final AppStore store;
  final bool showDiff;

  const GitStatusWriteSheet({
    super.key,
    required this.store,
    this.showDiff = false,
  });

  @override
  State<GitStatusWriteSheet> createState() => _GitStatusWriteSheetState();
}

class _GitStatusWriteSheetState extends State<GitStatusWriteSheet> {
  String kind = 'working';
  GitChangeSet? changeSet;
  Object? error;
  bool loading = true;
  bool submitting = false;
  int _loadGeneration = 0;
  final Map<String, Set<String>?> selected = {};

  @override
  void initState() {
    super.initState();
    if (widget.showDiff) kind = 'working';
    _load();
  }

  Future<void> _load([String? nextKind]) async {
    final requested = nextKind ?? kind;
    final requestedRepositoryId = widget.store.gitContext?.repositoryId;
    final generation = ++_loadGeneration;
    setState(() {
      kind = requested;
      loading = true;
      changeSet = null;
      error = null;
      selected.clear();
    });
    try {
      final result = await widget.store.loadGitChangeSet(requested);
      if (!mounted ||
          generation != _loadGeneration ||
          requested != kind ||
          widget.store.gitContext?.repositoryId != requestedRepositoryId) {
        return;
      }
      setState(() => changeSet = result);
    } catch (caught) {
      if (mounted &&
          generation == _loadGeneration &&
          requested == kind &&
          widget.store.gitContext?.repositoryId == requestedRepositoryId) {
        setState(() => error = caught);
      }
    } finally {
      if (mounted && generation == _loadGeneration && requested == kind) {
        setState(() => loading = false);
      }
    }
  }

  void _toggleFile(GitChangeFile file, bool value) {
    setState(() {
      if (value) {
        selected[file.fileId] = null;
      } else {
        selected.remove(file.fileId);
      }
    });
  }

  void _toggleHunk(GitChangeFile file, GitHunkSelection hunk, bool value) {
    setState(() {
      final current = selected[file.fileId];
      final hunks = current == null && selected.containsKey(file.fileId)
          ? <String>{for (final item in file.hunks) item.hunkId}
          : <String>{...?current};
      if (value) {
        hunks.add(hunk.hunkId);
      } else {
        hunks.remove(hunk.hunkId);
      }
      if (hunks.isEmpty) {
        selected.remove(file.fileId);
      } else {
        // Keep explicit hunk ids even when every currently visible hunk is
        // selected. A whole-file selection has broader semantics if the
        // change-set is refreshed or contains non-hunk records.
        selected[file.fileId] = hunks;
      }
    });
  }

  List<GitFileSelection> _selections() => selected.entries
      .map(
        (entry) => GitFileSelection(
          fileId: entry.key,
          hunkIds: entry.value?.toList(growable: false) ?? const [],
        ),
      )
      .toList(growable: false);

  Future<void> _submit() async {
    final snapshot = changeSet;
    if (snapshot == null || selected.isEmpty || submitting) return;
    setState(() => submitting = true);
    try {
      await widget.store.submitGitSelection(
        snapshot,
        _selections(),
        unstage: kind == 'staged',
      );
      if (mounted) await _load();
    } catch (caught) {
      if (mounted) _showError(context, caught);
      if (caught is ApiException && caught.requiresRefresh && mounted) {
        await _load();
      }
    } finally {
      if (mounted) setState(() => submitting = false);
    }
  }

  Future<void> _commit() async {
    await showDialog<void>(
      context: context,
      builder: (_) => GitCommitDialog(store: widget.store),
    );
    if (mounted) await _load('staged');
  }

  @override
  Widget build(BuildContext context) => SafeArea(
    child: SizedBox(
      key: const ValueKey('git-status-sheet'),
      height: MediaQuery.of(context).size.height * 0.86,
      child: AnimatedBuilder(
        animation: widget.store,
        builder: (context, _) {
          final repositoryId = widget.store.gitContext?.repositoryId;
          final operation = repositoryId == null
              ? null
              : widget.store.gitOperations.activeFor(repositoryId) ??
                    widget.store.gitOperations.latestFor(repositoryId);
          return Column(
            children: [
              GitWriteSheetHeader(
                title: '工作区写操作',
                subtitle: '只提交服务端签发的 fileId/hunkId；不会运行 Git hooks',
                trailing: IconButton(
                  onPressed: loading ? null : _load,
                  icon: const Icon(Icons.refresh),
                ),
              ),
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'working', label: Text('未暂存')),
                  ButtonSegment(value: 'staged', label: Text('已暂存')),
                ],
                selected: {kind},
                onSelectionChanged: loading
                    ? null
                    : (values) => _load(values.single),
              ),
              if (operation != null)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: GitOperationCard(
                    store: widget.store,
                    operation: operation,
                  ),
                ),
              Expanded(child: _body()),
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 6, 12, 12),
                child: Row(
                  children: [
                    Expanded(
                      child: FilledButton.icon(
                        key: const ValueKey('git-stage-submit'),
                        onPressed: selected.isEmpty || submitting
                            ? null
                            : _submit,
                        icon: Icon(
                          kind == 'staged'
                              ? Icons.remove_circle_outline
                              : Icons.add_task,
                        ),
                        label: Text(
                          submitting
                              ? '提交中…'
                              : kind == 'staged'
                              ? '取消暂存所选'
                              : '暂存所选',
                        ),
                      ),
                    ),
                    if (kind == 'staged') ...[
                      const SizedBox(width: 8),
                      Expanded(
                        child: OutlinedButton.icon(
                          key: const ValueKey('git-commit-open'),
                          onPressed:
                              loading ||
                                  submitting ||
                                  (changeSet?.files.isEmpty ?? true)
                              ? null
                              : _commit,
                          icon: const Icon(Icons.commit),
                          label: const Text('提交…'),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          );
        },
      ),
    ),
  );

  Widget _body() {
    if (loading) return const Center(child: CircularProgressIndicator());
    if (error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('加载失败：$error'),
            TextButton(onPressed: _load, child: const Text('刷新后重选')),
          ],
        ),
      );
    }
    final files = changeSet?.files ?? const <GitChangeFile>[];
    if (files.isEmpty)
      return Center(child: Text(kind == 'staged' ? '没有已暂存改动' : '工作区干净'));
    return ListView.builder(
      padding: const EdgeInsets.symmetric(horizontal: 10),
      itemCount: files.length,
      itemBuilder: (context, index) {
        final file = files[index];
        final selectedWhole =
            selected.containsKey(file.fileId) && selected[file.fileId] == null;
        final selectedHunks = selected[file.fileId] ?? const <String>{};
        final tile = CheckboxListTile(
          key: ValueKey('git-file-${file.fileId}'),
          value: selectedWhole,
          tristate: selectedHunks.isNotEmpty,
          onChanged: (value) => _toggleFile(file, value == true),
          controlAffinity: ListTileControlAffinity.leading,
          title: Text(file.path, maxLines: 2, overflow: TextOverflow.ellipsis),
          subtitle: Text(
            '${file.index}${file.worktree}${file.binary ? ' · 二进制' : ''}${file.rename ? ' · 重命名' : ''}',
          ),
        );
        if (file.hunks.isEmpty) return tile;
        return ExpansionTile(
          initiallyExpanded: widget.showDiff,
          title: tile,
          children: [
            for (final hunk in file.hunks)
              CheckboxListTile(
                dense: true,
                value: selectedWhole || selectedHunks.contains(hunk.hunkId),
                onChanged: (value) => _toggleHunk(file, hunk, value == true),
                title: Text(
                  hunk.header,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                ),
                subtitle: Text('+${hunk.additions}  -${hunk.deletions}'),
              ),
          ],
        );
      },
    );
  }
}

class GitCommitDialog extends StatefulWidget {
  final AppStore store;

  const GitCommitDialog({super.key, required this.store});

  @override
  State<GitCommitDialog> createState() => _GitCommitDialogState();
}

class _GitCommitDialogState extends State<GitCommitDialog> {
  final controller = TextEditingController();
  GitPreflight? preflight;
  bool busy = false;
  bool confirmed = false;

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  Future<void> _prepare() async {
    if (controller.text.trim().isEmpty || busy) return;
    setState(() => busy = true);
    try {
      final result = await widget.store.prepareGitCommit(controller.text);
      if (mounted) setState(() => preflight = result);
    } catch (error) {
      if (mounted) _showError(context, error);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _submit() async {
    if (preflight == null || !confirmed || busy) return;
    setState(() => busy = true);
    try {
      await widget.store.submitGitCommit(preflight!, controller.text);
      if (mounted) Navigator.pop(context);
    } catch (error) {
      if (mounted) _showError(context, error);
      if (error is ApiException && error.requiresRefresh && mounted) {
        setState(() {
          preflight = null;
          confirmed = false;
        });
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final identity = preflight?.identity ?? const <String, dynamic>{};
    return AlertDialog(
      key: const ValueKey('git-commit-dialog'),
      title: const Text('创建提交'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: controller,
              maxLines: 4,
              autofocus: true,
              decoration: const InputDecoration(
                labelText: '提交消息',
                hintText: '说明这次改动',
                border: OutlineInputBorder(),
              ),
              onChanged: (_) => setState(() {
                preflight = null;
                confirmed = false;
              }),
            ),
            if (preflight != null) ...[
              const SizedBox(height: 12),
              Text('分支：${preflight!.data['branch'] ?? '-'}'),
              Text('HEAD：${_short(preflight!.data['headOid']?.toString())}'),
              Text(
                'Staged tree：${_short(preflight!.data['stagedTreeOid']?.toString())}',
              ),
              Text(
                '身份：${identity['name'] ?? '-'} <${identity['email'] ?? '-'}>',
              ),
              const SizedBox(height: 6),
              const Text(
                '移动端提交策略：不运行 hooks',
                style: TextStyle(fontWeight: FontWeight.w700),
              ),
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                value: confirmed,
                onChanged: (value) => setState(() => confirmed = value == true),
                title: const Text('我已核对 staged tree、身份和提交消息'),
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('取消'),
        ),
        if (preflight == null)
          FilledButton(
            key: const ValueKey('git-commit-preflight'),
            onPressed: controller.text.trim().isEmpty || busy ? null : _prepare,
            child: const Text('提交预检'),
          )
        else
          FilledButton(
            key: const ValueKey('git-commit-submit'),
            onPressed: confirmed && !busy ? _submit : null,
            child: Text(busy ? '提交中…' : '确认提交'),
          ),
      ],
    );
  }
}

class GitBranchWriteSheet extends StatefulWidget {
  final AppStore store;

  const GitBranchWriteSheet({super.key, required this.store});

  @override
  State<GitBranchWriteSheet> createState() => _GitBranchWriteSheetState();
}

class _GitBranchWriteSheetState extends State<GitBranchWriteSheet> {
  bool busy = false;

  Future<String?> _askName(String title, {String? initial}) async {
    final controller = TextEditingController(text: initial);
    final value = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(title),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(labelText: '本地分支名'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () =>
                Navigator.pop(dialogContext, controller.text.trim()),
            child: const Text('下一步'),
          ),
        ],
      ),
    );
    // The dialog route can still animate one final frame after its result is
    // delivered, so disposing this route-owned controller here is too early.
    return value == null || value.isEmpty ? null : value;
  }

  Future<void> _runPreflight(Future<GitPreflight> Function() prepare) async {
    if (busy) return;
    setState(() => busy = true);
    try {
      final preflight = await prepare();
      if (!mounted) return;
      if (!preflight.safe) {
        await showDialog<void>(
          context: context,
          builder: (dialogContext) => AlertDialog(
            title: const Text('无法安全切换'),
            content: Text(
              '当前改动可能被覆盖。可用动作：${preflight.allowedActions.join(' / ')}。\n\n请先提交、转电脑处理或取消；移动端不会 force。',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext),
                child: const Text('知道了'),
              ),
            ],
          ),
        );
        return;
      }
      if (preflight.noop) {
        if (mounted) {
          ScaffoldMessenger.of(context)
              .showSnackBar(const SnackBar(content: Text('当前已经在目标分支，无需切换')));
        }
        return;
      }
      final accepted = await _confirm(
        context,
        title: '${_kindTitle('git.branch-${preflight.action}')}？',
        content: Text(
          '目标：${preflight.data['targetBranch'] ?? preflight.data['name'] ?? preflight.params['name'] ?? '-'}\n状态版本：${_short(preflight.stateVersion)}',
        ),
      );
      if (accepted) await widget.store.submitGitBranch(preflight);
    } catch (error) {
      if (mounted) _showError(context, error);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _create() async {
    final name = await _askName('创建本地分支');
    if (name == null) return;
    await _runPreflight(
      () => widget.store.prepareGitBranch(action: 'create', name: name),
    );
  }

  Future<void> _rename(GitBranch branch) async {
    final name = await _askName(
      '重命名 ${branch.displayName}',
      initial: branch.displayName,
    );
    if (name == null || name == branch.displayName) return;
    await _runPreflight(
      () => widget.store.prepareGitBranch(
        action: 'rename',
        oldName: branch.displayName,
        name: name,
      ),
    );
  }

  Future<void> _switch(GitBranch branch) async {
    if (branch.remote) {
      final fallback = branch.displayName.split('/').skip(1).join('/');
      final localName = await _askName(
        '创建本地 tracking branch',
        initial: fallback,
      );
      if (localName == null) return;
      await _runPreflight(
        () => widget.store.prepareGitBranch(
          action: 'switch',
          targetRef: branch.name,
          localName: localName,
        ),
      );
    } else {
      await _runPreflight(
        () => widget.store.prepareGitBranch(
          action: 'switch',
          targetBranch: branch.displayName,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) => SafeArea(
    child: SizedBox(
      key: const ValueKey('git-branch-sheet'),
      height: MediaQuery.of(context).size.height * 0.76,
      child: AnimatedBuilder(
        animation: widget.store,
        builder: (context, _) {
          final branches = AppStore.sortGitBranches(widget.store.gitBranches);
          final repositoryId = widget.store.gitContext?.repositoryId;
          final operation = repositoryId == null
              ? null
              : widget.store.gitOperations.activeFor(repositoryId) ??
                    widget.store.gitOperations.latestFor(repositoryId);
          return Column(
            children: [
              GitWriteSheetHeader(
                title: '分支',
                subtitle: '受保护切换；不会覆盖本地改动',
                trailing: IconButton(
                  key: const ValueKey('git-branch-create'),
                  onPressed: busy || !widget.store.gitCapability.writes
                      ? null
                      : _create,
                  icon: const Icon(Icons.add),
                ),
              ),
              if (operation != null)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: GitOperationCard(
                    store: widget.store,
                    operation: operation,
                  ),
                ),
              Expanded(
                child: ListView.separated(
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                  itemCount: branches.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (context, index) {
                    final branch = branches[index];
                    final current =
                        branch.displayName == widget.store.gitStatus?.branch;
                    return ListTile(
                      leading: Icon(
                        branch.remote
                            ? Icons.cloud_outlined
                            : Icons.account_tree,
                      ),
                      title: Text(branch.displayName),
                      subtitle: Text(
                        branch.remote
                            ? '远端 · 创建本地 tracking branch'
                            : _short(branch.oid, 8),
                      ),
                      onTap:
                          busy || current || !widget.store.gitCapability.writes
                          ? null
                          : () => _switch(branch),
                      trailing: current
                          ? const Icon(Icons.check)
                          : branch.remote
                          ? const Icon(Icons.download)
                          : IconButton(
                              tooltip: '重命名',
                              onPressed: busy ? null : () => _rename(branch),
                              icon: const Icon(Icons.edit_outlined, size: 19),
                            ),
                    );
                  },
                ),
              ),
            ],
          );
        },
      ),
    ),
  );
}

class GitSyncSheet extends StatefulWidget {
  final AppStore store;

  const GitSyncSheet({super.key, required this.store});

  @override
  State<GitSyncSheet> createState() => _GitSyncSheetState();
}

class _GitSyncSheetState extends State<GitSyncSheet> {
  GitRemotes? remotes;
  String? remote;
  String? branch;
  String kind = 'sync';
  String strategy = 'merge';
  bool setUpstream = true;
  bool loading = true;
  bool busy = false;
  Object? error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final value = await widget.store.loadGitRemotes();
      if (!mounted) return;
      setState(() {
        remotes = value;
        if (!value.remotes.any((item) => item.name == remote)) {
          remote = null;
          branch = null;
        }
      });
    } catch (caught) {
      if (mounted) setState(() => error = caught);
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  GitRemoteTarget? get selectedRemote {
    for (final value in remotes?.remotes ?? const <GitRemoteTarget>[]) {
      if (value.name == remote) return value;
    }
    return null;
  }

  List<String> get branchChoices {
    final values = <String>[
      for (final item in selectedRemote?.branches ?? const <GitRemoteBranch>[])
        item.branch,
    ];
    final local = widget.store.gitStatus?.branch;
    if (local != null && local != 'HEAD' && !values.contains(local)) {
      values.add(local);
    }
    return values;
  }

  Future<void> _submit() async {
    if (remote == null || branch == null || busy) return;
    setState(() => busy = true);
    try {
      final preflight = await widget.store.prepareGitRemote(
        kind: kind,
        remote: remote!,
        branch: branch!,
        strategy: strategy,
        setUpstream: setUpstream,
      );
      if (!mounted) return;
      final accepted = await _confirm(
        context,
        title: '${kind.toUpperCase()} ${remote!}/$branch？',
        content: Text(
          '本地分支：${widget.store.gitStatus?.branch ?? '-'}\n远端：${remote!}\n目标分支：$branch\n${kind == 'pull' || kind == 'sync' ? '整合策略：$strategy\n' : ''}\n同步不是原子事务；已完成阶段不会因后续失败而回滚。',
        ),
        action: '开始${_kindTitle('git.$kind')}',
      );
      if (accepted) await widget.store.submitGitRemote(preflight);
    } catch (caught) {
      if (mounted) _showError(context, caught);
      if (caught is ApiException && caught.requiresRefresh && mounted) {
        await _load();
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => SafeArea(
    child: SizedBox(
      key: const ValueKey('git-sync-sheet'),
      height: MediaQuery.of(context).size.height * 0.82,
      child: AnimatedBuilder(
        animation: widget.store,
        builder: (context, _) {
          final repositoryId = widget.store.gitContext?.repositoryId;
          final operation = repositoryId == null
              ? null
              : widget.store.gitOperations.activeFor(repositoryId) ??
                    widget.store.gitOperations.latestFor(repositoryId);
          final blocked =
              operation?.running == true || operation?.needsRecovery == true;
          return Column(
            children: [
              GitWriteSheetHeader(
                title: '远端同步',
                subtitle: '必须明确 remote、branch 和整合策略',
                trailing: IconButton(
                  onPressed: loading ? null : _load,
                  icon: const Icon(Icons.refresh),
                ),
              ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                  children: [
                    if (loading)
                      const Center(child: CircularProgressIndicator()),
                    if (error != null) Center(child: Text('加载失败：$error')),
                    if (!loading && error == null) ...[
                      DropdownButtonFormField<String>(
                        key: const ValueKey('git-sync-remote'),
                        initialValue: remote,
                        decoration: const InputDecoration(labelText: 'Remote'),
                        items: [
                          for (final item
                              in remotes?.remotes ?? const <GitRemoteTarget>[])
                            DropdownMenuItem(
                              value: item.name,
                              child: Text(item.name),
                            ),
                        ],
                        onChanged: blocked
                            ? null
                            : (value) => setState(() {
                                remote = value;
                                branch = null;
                              }),
                      ),
                      DropdownButtonFormField<String>(
                        key: const ValueKey('git-sync-branch'),
                        initialValue: branch,
                        decoration: const InputDecoration(labelText: '远端目标分支'),
                        items: [
                          for (final value in branchChoices)
                            DropdownMenuItem(
                              value: value,
                              child: Text(
                                selectedRemote?.branches.any(
                                          (item) => item.branch == value,
                                        ) ==
                                        true
                                    ? value
                                    : '$value（新建远端目标）',
                              ),
                            ),
                        ],
                        onChanged: blocked
                            ? null
                            : (value) => setState(() => branch = value),
                      ),
                      const SizedBox(height: 10),
                      DropdownButtonFormField<String>(
                        key: const ValueKey('git-sync-kind'),
                        initialValue: kind,
                        decoration: const InputDecoration(labelText: '操作'),
                        items: const [
                          DropdownMenuItem(
                            value: 'fetch',
                            child: Text('Fetch（只更新远端跟踪）'),
                          ),
                          DropdownMenuItem(
                            value: 'pull',
                            child: Text('Pull（fetch + integrate）'),
                          ),
                          DropdownMenuItem(value: 'push', child: Text('Push')),
                          DropdownMenuItem(
                            value: 'sync',
                            child: Text('Sync（fetch + integrate + push）'),
                          ),
                        ],
                        onChanged: blocked
                            ? null
                            : (value) => setState(() => kind = value ?? 'sync'),
                      ),
                      if (kind == 'pull' || kind == 'sync')
                        DropdownButtonFormField<String>(
                          key: const ValueKey('git-sync-strategy'),
                          initialValue: strategy,
                          decoration: const InputDecoration(labelText: '整合策略'),
                          items: const [
                            DropdownMenuItem(
                              value: 'merge',
                              child: Text('Merge'),
                            ),
                            DropdownMenuItem(
                              value: 'rebase',
                              child: Text('Rebase'),
                            ),
                          ],
                          onChanged: blocked
                              ? null
                              : (value) =>
                                    setState(() => strategy = value ?? 'merge'),
                        ),
                      if (kind == 'push' || kind == 'sync')
                        SwitchListTile(
                          contentPadding: EdgeInsets.zero,
                          value: setUpstream,
                          onChanged: blocked
                              ? null
                              : (value) => setState(() => setUpstream = value),
                          title: const Text('成功后设置 upstream'),
                        ),
                      const SizedBox(height: 8),
                      FilledButton.icon(
                        key: const ValueKey('git-sync-submit'),
                        onPressed:
                            remote == null || branch == null || busy || blocked
                            ? null
                            : _submit,
                        icon: const Icon(Icons.sync),
                        label: Text(
                          blocked
                              ? '等待当前任务恢复'
                              : busy
                              ? '预检中…'
                              : '预检并执行',
                        ),
                      ),
                    ],
                    if (operation != null)
                      GitOperationCard(
                        store: widget.store,
                        operation: operation,
                      ),
                  ],
                ),
              ),
            ],
          );
        },
      ),
    ),
  );
}
