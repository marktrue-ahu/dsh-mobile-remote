// Seam 3：工作区文件浏览页（Widget 层）。
//
// 断言用户能看到与能操作什么：入口可达、工作区选择、目录列出、点开预览、
// 二进制/截断提示、错误与重试、刷新。用 MockClient 注入假服务端，
// 因此走的是真实 Api + 真实控制器的完整链路。
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/screens/workspace_browser_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/workspace_browser_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Backend {
  _Backend() {
    api = Api(client: MockClient(_handle))
      ..baseUrl = 'http://wb.test'
      ..path = '/m'
      ..token = '';
  }

  bool failDirs = false;
  late final Api api;

  final Map<String, ({List<String> dirs, List<String> files})> listing = {
    '/work': (dirs: ['src'], files: ['README.md', 'photo.png']),
    '/work/src': (dirs: [], files: ['main.dart']),
  };

  Future<http.Response> _handle(http.Request request) async {
    final path = request.url.queryParameters['path'] ?? '';
    if (request.url.path == '/m/api/directories') {
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
      if (path.endsWith('photo.png')) {
        return http.Response.bytes([0x89, 0x50, 0x00, 0x4E], 200);
      }
      if (path.endsWith('big.txt')) {
        return http.Response.bytes(List<int>.filled(300 * 1024, 0x61), 200);
      }
      return http.Response.bytes(utf8.encode('line one\nline two\n'), 200);
    }
    return http.Response('unexpected', 500);
  }
}

Future<AppStore> _store({String? selected = '/work'}) async {
  final store = AppStore();
  store.workspaces = [
    {'path': '/work', 'title': 'Work'},
    {'path': '/other', 'title': 'Other'},
  ];
  if (selected != null) await store.setWorkspace(selected);
  return store;
}

Future<void> _pump(WidgetTester tester, AppStore store, Api api) async {
  final c = WorkspaceBrowserController(store: store, api: api);
  await tester.pumpWidget(MaterialApp(home: WorkspaceBrowserScreen(store: store, controller: c)));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('打开页面即列出当前工作区根目录', (tester) async {
    final b = _Backend();
    await _pump(tester, await _store(), b.api);

    expect(find.byKey(const Key('wb-listing')), findsOneWidget);
    expect(find.text('src'), findsOneWidget);
    expect(find.text('README.md'), findsOneWidget);
    expect(find.text('photo.png'), findsOneWidget);
  });

  testWidgets('点目录下钻，面包屑出现并可跳回', (tester) async {
    final b = _Backend();
    await _pump(tester, await _store(), b.api);

    await tester.tap(find.byKey(const Key('wb-dir-src')));
    await tester.pumpAndSettle();
    expect(find.text('main.dart'), findsOneWidget);

    // 面包屑第一项是工作区根
    final crumbs = find.byKey(const Key('wb-breadcrumb'));
    expect(crumbs, findsOneWidget);
    await tester.tap(find.byKey(const Key('wb-crumb-/work')));
    await tester.pumpAndSettle();
    expect(find.text('README.md'), findsOneWidget);
  });

  testWidgets('点文件进入预览并显示行号内容', (tester) async {
    final b = _Backend();
    await _pump(tester, await _store(), b.api);

    await tester.tap(find.byKey(const Key('wb-file-README.md')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('wb-preview')), findsOneWidget);
    expect(find.text('line one'), findsOneWidget);
    expect(find.text('line two'), findsOneWidget);
    // 行号
    expect(find.text('1'), findsOneWidget);
    expect(find.text('2'), findsOneWidget);
  });

  testWidgets('二进制文件显示不可预览而不是乱码', (tester) async {
    final b = _Backend();
    await _pump(tester, await _store(), b.api);

    await tester.tap(find.byKey(const Key('wb-file-photo.png')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('wb-preview-unavailable')), findsOneWidget);
  });

  testWidgets('从预览返回目录', (tester) async {
    final b = _Backend();
    await _pump(tester, await _store(), b.api);
    await tester.tap(find.byKey(const Key('wb-file-README.md')));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('wb-preview-back')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('wb-listing')), findsOneWidget);
    expect(find.text('README.md'), findsOneWidget);
  });

  testWidgets('选中"全部工作区"时先让用户选择工作区', (tester) async {
    final b = _Backend();
    await _pump(tester, await _store(selected: null), b.api);

    expect(find.byKey(const Key('wb-workspace-picker')), findsOneWidget);
    expect(find.text('Work'), findsOneWidget);
    expect(find.text('Other'), findsOneWidget);

    await tester.tap(find.text('Work'));
    await tester.pumpAndSettle();
    expect(find.text('README.md'), findsOneWidget);
  });

  testWidgets('没有已注册工作区时入口不隐藏，页面说明原因并可重试', (tester) async {
    final b = _Backend();
    final store = AppStore()..workspaces = [];
    // 用假 api 但让 workspaces 拉取也返回空
    await _pump(tester, store, b.api);

    expect(find.byKey(const Key('wb-error')), findsOneWidget);
    expect(find.textContaining('没有已注册的工作区'), findsOneWidget);
    expect(find.byKey(const Key('wb-retry')), findsWidgets);
  });

  testWidgets('目录读取失败：给出原因、保留旧内容并可重试', (tester) async {
    final b = _Backend();
    await _pump(tester, await _store(), b.api);
    expect(find.text('README.md'), findsOneWidget);

    b.failDirs = true;
    await tester.tap(find.byKey(const Key('wb-refresh')));
    await tester.pumpAndSettle();

    // 旧内容仍在（不因刷新失败变空），并显示原因
    expect(find.text('README.md'), findsOneWidget);
    expect(find.byKey(const Key('wb-error-banner')), findsOneWidget);

    b.failDirs = false;
    await tester.tap(find.byKey(const Key('wb-retry')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('wb-error-banner')), findsNothing);
    expect(find.text('README.md'), findsOneWidget);
  });

  testWidgets('页内切换工作区会写回全局状态', (tester) async {
    final b = _Backend();
    b.listing['/other'] = (dirs: [], files: ['x.txt']);
    final store = await _store();
    await _pump(tester, store, b.api);

    await tester.tap(find.byKey(const Key('wb-workspace-switch')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Other').last);
    await tester.pumpAndSettle();

    expect(store.workspacePath, AppStore.normPath('/other'));
    expect(find.text('x.txt'), findsOneWidget);
  });

  testWidgets('大文件预览显示截断提示', (tester) async {
    final b = _Backend();
    b.listing['/work'] = (dirs: [], files: ['big.txt']);
    await _pump(tester, await _store(), b.api);

    await tester.tap(find.byKey(const Key('wb-file-big.txt')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('wb-preview-truncated')), findsOneWidget);
  });
}
