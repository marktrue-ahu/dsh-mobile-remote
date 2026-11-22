// issue #157：会话文件列表的图片预览入口（集成契约）。
//
// 覆盖：
//   - 支持扩展名（png/jpg/jpeg/webp/gif）行显示图片图标且点按进全屏图片查看器（不进文本预览）；
//   - svg/heic/heif/avif 行显示图片图标，点按进查看器给出「不支持」提示且不请求宿主；
//   - 其他文件仍进原有文本预览；目录行为不变；
//   - 能力位门控：`files.imagePreview` 或 `files.sessionRelative` 缺失 → 回退旧文本预览；
//   - 选择模式（selectionMode）不显示下载按钮；
//   - 320 窄屏无溢出。
//
// 后端是假服务器（MockClient）：`/api/directories` 列目录、`/api/files` 走旧文本通道、
// `/api/workspace-image` 走图片通道，由测试断言「到底走了哪条通道」。

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/resumable_download.dart';
import 'package:dsh_mobile_app/screens/session_files_screen.dart';
import 'package:dsh_mobile_app/screens/session_image_preview_screen.dart';
import 'package:dsh_mobile_app/session_file_download.dart';
import 'package:dsh_mobile_app/session_files_controller.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _root = '/work';

/// 合法 1x1 PNG。
final Uint8List _png1x1 = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4z8AAAAMBAQD3A0FDAAAAAElFTkSuQmCC',
);

