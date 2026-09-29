// 工作区文件浏览的页面状态机。
//
// 职责：把「当前工作区 + 当前目录 + 目录内容 / 文件预览」组织成 UI 可渲染的状态，
// 并把所有外部交互（列目录、取文件）收在这里，便于用假 Api 做 widget 测试。
//
// 边界（见 ADR 0014）：只读；路径夹在工作区根内；不做写操作。

import 'package:flutter/foundation.dart';

import '../api.dart';
import '../store.dart';
import '../workspace_browser_logic.dart';

/// 页面阶段。
enum BrowseStage {
  /// 尚未确定工作区（未注册工作区，或当前选中"全部"），需要用户先选一个。
  needsWorkspace,

  /// 正在加载目录或文件。
  loading,

  /// 显示目录内容。
  listing,

  /// 显示文件内容预览。
  preview,

  /// 出错（保留旧内容由 UI 决定是否继续展示）。
  error,
}

/// 一个工作区条目的展示信息（从 store 的原始 map 提取，避免 UI 直接碰 map）。
@immutable
class WorkspaceOption {
  const WorkspaceOption({required this.path, required this.title});
  final String path;
  final String title;
}

class WorkspaceBrowserController extends ChangeNotifier {
  WorkspaceBrowserController({required this.store, Api? api}) : _api = api ?? Api();

  final AppStore store;
  final Api _api;

  BrowseStage stage = BrowseStage.loading;

  /// 当前工作区根（已规范化用于比较的原始路径）。
  String root = '';

  /// 当前目录绝对路径；等于 root 时表示在根。
  String currentPath = '';

  /// 服务端路径分隔符，首次列举后确定。
  String sep = '/';

  /// 最近一次成功列举的目录内容（用于刷新失败时保留旧内容）。
  List<String> dirs = const [];
  List<String> files = const [];

  /// 因渲染上限被隐藏的条目数（0 表示全部展示）。
  int hiddenCount = 0;

  /// 目录条目总数。
  int totalEntries = 0;

  /// 预览中的文件。
  String previewPath = '';
  PreviewVerdict? preview;

  /// 错误原因；`stage == BrowseStage.error` 时有效。
  String errorReason = '';

  /// 最近一次成功取数的时间（刷新失败时 UI 用它标注陈旧）。
  DateTime? lastLoadedAt;

  /// 可选工作区列表（needsWorkspace 时展示）。
  List<WorkspaceOption> get workspaceOptions => store.workspaces
      .map((w) => WorkspaceOption(
            path: (w['path'] as String?) ?? '',
            title: (w['title'] as String?) ?? (w['path'] as String?) ?? '工作区',
          ))
      .where((w) => w.path.isNotEmpty)
      .toList();

  /// 面包屑（从工作区根开始，不越出）。
  List<({String label, String path})> get breadcrumbs {
    final all = browseBreadcrumbs(currentPath, sep);
    // 裁掉根之前的部分：面包屑第一项固定是工作区根。
    final rootIdx = all.indexWhere((c) => _samePath(c.path, root));
    if (rootIdx < 0) {
      // 根路径与切分结果不完全一致时，退化为「根 + 相对段」
      final rel = _relativeToRoot(currentPath);
      final crumbs = <({String label, String path})>[
        (label: _rootLabel(), path: root),
      ];
      if (rel.isNotEmpty) {
        var acc = root;
        for (final part in rel.split(sep).where((e) => e.isNotEmpty)) {
          acc = joinBrowsePath(acc, part, sep);
          crumbs.add((label: part, path: acc));
        }
      }
      return crumbs;
    }
    return [
      (label: _rootLabel(), path: root),
      ...all.sublist(rootIdx + 1),
    ];
  }

  /// 是否位于工作区根（不允许再向上）。
  bool get atRoot => _samePath(currentPath, root);

  /// 打开页面：确定根工作区并加载。
  ///
  /// - 已选中某个工作区 → 直接浏览它；
  /// - 选中"全部"或未选中 → 进入工作区选择态（有已注册工作区时）；
  /// - 一个工作区都没有 → 给出原因，入口不隐藏。
  Future<void> open() async {
    if (store.workspaces.isEmpty) {
      await store.refreshWorkspaces(notify: false);
    }
    final options = workspaceOptions;
    if (options.isEmpty) {
      stage = BrowseStage.error;
      errorReason = '没有已注册的工作区，无法浏览';
      notifyListeners();
      return;
    }
    final selected = _selectedOption(options);
    if (selected == null) {
      stage = BrowseStage.needsWorkspace;
      notifyListeners();
      return;
    }
    await enterWorkspace(selected.path);
  }

