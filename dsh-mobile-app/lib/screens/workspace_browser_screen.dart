// 工作区文件浏览页（issue #15）：只读浏览当前已注册工作区的目录与文件内容。
//
// 设计约束（见 docs/adr/0014）：
// - 纯只读；不复用新建文件夹等写操作。
// - 路径夹在工作区根内，不提供向上越出。
// - 隐藏 `.git/` 由服务端过滤点开头条目实现（服务端只回非点开头项）。
// - 入口始终可见；不可用时在页内说明原因 + 重试。
import 'package:flutter/material.dart';

import '../l10n.dart';
import '../store.dart';
import '../theme.dart';
import '../workspace_browser_controller.dart';
import '../workspace_browser_logic.dart';

/// 打开「工作区文件浏览」全屏只读页。
void openWorkspaceBrowser(BuildContext context, AppStore store) {
  Navigator.of(context).push(
    MaterialPageRoute(builder: (_) => WorkspaceBrowserScreen(store: store)),
  );
}

class WorkspaceBrowserScreen extends StatefulWidget {
  const WorkspaceBrowserScreen({super.key, required this.store, this.controller});

  final AppStore store;

  /// 测试可注入；为 null 时页面自己建一个。
  final WorkspaceBrowserController? controller;

  @override
  State<WorkspaceBrowserScreen> createState() => _WorkspaceBrowserScreenState();
}

class _WorkspaceBrowserScreenState extends State<WorkspaceBrowserScreen> {
  late final WorkspaceBrowserController _c;
  late final bool _ownsController;

  @override
  void initState() {
    super.initState();
    _c = widget.controller ?? WorkspaceBrowserController(store: widget.store);
    _ownsController = widget.controller == null;
    _c.addListener(_onChange);
    _c.open();
  }

  @override
  void dispose() {
    _c.removeListener(_onChange);
    if (_ownsController) _c.dispose();
    super.dispose();
  }

