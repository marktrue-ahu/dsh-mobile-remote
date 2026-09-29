// Seam 2：工作区文件浏览控制器（路径栈、面包屑、夹根、限额、切换、错误）。
//
// 通过 MockClient 注入假的 HTTP 层，因此同时覆盖了真实 Api 的解析路径，
// 而不是只测一个手写的假 Api。
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/workspace_browser_controller.dart';
import 'package:dsh_mobile_app/workspace_browser_logic.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 假服务端：记录请求，按路径返回预设目录或文件内容。
class _Backend {
  _Backend() {
    _initApi();
  }

  /// 置 true 后所有列目录请求都失败（测试里按需切换）。
  bool failDirs = false;
  final List<String> dirRequests = [];
  final List<String> fileRequests = [];

  /// 路径 → (dirs, files)
  final Map<String, ({List<String> dirs, List<String> files})> listing = {
    '/work': (dirs: ['src', 'docs'], files: ['README.md', '.hidden-ignored']),
    '/work/src': (dirs: [], files: ['main.dart']),
    '/work/docs': (dirs: [], files: []),
    '/other': (dirs: [], files: ['x.txt']),
  };

  /// 路径 → 字节
  final Map<String, List<int>> contents = {
    '/work/README.md': utf8.encode('第一行\n第二行\n'),
    '/work/src/main.dart': utf8.encode('void main() {}'),
    '/work/binary.bin': [0x00, 0x01, 0x02],
  };

  late final Api api;

  void _initApi() {
    api = Api(client: MockClient(_handle))
      ..baseUrl = 'http://wb.test'
      ..path = '/m'
      ..token = '';
  }

  Future<http.Response> _handle(http.Request request) async {
    final path = request.url.queryParameters['path'] ?? '';
    if (request.url.path == '/m/api/workspaces') {
      return http.Response(
        jsonEncode({
          'ok': true,
          'workspaces': [
            {'path': '/work', 'title': 'Work'},
            {'path': '/other', 'title': 'Other'},
          ],
        }),
        200,
      );
    }
    if (request.url.path == '/m/api/directories') {
      dirRequests.add(path);
      if (failDirs) {
        return http.Response(jsonEncode({'ok': false, 'error': 'directory-unreadable'}), 400);
      }
      final l = listing[path];
      if (l == null) {
        return http.Response(jsonEncode({'ok': false, 'error': 'directory-unreadable'}), 400);
      }
      return http.Response(
        jsonEncode({'ok': true, 'path': path, 'dirs': l.dirs, 'files': l.files, 'sep': '/'}),
        200,
      );
    }
    if (request.url.path == '/m/api/files') {
      fileRequests.add(path);
      final bytes = contents[path];
      if (bytes == null) return http.Response('not found', 404);
      return http.Response.bytes(bytes, 200);
    }
    return http.Response('unexpected ${request.url}', 500);
  }
}