http.Response _json(Map<String, dynamic> body, [int status = 200]) =>
    http.Response(
      jsonEncode(body),
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

class _Backend {
  _Backend({
    List<String>? files,
    this.imagePreviewCapability = true,
    this.sessionRelativeCapability = true,
  }) : files = files ?? const ['photo.png', 'shot.jpg', 'logo.svg', 'notes.txt'];

  List<String> files;
  bool imagePreviewCapability;
  bool sessionRelativeCapability;

  /// 旧文本通道（`/api/files`）请求的 path。
  final List<String> fileRequests = [];

  /// 图片通道（`/api/workspace-image`）请求的 (sessionId, path)。
  final List<({String sessionId, String path})> imageRequests = [];

  late final Api api = Api(client: MockClient(_handle))
    ..baseUrl = 'http://sf157.test'
    ..path = '/m'
    ..token = ''
    ..sessionRelativeFilesSupported = sessionRelativeCapability
    ..filesImagePreviewSupported = imagePreviewCapability;

  Future<http.Response> _handle(http.Request request) async {
    final path = request.url.path;
    if (path == '/m/api/directories') {
      final dir = request.url.queryParameters['path'] ?? '';
      return _json({
        'ok': true,
        'path': dir,
        'dirs': dir == _root ? ['sub'] : <String>[],
        'files': files,
      });
    }
    if (path == '/m/api/files') {
      fileRequests.add(request.url.queryParameters['path'] ?? '');
      return http.Response.bytes(
        utf8.encode('line one\nline two\n'),
        200,
        headers: {'content-type': 'text/plain'},
      );
    }
    if (path == '/m/api/workspace-image') {
      imageRequests.add((
        sessionId: request.url.queryParameters['sessionId'] ?? '',
        path: request.url.queryParameters['path'] ?? '',
      ));
      return http.Response.bytes(
        _png1x1,
        200,
        headers: {'content-type': 'image/png', 'etag': '"e1"'},
      );
    }
    if (path == '/m/api/files/download') {
      // #138 下载通道：返回小文件字节（含 Range/HEAD 兼容的最小响应）。
      return http.Response.bytes(
        utf8.encode('hello'),
        200,
        headers: {
          'content-type': 'application/octet-stream',
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

int _pumpSeq = 0;

AppStore _store({String sessionId = 's1', String? cwd = _root}) {
  final store = AppStore();
  store.sessions = [Session(id: sessionId, title: 'S', cwd: cwd, createdAt: 1)];
  return store;
}

Future<void> _pump(
  WidgetTester tester,
  _Backend backend, {
  AppStore? store,
  Size? size,
  bool selectionMode = false,
  SessionFileDownloadController? downloader,
}) async {
  final appStore = store ?? _store();
  if (size != null) {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }
  final controller = SessionFilesController(
    store: appStore,
    sessionId: 's1',
    apiClient: backend.api,
  );
  await tester.pumpWidget(
    MaterialApp(
      // 每次挂载换 key：强制新 Navigator（否则上一轮 push 的路由会留在树上）。
      key: ValueKey<String>('sf157-app-${_pumpSeq++}'),
      home: SessionFilesScreen(
        store: appStore,
        sessionId: 's1',
        controller: controller,
        apiClient: backend.api,
        selectionMode: selectionMode,
        downloader: downloader,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

SessionFileDownloadController _downloader(_Backend backend, Directory temp) {
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
  );
  addTearDown(controller.dispose);
  return controller;
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('列表行图标与打开路径', () {
    testWidgets('图片行（png/jpg/gif/webp）显示 image 图标，文本行仍是文件图标', (
      tester,
    ) async {
      final backend = _Backend(
        files: ['a.png', 'b.JPG', 'c.gif', 'd.webp', 'e.txt', 'f.md'],
      );
      await _pump(tester, backend);

      for (final name in ['a.png', 'b.JPG', 'c.gif', 'd.webp']) {
        final tile = tester.widget<ListTile>(
          find.byKey(Key('sf-file-$name')),
        );
        expect(
          (tile.leading as Icon).icon,
          Icons.image_outlined,
          reason: '$name 应显示图片图标',
        );
      }
      for (final name in ['e.txt', 'f.md']) {
        final tile = tester.widget<ListTile>(
          find.byKey(Key('sf-file-$name')),
        );
        expect(
          (tile.leading as Icon).icon,
          Icons.description_outlined,
          reason: '$name 应仍是文本文件图标',
        );
      }
    });

    testWidgets('点图片行走 /workspace-image 全屏查看器（不进文本预览）', (
      tester,
    ) async {
      final backend = _Backend(files: ['photo.png']);
      await _pump(tester, backend);

      await tester.tap(find.byKey(const Key('sf-file-photo.png')));
      await _settle(tester);

      // 进了图片查看器，而不是 GitFileViewer 文本预览。
      expect(find.byType(SessionImagePreviewScreen), findsOneWidget);
      expect(find.byKey(const Key('sf-preview')), findsNothing);
      // 图片只走 /workspace-image（sessionId + cwd 相对路径），不走 /api/files。
      expect(backend.imageRequests, [
        (sessionId: 's1', path: 'photo.png'),
      ]);
      expect(backend.fileRequests, isEmpty);
      expect(find.byKey(const Key('sf-image-image')), findsOneWidget);
    });

    testWidgets('子目录中的图片：相对路径含目录前缀，绝对路径不外发', (tester) async {
      final backend = _Backend(files: ['deep.png']);
      await _pump(tester, backend);
      await tester.tap(find.byKey(const Key('sf-dir-sub')));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('sf-file-deep.png')));
      await _settle(tester);

      expect(backend.imageRequests.single.path, 'sub/deep.png');
      expect(backend.imageRequests.single.path.startsWith('/'), isFalse);
    });

    testWidgets('文本文件仍进原有文本预览（行走 /api/files，不进图片查看器）', (
      tester,
    ) async {
      final backend = _Backend(files: ['notes.txt']);
      await _pump(tester, backend);

      await tester.tap(find.byKey(const Key('sf-file-notes.txt')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('sf-preview')), findsOneWidget);
      expect(find.byType(SessionImagePreviewScreen), findsNothing);
      expect(backend.imageRequests, isEmpty);
      expect(backend.fileRequests, isNotEmpty);
    });

    testWidgets('目录点击行为不变（下钻不打开任何预览）', (tester) async {
      final backend = _Backend(files: ['a.png']);
      await _pump(tester, backend);
      await tester.tap(find.byKey(const Key('sf-dir-sub')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('sf-listing')), findsOneWidget);
      expect(find.byType(SessionImagePreviewScreen), findsNothing);
      expect(backend.imageRequests, isEmpty);
    });
  });

  group('已知不支持的图片格式', () {
    testWidgets('svg/heic/heif/avif：显示图片图标，点按给出不支持提示且不请求宿主', (
      tester,
    ) async {
      for (final name in ['logo.svg', 'photo.heic', 'photo.heif', 'photo.avif']) {
        final backend = _Backend(files: [name]);
        await _pump(tester, backend);

        final tile = tester.widget<ListTile>(find.byKey(Key('sf-file-$name')));
        expect((tile.leading as Icon).icon, Icons.image_outlined);

        await tester.tap(find.byKey(Key('sf-file-$name')));
        await _settle(tester);

        expect(
          find.byKey(const Key('sf-image-unsupported')),
          findsOneWidget,
          reason: '$name 应显示不支持提示',
        );
        expect(find.text('此格式暂不支持预览'), findsOneWidget);
        expect(backend.imageRequests, isEmpty, reason: '$name 不应请求 /workspace-image');
      }
    });

    testWidgets('不支持格式的查看器可关闭，回到文件列表', (tester) async {
      final backend = _Backend(files: ['logo.svg']);
      await _pump(tester, backend);
      await tester.tap(find.byKey(const Key('sf-file-logo.svg')));
      await _settle(tester);
      await tester.tap(find.byKey(const Key('sf-image-close')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('sf-listing')), findsOneWidget);
    });
  });

  group('能力位门控', () {
    testWidgets('imagePreview=false：图片行回退旧文本预览（不进图片查看器）', (
      tester,
    ) async {
      final backend = _Backend(
        files: ['photo.png'],
        imagePreviewCapability: false,
      );
      await _pump(tester, backend);
      expect(backend.api.filesImagePreviewSupported, isFalse);

      // 图标仍按扩展名显示（列表信息不受能力位影响）。
      final tile = tester.widget<ListTile>(
        find.byKey(const Key('sf-file-photo.png')),
      );
      expect((tile.leading as Icon).icon, Icons.image_outlined);

      await tester.tap(find.byKey(const Key('sf-file-photo.png')));
      await tester.pumpAndSettle();

      expect(find.byType(SessionImagePreviewScreen), findsNothing);
      expect(find.byKey(const Key('sf-preview')), findsOneWidget);
      expect(backend.imageRequests, isEmpty, reason: '旧宿主不得请求 /workspace-image');
      expect(backend.fileRequests, isNotEmpty);
    });

    testWidgets('sessionRelative=false：即使 imagePreview=true 也回退旧路径', (
      tester,
    ) async {
      final backend = _Backend(
        files: ['photo.png'],
        sessionRelativeCapability: false,
      );
      await _pump(tester, backend);

      await tester.tap(find.byKey(const Key('sf-file-photo.png')));
      await tester.pumpAndSettle();

      expect(find.byType(SessionImagePreviewScreen), findsNothing);
      expect(backend.imageRequests, isEmpty);
      expect(backend.fileRequests, isNotEmpty);
    });

    testWidgets('能力位在 bootstrap 后生效：先 false 后 true 才走图片通道', (tester) async {
      final backend = _Backend(
        files: ['photo.png'],
        imagePreviewCapability: false,
      );
      await _pump(tester, backend);

      // 模拟 SSE hello / bootstrap 下发能力位后重进页面。
      backend.api.applyCapabilities({
        'files': {'version': 1, 'sessionRelative': true, 'imagePreview': true},
      });
      expect(backend.api.filesImagePreviewSupported, isTrue);

      await tester.pumpWidget(const SizedBox.shrink());
      await _pump(tester, backend);
      await tester.tap(find.byKey(const Key('sf-file-photo.png')));
      await _settle(tester);
      expect(find.byType(SessionImagePreviewScreen), findsOneWidget);
      expect(backend.imageRequests, hasLength(1));
    });
  });

  group('下载与选择模式', () {
    testWidgets('生产路径（无注入 downloader）：下载按钮可见，未就绪时给明确提示', (
      tester,
    ) async {
      final backend = _Backend(files: ['photo.png']);
      await _pump(tester, backend);
      await tester.tap(find.byKey(const Key('sf-file-photo.png')));
      await _settle(tester);
      expect(find.byKey(const Key('sf-image-preview')), findsOneWidget);
      // widget 测试里 path_provider 不可用 → 下载组件未初始化；按钮仍可见（不制造
      // 「先进查看器就永远没有下载入口」的时序坑），点按给明确提示而不是静默失败。
      expect(find.byKey(const Key('sf-image-download')), findsOneWidget);
      await tester.tap(find.byKey(const Key('sf-image-download')));
      await _settle(tester);
      expect(tester.takeException(), isNull);
      // 组件未就绪：只给「下载失败：下载组件尚未就绪」，不谎报「已开始下载原图」。
      expect(find.textContaining('下载组件尚未就绪'), findsOneWidget);
      expect(find.textContaining('已开始下载原图'), findsNothing);
    });

    testWidgets('注入 downloader：查看器下载按钮复用 #138 流程', (tester) async {
      final temp = Directory.systemTemp.createTempSync('issue157-dl-');
      addTearDown(() => temp.deleteSync(recursive: true));
      final backend = _Backend(files: ['photo.png']);
      final downloader = _downloader(backend, temp);
      await _pump(tester, backend, downloader: downloader);
      await tester.tap(find.byKey(const Key('sf-file-photo.png')));
      await _settle(tester);

      final download = find.byKey(const Key('sf-image-download'));
      expect(download, findsOneWidget);
      await tester.runAsync(() async {
        await tester.tap(download);
        await Future<void>.delayed(const Duration(milliseconds: 200));
      });
      await _settle(tester);
      // 复用 #138 控制器（同一实例进入下载态），而不是另开一条图片通道。
      expect(
        downloader.absolutePath,
        '$_root/photo.png',
        reason: '下载按钮必须把同一绝对路径交给 #138 控制器',
      );
      expect(backend.imageRequests, hasLength(1), reason: '不重复请求图片字节');
    });

    testWidgets('selectionMode：查看器不显示下载按钮', (tester) async {
      final temp = Directory.systemTemp.createTempSync('issue157-sel-');
      addTearDown(() => temp.deleteSync(recursive: true));
      final backend = _Backend(files: ['photo.png']);
      final downloader = _downloader(backend, temp);
      await _pump(
        tester,
        backend,
        selectionMode: true,
        downloader: downloader,
      );
      await tester.tap(find.byKey(const Key('sf-file-photo.png')));
      await _settle(tester);

      expect(find.byKey(const Key('sf-image-preview')), findsOneWidget);
      expect(find.byKey(const Key('sf-image-download')), findsNothing);
      // 选择模式必须仍能选中图片（否则图片行是「只能关闭」的死胡同）。
      expect(find.byKey(const Key('sf-image-select')), findsOneWidget);
    });

    testWidgets('selectionMode：点「选择此文件」把绝对路径 pop 回调用方', (tester) async {
      final backend = _Backend(files: ['photo.png']);
      final store = _store();
      final controller = SessionFilesController(
        store: store,
        sessionId: 's1',
        apiClient: backend.api,
      );
      final nav = GlobalKey<NavigatorState>();
      String? picked;
      await tester.pumpWidget(
        MaterialApp(
          navigatorKey: nav,
          home: const Scaffold(body: Center(child: Text('宿主页'))),
        ),
      );
      unawaited(
        nav.currentState!
            .push<String?>(
              MaterialPageRoute<String?>(
                builder: (_) => SessionFilesScreen(
                  store: store,
                  sessionId: 's1',
                  controller: controller,
                  apiClient: backend.api,
                  selectionMode: true,
                ),
              ),
            )
            .then((value) => picked = value),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('sf-file-photo.png')));
      await _settle(tester);
      expect(find.byKey(const Key('sf-image-preview')), findsOneWidget);

      await tester.tap(find.byKey(const Key('sf-image-select')));
      await tester.pumpAndSettle();

      expect(find.text('宿主页'), findsOneWidget);
      expect(picked, '$_root/photo.png');
    });
  });

  testWidgets('320 窄屏：图片行与查看器无溢出', (tester) async {
    final backend = _Backend(files: ['a-very-long-image-file-name-here.png']);
    await _pump(tester, backend, size: const Size(320, 640));
    expect(tester.takeException(), isNull);

    await tester.tap(
      find.byKey(const Key('sf-file-a-very-long-image-file-name-here.png')),
    );
    await _settle(tester);
    expect(tester.takeException(), isNull);
    expect(find.byKey(const Key('sf-image-preview')), findsOneWidget);
    // 文件名单行省略，不溢出。
    final name = tester.widget<Text>(find.byKey(const Key('sf-image-name')));
    expect(name.maxLines, 1);
    expect(name.overflow, TextOverflow.ellipsis);
  });

  testWidgets('会话无 cwd：不进入图片预览，保持原有错误态', (tester) async {
    final backend = _Backend(files: ['photo.png']);
    await _pump(tester, backend, store: _store(cwd: null));
    expect(find.byKey(const Key('sf-error')), findsOneWidget);
    expect(find.byType(SessionImagePreviewScreen), findsNothing);
  });
}