  /// 选择一个工作区并进入其根目录（同时写回全局状态，与抽屉一致）。
  Future<void> enterWorkspace(String path) async {
    root = path;
    currentPath = path;
    await store.setWorkspace(path);
    await loadDir(path);
  }

  /// 页内切换工作区。
  Future<void> switchWorkspace(String path) => enterWorkspace(path);

  /// 加载某个目录。
  Future<void> loadDir(String path) async {
    // 夹在工作区根内：越界的请求直接拒绝，不发给服务端。
    if (root.isNotEmpty && !isWithinRoot(root, path)) {
      stage = BrowseStage.error;
      errorReason = '已到达工作区根目录，无法向上浏览';
      notifyListeners();
      return;
    }
    stage = BrowseStage.loading;
    notifyListeners();
    try {
      final listing = await _api.directories(path);
      // 服务端只在「根视图」响应里带 sep，普通目录响应没有这个字段，
      // 因此不能靠它判断分隔符（目录选择器的 dirSepOf 也是同样思路）。
      if (listing.sep != null && listing.sep!.isNotEmpty) {
        sep = listing.sep!;
      } else if (sep == '/' && path.contains('\\')) {
        sep = '\\';
      }
      final limited = limitDirEntries(listing.dirs, listing.files);
      dirs = limited.dirs;
      files = limited.files;
      hiddenCount = limited.hiddenCount;
      totalEntries = limited.total;
      currentPath = path;
      preview = null;
      previewPath = '';
      lastLoadedAt = DateTime.now();
      stage = BrowseStage.listing;
    } catch (e) {
      // 保留旧内容：只改阶段与原因，不清空 dirs/files。
      stage = BrowseStage.error;
      errorReason = '无法读取目录：${_short(e)}';
    }
    notifyListeners();
  }

  /// 进入子目录。
  Future<void> openDir(String name) => loadDir(joinBrowsePath(currentPath, name, sep));

  /// 返回上一级；已在根则不动。
  Future<void> goUp() async {
    if (atRoot) return;
    final parent = parentBrowsePath(currentPath, sep);
    await loadDir(isWithinRoot(root, parent) ? parent : root);
  }

  /// 跳到面包屑上的某一级。
  Future<void> jumpTo(String path) => loadDir(path);

  /// 打开文件预览。
  Future<void> openFile(String name) async {
    final path = joinBrowsePath(currentPath, name, sep);
    stage = BrowseStage.loading;
    notifyListeners();
    try {
      final bytes = await _api.downloadFile(path);
      preview = buildPreview(Uint8List.fromList(bytes));
      previewPath = path;
      lastLoadedAt = DateTime.now();
      stage = BrowseStage.preview;
    } catch (e) {
      stage = BrowseStage.error;
      errorReason = '无法读取文件：${_short(e)}';
    }
    notifyListeners();
  }

  /// 从预览返回所在目录。
  Future<void> closePreview() async {
    preview = null;
    previewPath = '';
    await loadDir(currentPath);
  }

  /// 显式刷新当前视图（目录或预览）。
  Future<void> refresh() async {
    if (stage == BrowseStage.preview && previewPath.isNotEmpty) {
      final dir = currentPath;
      await openFile(_basename(previewPath));
      currentPath = dir;
      return;
    }
    await loadDir(currentPath);
  }

  /// 重试：清掉错误后重新加载当前目录。
  Future<void> retry() async {
    if (root.isEmpty) {
      await open();
      return;
    }
    await loadDir(currentPath.isEmpty ? root : currentPath);
  }

  WorkspaceOption? _selectedOption(List<WorkspaceOption> options) {
    final selected = store.workspacePath;
    if (selected == null) return null;
    for (final o in options) {
      if (AppStore.normPath(o.path) == selected) return o;
    }
    return null;
  }

  bool _samePath(String a, String b) =>
      a == b || AppStore.normPath(a) == AppStore.normPath(b);

  String _relativeToRoot(String path) {
    if (!isWithinRoot(root, path) || _samePath(root, path)) return '';
    var rel = path.substring(root.length);
    while (rel.startsWith(sep)) {
      rel = rel.substring(sep.length);
    }
    return rel;
  }

  String _rootLabel() {
    final n = _basename(root);
    return n.isEmpty ? root : n;
  }

  String _basename(String path) {
    final parts = path.split(sep).where((e) => e.isNotEmpty).toList();
    return parts.isEmpty ? '' : parts.last;
  }

  /// 错误信息只保留简短原因，不把服务端长文本铺到 UI 上。
  String _short(Object e) {
    final s = e.toString();
    return s.length <= 160 ? s : '${s.substring(0, 160)}…';
  }
}