/// 造一个已注册两个工作区、并已选中 /work 的 store。
Future<AppStore> _storeWithWork(String? selected) async {
  final store = AppStore();
  store.workspaces = [
    {'path': '/work', 'title': 'Work'},
    {'path': '/other', 'title': 'Other'},
  ];
  if (selected != null) await store.setWorkspace(selected);
  return store;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('已选中工作区时直接浏览其根目录', () async {
    final b = _Backend();
    final store = await _storeWithWork('/work');
    final c = WorkspaceBrowserController(store: store, api: b.api);

    await c.open();

    expect(c.stage, BrowseStage.listing);
    expect(c.root, '/work');
    expect(c.currentPath, '/work');
    expect(c.dirs, ['src', 'docs']);
    expect(c.files, ['README.md', '.hidden-ignored']);
    expect(c.atRoot, isTrue);
  });

  test('选中"全部工作区"时进入工作区选择态', () async {
    final b = _Backend();
    final store = await _storeWithWork(null);
    final c = WorkspaceBrowserController(store: store, api: b.api);

    await c.open();

    expect(c.stage, BrowseStage.needsWorkspace);
    expect(c.workspaceOptions.length, 2);
  });

  test('一个工作区都没有时给出原因而不是隐藏入口', () async {
    final b = _Backend();
    final store = AppStore()..workspaces = [];
    final c = WorkspaceBrowserController(store: store, api: b.api);
    // refreshWorkspaces 会打真实网络；这里直接让它拿到空列表
    await c.open();

    expect(c.stage, BrowseStage.error);
    expect(c.errorReason, contains('没有已注册的工作区'));
  });

  test('选择工作区会写回全局状态（与抽屉一致）', () async {
    final b = _Backend();
    final store = await _storeWithWork(null);
    final c = WorkspaceBrowserController(store: store, api: b.api);
    await c.open();

    await c.switchWorkspace('/other');

    // workspacePath 存的是规范化形态（与抽屉写法一致），比较时要归一。
    expect(store.workspacePath, AppStore.normPath('/other'));
    expect(c.root, '/other', reason: '浏览根的展示形态保留服务端原始路径');
    expect(c.files, ['x.txt']);
  });

  test('下钻与面包屑：从根进入子目录', () async {
    final b = _Backend();
    final store = await _storeWithWork('/work');
    final c = WorkspaceBrowserController(store: store, api: b.api);
    await c.open();

    await c.openDir('src');

    expect(c.currentPath, '/work/src');
    expect(c.files, ['main.dart']);
    expect(c.atRoot, isFalse);
    expect(c.breadcrumbs.map((e) => e.label).toList(), ['work', 'src']);
    expect(c.breadcrumbs.first.path, '/work');
  });

  test('面包屑可跳回工作区根', () async {
    final b = _Backend();
    final store = await _storeWithWork('/work');
    final c = WorkspaceBrowserController(store: store, api: b.api);
    await c.open();
    await c.openDir('src');

    await c.jumpTo('/work');

    expect(c.currentPath, '/work');
    expect(c.atRoot, isTrue);
  });

  test('向上：在根时不动，不产生越界请求', () async {
    final b = _Backend();
    final store = await _storeWithWork('/work');
    final c = WorkspaceBrowserController(store: store, api: b.api);
    await c.open();
    final before = b.dirRequests.length;

    await c.goUp();

    expect(c.currentPath, '/work');
    expect(b.dirRequests.length, before, reason: '在根向上不应发起请求');
  });

  test('从子目录向上回到根', () async {
    final b = _Backend();
    final store = await _storeWithWork('/work');
    final c = WorkspaceBrowserController(store: store, api: b.api);
    await c.open();
    await c.openDir('src');

    await c.goUp();

    expect(c.currentPath, '/work');
    expect(c.stage, BrowseStage.listing);
  });

  test('越界路径被拒绝且不发给服务端', () async {
    final b = _Backend();
    final store = await _storeWithWork('/work');
    final c = WorkspaceBrowserController(store: store, api: b.api);
    await c.open();
    final before = b.dirRequests.length;

    await c.loadDir('/etc');

    expect(c.stage, BrowseStage.error);
    expect(c.errorReason, contains('无法向上浏览'));
    expect(b.dirRequests.length, before, reason: '越界请求不应到达服务端');
  });

  test('打开文本文件进入预览态', () async {
    final b = _Backend();
    final store = await _storeWithWork('/work');
    final c = WorkspaceBrowserController(store: store, api: b.api);
    await c.open();

    await c.openFile('README.md');

    expect(c.stage, BrowseStage.preview);
    expect(c.previewPath, '/work/README.md');
    final v = c.preview! as PreviewText;
    expect(v.text, contains('第一行'));
    expect(v.truncated, isFalse);
  });

  test('打开二进制文件给出不可预览原因', () async {
    final b = _Backend();
    final store = await _storeWithWork('/work');
    final c = WorkspaceBrowserController(store: store, api: b.api);
    await c.open();

    await c.openFile('binary.bin');

    expect(c.stage, BrowseStage.preview);
    expect(c.preview, isA<PreviewUnavailable>());
  });

  test('从预览返回目录', () async {
    final b = _Backend();
    final store = await _storeWithWork('/work');
    final c = WorkspaceBrowserController(store: store, api: b.api);
    await c.open();
    await c.openFile('README.md');

    await c.closePreview();

    expect(c.stage, BrowseStage.listing);
    expect(c.previewPath, '');
    expect(c.currentPath, '/work');
  });

  test('目录读取失败：给出原因并保留旧内容', () async {
    final b = _Backend();
    final store = await _storeWithWork('/work');
    final c = WorkspaceBrowserController(store: store, api: b.api);
    await c.open();
    expect(c.dirs, isNotEmpty);

    b.failDirs = true;
    await c.loadDir('/work');

    expect(c.stage, BrowseStage.error);
    expect(c.errorReason, contains('无法读取目录'));
    expect(c.dirs, ['src', 'docs'], reason: '刷新失败不应清空已加载内容');
    expect(c.lastLoadedAt, isNotNull);
  });

  test('重试在恢复后回到列表态', () async {
    final b = _Backend();
    final store = await _storeWithWork('/work');
    final c = WorkspaceBrowserController(store: store, api: b.api);
    await c.open();

    b.failDirs = true;
    await c.refresh();
    expect(c.stage, BrowseStage.error);

    b.failDirs = false;
    await c.retry();

    expect(c.stage, BrowseStage.listing);
    expect(c.dirs, ['src', 'docs']);
  });

  test('目录条目超限时截断并给出总数', () async {
    final b = _Backend();
    b.listing['/work'] = (
      dirs: List.generate(kDirEntryRenderLimit + 30, (i) => 'd$i'),
      files: [],
    );
    final store = await _storeWithWork('/work');
    final c = WorkspaceBrowserController(store: store, api: b.api);

    await c.open();

    expect(c.dirs.length, kDirEntryRenderLimit);
    expect(c.hiddenCount, 30);
    expect(c.totalEntries, kDirEntryRenderLimit + 30);
  });
}
