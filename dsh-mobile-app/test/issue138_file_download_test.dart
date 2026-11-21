// GitLab #138：会话文件浏览的下载入口（列表/预览/选择模式/320/1.5×）。
import 'dart:convert';
import 'dart:io';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/resumable_download.dart';
import 'package:dsh_mobile_app/screens/session_files_screen.dart';
import 'package:dsh_mobile_app/session_file_download.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _root = '/work';

http.Response _json(Map<String, dynamic> body, [int status = 200]) =>
    http.Response(
      jsonEncode(body),
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

class _Backend {
  _Backend({this.selectionMode = false});

  final bool selectionMode;
  final List<String> fileRequests = [];
  late final MockClient client = MockClient(_handle);
  late final Api api = Api(client: client)
    ..baseUrl = 'http://files.test'
    ..path = '/m'
    ..token = ''
    ..sessionRelativeFilesSupported = true;

  Future<http.Response> _handle(http.Request request) async {
    final path = request.url.path;
    if (path == '/m/api/directories') {
      final dir = request.url.queryParameters['path'];
      return _json({
        'ok': true,
        'path': dir,
        'dirs': dir == _root ? ['sub'] : <String>[],
        'files': dir == _root ? ['a.txt'] : <String>[],
        'fileEntries': dir == _root
            ? [
                {'name': 'a.txt', 'size': 5, 'mtimeMs': 1, 'mime': 'text/plain'},
              ]
            : <Object>[],
      });
    }
    if (path == '/m/api/files') {
      fileRequests.add(request.url.query);
      return http.Response.bytes(
        utf8.encode('hello'),
        200,
        headers: {
          'content-type': 'text/plain',
          'etag': '"abc"',
          'content-length': '5',
        },
      );
    }
    if (path.endsWith('/api/git/capabilities')) {
      return _json({
        'ok': true,
        'git': {'available': false},
      });
    }
    return _json({'ok': true});
  }
}

Future<AppStore> _mount(
  WidgetTester tester,
  _Backend backend,
  SessionFileDownloadController downloader, {
  Size size = const Size(390, 844),
  TextScaler textScaler = TextScaler.noScaling,
  ThemeData? theme,
  List<PendingDownload>? initialPending,
}) async {
  final store = AppStore()
    ..sessionId = 's1'
    ..sessions = [Session(id: 's1', title: '主会话', cwd: _root, createdAt: 1)];
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      theme: theme ?? DshTheme.light(),
      home: MediaQuery(
        data: MediaQueryData(size: size, textScaler: textScaler),
        child: SessionFilesScreen(
          store: store,
          sessionId: 's1',
          apiClient: backend.api,
          downloader: downloader,
          selectionMode: backend.selectionMode,
          initialPendingDownloads: initialPending,
        ),
      ),
    ),
  );
  for (var i = 0; i < 10; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
  return store;
}

Future<SessionFileDownloadController> _downloader(
  _Backend backend,
  Directory temp,
) async {
  final downloads = ResumableDownloads(Directory('${temp.path}/dl'), backend.api);
  final controller = SessionFileDownloadController(
    api: backend.api,
    sessionId: 's1',
    root: _root,
    downloads: downloads,
    saveFile: (file, name) async => '/saved/$name',
    downloadClient: backend.client,
  );
  addTearDown(controller.dispose);
  return controller;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('文件行有下载按钮、目录没有；选择模式隐藏下载', (tester) async {
    final temp = Directory.systemTemp.createTempSync('issue138-ui-');
    addTearDown(() => temp.deleteSync(recursive: true));
    final backend = _Backend();
    final downloader = await _downloader(backend, temp);
    await _mount(tester, backend, downloader);

    expect(find.byKey(const ValueKey('sf-file-a.txt')), findsOneWidget);
    expect(find.byKey(const ValueKey('sf-download-a.txt')), findsOneWidget);
    expect(find.byKey(const ValueKey('sf-download-sub')), findsNothing);

    final selectionBackend = _Backend(selectionMode: true);
    final selectionDownloader = await _downloader(selectionBackend, temp);
    await _mount(tester, selectionBackend, selectionDownloader);
    expect(find.byKey(const ValueKey('sf-download-a.txt')), findsNothing);
  });

  testWidgets('旧宿主无 session-relative 能力：不显示下载入口', (tester) async {
    final temp = Directory.systemTemp.createTempSync('issue138-old-');
    addTearDown(() => temp.deleteSync(recursive: true));
    final backend = _Backend();
    backend.api.sessionRelativeFilesSupported = false;
    final downloader = await _downloader(backend, temp);
    await _mount(tester, backend, downloader);
    expect(find.byKey(const ValueKey('sf-download-a.txt')), findsNothing);
  });

  testWidgets('列表点击下载：显示进度条，完成后弹完成对话框', (tester) async {
    final temp = Directory.systemTemp.createTempSync('issue138-done-');
    addTearDown(() => temp.deleteSync(recursive: true));
    final backend = _Backend();
    final downloader = await _downloader(backend, temp);
    await _mount(tester, backend, downloader);

    await tester.runAsync(() async {
      await tester.tap(find.byKey(const ValueKey('sf-download-a.txt')));
      // 真实文件 I/O / HTTP 在 widget 测试的 fake async 中需要 runAsync。
      await Future<void>.delayed(const Duration(milliseconds: 300));
    });
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 40));
    }
    expect(find.text('下载完成'), findsOneWidget);
    expect(find.textContaining('/saved/a.txt'), findsOneWidget);
    await tester.tap(find.text('关闭'));
    await tester.pumpAndSettle();
    expect(downloader.phase, SessionFileDownloadPhase.done);
  });

  testWidgets('有未完成断点时显示 banner', (tester) async {
    final temp = Directory.systemTemp.createTempSync('issue138-pending-');
    addTearDown(() => temp.deleteSync(recursive: true));
    final backend = _Backend();
    final downloads = ResumableDownloads(
      Directory('${temp.path}/dl'),
      backend.api,
    );
    final controller = SessionFileDownloadController(
      api: backend.api,
      sessionId: 's1',
      root: _root,
      downloads: downloads,
      saveFile: (file, name) async => '/saved/$name',
      downloadClient: backend.client,
    );
    addTearDown(controller.dispose);
    await _mount(
      tester,
      backend,
      controller,
      initialPending: const [PendingDownload('/work/pending.bin', 3)],
    );
    expect(find.byKey(const ValueKey('sf-pending-downloads')), findsOneWidget);
    expect(find.textContaining('1 个未完成的下载'), findsOneWidget);
  });

  testWidgets('预览页有下载按钮；320/1.5× 不溢出', (tester) async {
    final temp = Directory.systemTemp.createTempSync('issue138-preview-');
    addTearDown(() => temp.deleteSync(recursive: true));
    final backend = _Backend();
    final downloader = await _downloader(backend, temp);
    await _mount(
      tester,
      backend,
      downloader,
      size: const Size(320, 640),
      textScaler: const TextScaler.linear(1.5),
      theme: DshTheme.dark(),
    );

    await tester.tap(find.byKey(const ValueKey('sf-file-a.txt')));
    for (var i = 0; i < 15; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    expect(find.byKey(const ValueKey('sf-preview')), findsOneWidget);
    // 320/1.5× 下 topActions 会折叠进“更多操作”，先展开再断言下载入口。
    final overflow = find.byKey(const ValueKey('sf-preview-overflow-actions'));
    if (overflow.evaluate().isNotEmpty) {
      await tester.tap(overflow);
      await tester.pumpAndSettle();
    }
    expect(find.byKey(const ValueKey('sf-download-preview')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