  void _onChange() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(L10n.t('文件', 'Files')),
        actions: [
          IconButton(
            key: const Key('wb-refresh'),
            icon: const Icon(Icons.refresh),
            tooltip: L10n.t('刷新', 'Refresh'),
            onPressed: () => _c.refresh(),
          ),
        ],
      ),
      body: SafeArea(child: _body()),
    );
  }

  Widget _body() {
    switch (_c.stage) {
      case BrowseStage.needsWorkspace:
        return _workspacePicker();
      case BrowseStage.error:
        // 已加载过内容时保留它（只提示原因），避免刷新失败让页面变空。
        if (_c.dirs.isNotEmpty || _c.files.isNotEmpty) {
          return Column(
            children: [_errorBanner(), Expanded(child: _listing())],
          );
        }
        return _errorPane();
      case BrowseStage.loading:
        return const Center(child: CircularProgressIndicator());
      case BrowseStage.listing:
        return _listing();
      case BrowseStage.preview:
        return _preview();
    }
  }

  // ── 工作区选择（选中"全部"或未选中时）──
  Widget _workspacePicker() {
    final options = _c.workspaceOptions;
    return ListView(
      key: const Key('wb-workspace-picker'),
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          child: Text(
            L10n.t('选择一个工作区', 'Choose a workspace'),
            style: TextStyle(fontSize: 13, color: DshColors.ink2(context)),
          ),
        ),
        for (final o in options)
          ListTile(
            leading: const Icon(Icons.folder_outlined),
            title: Text(o.title),
            subtitle: Text(o.path, maxLines: 1, overflow: TextOverflow.ellipsis),
            onTap: () => _c.switchWorkspace(o.path),
          ),
      ],
    );
  }

  // ── 目录列表 ──
  Widget _listing() {
    return Column(
      key: const Key('wb-listing'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _rootBar(),
        _breadcrumbBar(),
        if (_c.hiddenCount > 0) _truncationNotice(),
        const Divider(height: 1),
        Expanded(
          child: ListView(
            children: [
              for (final d in _c.dirs)
                ListTile(
                  key: Key('wb-dir-$d'),
                  leading: const Icon(Icons.folder, size: 20),
                  title: Text(d),
                  onTap: () => _c.openDir(d),
                ),
              for (final f in _c.files)
                ListTile(
                  key: Key('wb-file-$f'),
                  leading: const Icon(Icons.description_outlined, size: 20),
                  title: Text(f),
                  onTap: () => _c.openFile(f),
                ),
              if (_c.dirs.isEmpty && _c.files.isEmpty)
                Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(
                    L10n.t('这个目录是空的', 'This directory is empty'),
                    style: TextStyle(color: DshColors.ink3(context)),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _rootBar() {
    final options = _c.workspaceOptions;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 2),
      child: Row(
        children: [
          Icon(Icons.work_outline, size: 16, color: DshColors.ink3(context)),
          const SizedBox(width: 6),
          Expanded(
            child: DropdownButtonHideUnderline(
              child: DropdownButton<String>(
                key: const Key('wb-workspace-switch'),
                isExpanded: true,
                value: options.any((o) => o.path == _c.root) ? _c.root : null,
                hint: Text(_c.root, maxLines: 1, overflow: TextOverflow.ellipsis),
                items: [
                  for (final o in options)
                    DropdownMenuItem(value: o.path, child: Text(o.title, overflow: TextOverflow.ellipsis)),
                ],
                onChanged: (v) {
                  if (v != null && v != _c.root) _c.switchWorkspace(v);
                },
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _breadcrumbBar() {
    final crumbs = _c.breadcrumbs;
    return SizedBox(
      height: 40,
      child: ListView(
        key: const Key('wb-breadcrumb'),
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        children: [
          for (var i = 0; i < crumbs.length; i++) ...[
            if (i > 0) Icon(Icons.chevron_right, size: 16, color: DshColors.ink3(context)),
            TextButton(
              key: Key('wb-crumb-${crumbs[i].path}'),
              onPressed: i == crumbs.length - 1 ? null : () => _c.jumpTo(crumbs[i].path),
              child: Text(crumbs[i].label),
            ),
          ],
        ],
      ),
    );
  }

  Widget _truncationNotice() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      child: Text(
        L10n.t(
          '条目较多，仅显示前 ${_c.dirs.length + _c.files.length} 项，共 ${_c.totalEntries} 项',
          'Many entries: showing first ${_c.dirs.length + _c.files.length} of ${_c.totalEntries}',
        ),
        key: const Key('wb-truncated-dir'),
        style: TextStyle(fontSize: 12, color: DshColors.warn(context)),
      ),
    );
  }

  // ── 文件预览 ──
  Widget _preview() {
    final v = _c.preview;
    return Column(
      key: const Key('wb-preview'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
          child: Row(
            children: [
              IconButton(
                key: const Key('wb-preview-back'),
                icon: const Icon(Icons.arrow_back),
                tooltip: L10n.t('返回目录', 'Back to directory'),
                onPressed: () => _c.closePreview(),
              ),
              Expanded(
                child: Text(
                  _c.previewPath,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12.5, color: DshColors.ink2(context)),
                ),
              ),
            ],
          ),
        ),
        const Divider(height: 1),
        Expanded(child: _previewBody(v)),
      ],
    );
  }

  Widget _previewBody(PreviewVerdict? v) {
    if (v is PreviewUnavailable) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            v.reason,
            key: const Key('wb-preview-unavailable'),
            textAlign: TextAlign.center,
            style: TextStyle(color: DshColors.ink2(context)),
          ),
        ),
      );
    }
    if (v is! PreviewText) {
      return const Center(child: CircularProgressIndicator());
    }
    final lines = previewLines(v.text);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (v.truncated)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            color: DshColors.brandSoft(context),
            child: Text(
              L10n.t(
                '文件较大，仅显示前 ${v.bytesShown ~/ 1024} KiB',
                'File is large: showing first ${v.bytesShown ~/ 1024} KiB',
              ),
              key: const Key('wb-preview-truncated'),
              style: TextStyle(fontSize: 12, color: DshColors.ink2(context)),
            ),
          ),
        Expanded(
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: SingleChildScrollView(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (var i = 0; i < lines.length; i++)
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SizedBox(
                            width: 48,
                            child: Text(
                              '${i + 1}',
                              textAlign: TextAlign.right,
                              style: TextStyle(
                                fontFamily: 'monospace',
                                fontSize: 12,
                                color: DshColors.ink3(context),
                              ),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Text(
                            lines[i],
                            style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                          ),
                        ],
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  // ── 错误 ──
  Widget _errorBanner() {
    return Container(
      width: double.infinity,
      color: DshColors.brandSoft(context),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Row(
        children: [
          Expanded(
            child: Text(
              _c.errorReason,
              key: const Key('wb-error-banner'),
              style: TextStyle(fontSize: 12.5, color: DshColors.ink2(context)),
            ),
          ),
          TextButton(
            key: const Key('wb-retry'),
            onPressed: () => _c.retry(),
            child: Text(L10n.t('重试', 'Retry')),
          ),
        ],
      ),
    );
  }

  Widget _errorPane() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.folder_off_outlined, size: 40, color: DshColors.ink3(context)),
            const SizedBox(height: 12),
            Text(
              _c.errorReason,
              key: const Key('wb-error'),
              textAlign: TextAlign.center,
              style: TextStyle(color: DshColors.ink2(context)),
            ),
            const SizedBox(height: 16),
            FilledButton(
              key: const Key('wb-retry'),
              onPressed: () => _c.retry(),
              child: Text(L10n.t('重试', 'Retry')),
            ),
          ],
        ),
      ),
    );
  }
}
