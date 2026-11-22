// issue #157：会话文件图片全屏预览屏 widget 契约。
//
// 覆盖：加载态 → 成功（图片 + 元信息条）；304 无缓存 → 错误；非图片 content-type →
// 不支持提示；ApiException 各稳定错误码 → 对应文案 + 重试；重试真的重新请求；
// ETag 命中 304 复缓存；双击缩放/复位；关闭；Semantics；下载按钮复用回调；
// 以及「不支持格式不请求宿主」。
//
// 全部走 MockClient（真实 Api.workspaceImage）+ 注入 cache，不触真实网络。

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/screens/session_image_preview_screen.dart';
import 'package:dsh_mobile_app/session_image_cache.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 合法 1x1 PNG。
final Uint8List _png1x1 = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4z8AAAAMBAQD3A0FDAAAAAElFTkSuQmCC',
);

/// 1920x1080 PNG（只改 IHDR 宽高，其余字节沿用上面的合法 PNG）。
Uint8List _png1920x1080() {
  final bytes = Uint8List.fromList(_png1x1);
  bytes[16] = 0;
  bytes[17] = 0;
  bytes[18] = 0x07;
  bytes[19] = 0x80;
  bytes[20] = 0;
  bytes[21] = 0;
  bytes[22] = 0x04;
  bytes[23] = 0x38;
  return bytes;
}

/// `/workspace-image` 假后端：可控制字节/类型/ETag/失败次数/挂起。
class _Backend {
  _Backend({
    Uint8List? bytes,
    this.contentType = 'image/png',
    this.etag = '"etag-1"',
    this.status,
    this.errorCode,
    this.failures = 0,
    this.alwaysFail = false,
    this.firstRequestNotModified = false,
  }) : bytes = bytes ?? _png1x1;

  Uint8List bytes;
  String? contentType;
  String? etag;
  int? status;
  String? errorCode;
  /// 前 N 次请求失败（之后成功），用于测重试。
  int failures;

  /// 每次都失败，用于逐错误码断言文案。
  bool alwaysFail;

  /// 首次请求就回 304（宿主不校验 If-None-Match 的畸形/竞态场景）。
  bool firstRequestNotModified;

  int requests = 0;
  final List<Map<String, String>> seenHeaders = [];
  final List<String> seenPaths = [];
  Completer<http.Response>? gate;

  late final Api api = Api(client: MockClient(_handle))
    ..baseUrl = 'http://img.test'
    ..path = '/m'
    ..token = 'tk'
    ..appVersion = '1.0.0'
    ..profileId = 'p-test'
    ..sessionRelativeFilesSupported = true
    ..filesImagePreviewSupported = true;

  Future<http.Response> _handle(http.Request request) async {
    expect(request.url.path, '/m/api/workspace-image');
    requests += 1;
    seenHeaders.add(request.headers);
    seenPaths.add(request.url.queryParameters['path'] ?? '');
    final pending = gate;
    if (pending != null) return pending.future;
    if (failures > 0) {
      failures -= 1;
      return _errorResponse(
        status ?? 500,
        errorCode ?? 'internal-error',
      );
    }
    if (alwaysFail) {
      return _errorResponse(status ?? 500, errorCode ?? 'internal-error');
    }
    if (firstRequestNotModified) return http.Response('', 304, headers: {});
    final inm = request.headers['if-none-match'];
    // 按 If-None-Match 复核 ETag → 304（真实宿主行为）。
    if (inm != null && etag != null && inm == etag) {
      return http.Response('', 304, headers: {'etag': etag!});
    }
    return http.Response.bytes(
      bytes,
      200,
      headers: {
        'content-type': ?contentType,
        'etag': ?etag,
      },
    );
  }

  static http.Response _errorResponse(int status, String code) =>
      http.Response(
        jsonEncode({'ok': false, 'error': code, 'detail': code}),
        status,
        headers: {'content-type': 'application/json'},
      );
}

int _pumpSeq = 0;

Future<void> _pump(
  WidgetTester tester,
  _Backend backend, {
  Key? key,
  String name = 'photo.png',
  String relativePath = 'pics/photo.png',
  String? unsupportedReason,
  Future<void> Function()? onDownload,
  SessionImageCache? cache,
  Size? size,
}) async {
  if (size != null) {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }
  await tester.pumpWidget(
    MaterialApp(
      home: SessionImagePreviewScreen(
        // 每次挂载都换 key：避免同类型 widget 复用 State（否则不会重新请求）。
        key: key ?? ValueKey<String>('sf-image-pump-${_pumpSeq++}'),
        api: backend.api,
        sessionId: 's1',
        name: name,
        relativePath: relativePath,
        unsupportedReason: unsupportedReason,
        onDownload: onDownload,
        cache: cache ?? SessionImageCache(),
      ),
    ),
  );
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

String _metaText(WidgetTester tester) =>
    tester.widget<Text>(find.byKey(const Key('sf-image-meta'))).data ?? '';

/// 读取实际生效的解码宽度上限（`Image.memory(cacheWidth:)` 在 SDK 里被包成
/// `ResizeImage`；未降采样时 provider 是普通 `MemoryImage`）。
int? _decodeWidthOf(WidgetTester tester) {
  final provider = tester
      .widget<Image>(find.byKey(const Key('sf-image-image')))
      .image;
  return provider is ResizeImage ? provider.width : null;
}

void main() {
  testWidgets('加载中 → 成功：显示图片与元信息条（格式/宽×高/大小/相对路径）', (
    tester,
  ) async {
    final backend = _Backend(bytes: _png1920x1080())..gate = Completer();
    await _pump(tester, backend);
    await tester.pump();

    // 顶部文件名与关闭按钮在加载态就可见（可关闭）。
    expect(find.byKey(const Key('sf-image-name')), findsOneWidget);
    expect(find.text('photo.png'), findsOneWidget);
    expect(find.byKey(const Key('sf-image-close')), findsOneWidget);
    expect(find.byKey(const Key('sf-image-loading')), findsOneWidget);

    backend.gate!.complete(
      http.Response.bytes(
        backend.bytes,
        200,
        headers: {'content-type': 'image/png', 'etag': '"etag-1"'},
      ),
    );
    backend.gate = null;
    await _settle(tester);

    expect(find.byKey(const Key('sf-image-loading')), findsNothing);
    expect(find.byKey(const Key('sf-image-image')), findsOneWidget);
    final image = tester.widget<Image>(
      find.byKey(const Key('sf-image-image')),
    );
    expect((image.image as MemoryImage).bytes, backend.bytes);
    expect(image.semanticLabel, '查看图片 photo.png');
    // 元信息条：格式 · 宽×高 · 字节数 · 相对路径；不显示 EXIF。
    final meta = _metaText(tester);
    expect(meta, contains('PNG'));
    expect(meta, contains('1920×1080'));
    expect(meta, contains('69 B'));
    expect(meta, contains('pics/photo.png'));
    expect(meta, isNot(contains('EXIF')));
    // 请求参数：sessionId + cwd 相对路径（不是绝对路径）。
    expect(backend.seenPaths.single, 'pics/photo.png');
    expect(backend.seenHeaders.single['x-mobile-token'], 'tk');
  });

  testWidgets('不解码降采样：小图 cacheWidth 为 null；大图按视口限宽 ≤4096', (tester) async {
    final small = _Backend(bytes: _png1x1);
    await _pump(tester, small);
    await _settle(tester);
    expect(_decodeWidthOf(tester), isNull, reason: '图片本身不超过上限时不降采样');

    final big = _Backend(bytes: _png1920x1080());
    await _pump(tester, big, relativePath: 'pics/b.png', size: const Size(390, 844));
    await _settle(tester);
    final cacheWidth = _decodeWidthOf(tester);
    // 390dp * 1.0 dpr * 2 = 780 < 1920 → 降采样到 780。
    expect(cacheWidth, isNotNull);
    expect(cacheWidth, lessThanOrEqualTo(4096));
    expect(cacheWidth, greaterThanOrEqualTo(512));
  });

  testWidgets('GIF 不按视口降采样（动图逐帧缩放不稳，且要自动播放）', (tester) async {
    final gif = base64Decode(
      'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    );
    final backend = _Backend(bytes: gif, contentType: 'image/gif');
    await _pump(tester, backend, name: 'anim.gif', relativePath: 'a/anim.gif');
    await _settle(tester);
    expect(_decodeWidthOf(tester), isNull);
    expect(_metaText(tester), contains('GIF'));
    expect(_metaText(tester), contains('GIF 动图会自动播放'));
  });

  testWidgets('304 且无缓存 → 明确错误 + 重试（不白屏）', (tester) async {
    // 畸形/竞态宿主：不校验 If-None-Match，对首次请求就回 304，而本地没有缓存字节。
    final backend = _Backend(firstRequestNotModified: true);
    await _pump(tester, backend, cache: SessionImageCache());
    await _settle(tester);

    expect(backend.requests, 1);
    expect(find.byKey(const Key('sf-image-error')), findsOneWidget);
    expect(find.text('文件为空或已被删除'), findsOneWidget);
    expect(find.byKey(const Key('sf-image-retry')), findsOneWidget);
    expect(find.byKey(const Key('sf-image-image')), findsNothing);
  });

  testWidgets('非图片 content-type → 不支持提示（不渲染 Image）', (tester) async {
    final backend = _Backend(contentType: 'application/pdf');
    await _pump(tester, backend, name: 'doc.pdf');
    await _settle(tester);

    expect(find.byKey(const Key('sf-image-error')), findsOneWidget);
    expect(find.byKey(const Key('sf-image-image')), findsNothing);
    expect(find.text('此格式暂不支持预览，可下载原图'), findsOneWidget);
    expect(find.byKey(const Key('sf-image-retry')), findsOneWidget);
    expect(backend.requests, 1);
  });

  testWidgets('空字节 → image-not-found 文案', (tester) async {
    final backend = _Backend(bytes: Uint8List(0), contentType: 'image/png');
    await _pump(tester, backend);
    await _settle(tester);
    expect(find.byKey(const Key('sf-image-error')), findsOneWidget);
    expect(find.text('文件为空或已被删除'), findsOneWidget);
  });

  testWidgets('ApiException 各错误码 → 对应文案 + 重试按钮', (tester) async {
    final cases = <String, (int, String)>{
      'image-too-large': (413, '图片过大，无法预览'),
      'unsupported-image-type': (415, '此格式暂不支持预览'),
      'image-not-found': (404, '文件为空或已被删除'),
      'path-outside-workspace': (403, '无法访问该图片'),
      'workspace-not-authorized': (403, '无法访问该图片'),
      'consent-required': (403, '无法访问该图片'),
      'image-verification-unavailable': (501, '当前电脑端无法安全校验图片'),
      'totally-unknown': (500, '无法预览此图片'),
    };
    for (final entry in cases.entries) {
      final backend = _Backend(
        status: entry.value.$1,
        errorCode: entry.key,
        alwaysFail: true,
      );
      await _pump(tester, backend);
      await _settle(tester);
      expect(
        find.text(entry.value.$2),
        findsOneWidget,
        reason: '${entry.key} 应显示「${entry.value.$2}」',
      );
      expect(find.byKey(const Key('sf-image-retry')), findsOneWidget);
    }
  });

  testWidgets('重试真的重新请求；成功后清除错误态', (tester) async {
    final backend = _Backend(failures: 1, status: 500, errorCode: 'boom');
    await _pump(tester, backend);
    await _settle(tester);

    expect(find.byKey(const Key('sf-image-error')), findsOneWidget);
    expect(backend.requests, 1);

    await tester.tap(find.byKey(const Key('sf-image-retry')));
    await _settle(tester);

    expect(backend.requests, 2);
    expect(find.byKey(const Key('sf-image-error')), findsNothing);
    expect(find.byKey(const Key('sf-image-image')), findsOneWidget);
  });

  testWidgets('ETag 复用：第二次打开发 If-None-Match，304 用缓存字节渲染', (tester) async {
    final backend = _Backend(etag: '"etag-1"');
    final cache = SessionImageCache();
    await _pump(tester, backend, cache: cache);
    await _settle(tester);
    expect(backend.requests, 1);
    expect(backend.seenHeaders.single['if-none-match'], isNull);

    // 重新进入同一张图（共享缓存）：带 If-None-Match，宿主 304。
    await _pump(tester, backend, cache: cache);
    await _settle(tester);
    expect(backend.requests, 2);
    expect(backend.seenHeaders.last['if-none-match'], '"etag-1"');
    expect(find.byKey(const Key('sf-image-image')), findsOneWidget);
  });

  testWidgets('双击放大到 2x，再次双击复位', (tester) async {
    final backend = _Backend();
    await _pump(tester, backend);
    await _settle(tester);

    final viewerFinder = find.byKey(const Key('sf-image-viewer'));
    final viewer = tester.widget<InteractiveViewer>(viewerFinder);
    expect(viewer.minScale, 0.5);
    expect(viewer.maxScale, 4.0);
    final controller = viewer.transformationController!;
    expect(controller.value.getMaxScaleOnAxis(), 1.0);

    await tester.tap(viewerFinder);
    await tester.pump(const Duration(milliseconds: 40));
    await tester.tap(viewerFinder);
    await tester.pumpAndSettle();
    expect(controller.value.getMaxScaleOnAxis(), greaterThan(1.5));

    await tester.tap(viewerFinder);
    await tester.pump(const Duration(milliseconds: 40));
    await tester.tap(viewerFinder);
    await tester.pumpAndSettle();
    expect(controller.value.getMaxScaleOnAxis(), 1.0);
  });

  testWidgets('关闭按钮返回上一页', (tester) async {
    final backend = _Backend();
    final nav = GlobalKey<NavigatorState>();
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: nav,
        home: const Scaffold(body: Center(child: Text('宿主页'))),
      ),
    );
    unawaited(
      nav.currentState!.push<void>(
        MaterialPageRoute<void>(
          builder: (_) => SessionImagePreviewScreen(
            api: backend.api,
            sessionId: 's1',
            name: 'photo.png',
            relativePath: 'pics/photo.png',
            cache: SessionImageCache(),
          ),
        ),
      ),
    );
    await _settle(tester);
    expect(find.byKey(const Key('sf-image-preview')), findsOneWidget);

    await tester.tap(find.byKey(const Key('sf-image-close')));
    await tester.pumpAndSettle();
    expect(find.text('宿主页'), findsOneWidget);
    expect(find.byKey(const Key('sf-image-preview')), findsNothing);
  });

  testWidgets('Semantics：图片标签为「查看图片 <文件名>」', (tester) async {
    final handle = tester.ensureSemantics();
    final backend = _Backend();
    await _pump(tester, backend, name: '风景.png', relativePath: 'p/风景.png');
    await _settle(tester);
    expect(find.bySemanticsLabel('查看图片 风景.png'), findsOneWidget);
    handle.dispose();
  });

  testWidgets('不支持格式（SVG/HEIC）：给出原因且不请求宿主', (tester) async {
    final backend = _Backend();
    await _pump(
      tester,
      backend,
      name: 'logo.svg',
      relativePath: 'img/logo.svg',
      unsupportedReason: '此格式暂不支持预览',
    );
    await _settle(tester);

    expect(find.byKey(const Key('sf-image-unsupported')), findsOneWidget);
    expect(find.text('此格式暂不支持预览'), findsOneWidget);
    expect(backend.requests, 0, reason: '已知不支持格式不应请求 /workspace-image');
  });

  testWidgets('下载按钮：配置回调时显示并触发；未配置时隐藏', (tester) async {
    var downloads = 0;
    final backend = _Backend();
    await _pump(tester, backend, onDownload: () async => downloads += 1);
    await _settle(tester);
    final button = find.byKey(const Key('sf-image-download'));
    expect(button, findsOneWidget);
    await tester.tap(button);
    await _settle(tester);
    expect(downloads, 1);

    await _pump(tester, _Backend());
    await _settle(tester);
    expect(find.byKey(const Key('sf-image-download')), findsNothing);
  });

  testWidgets('下载失败不崩，给出提示', (tester) async {
    final backend = _Backend();
    await _pump(
      tester,
      backend,
      onDownload: () async => throw StateError('no space'),
    );
    await _settle(tester);
    await tester.tap(find.byKey(const Key('sf-image-download')));
    await _settle(tester);
    expect(tester.takeException(), isNull);
    expect(find.textContaining('下载失败：'), findsOneWidget);
  });

  testWidgets('相对路径为空：不发请求，直接 accessDenied 错误态', (tester) async {
    final backend = _Backend();
    await _pump(tester, backend, relativePath: '');
    await _settle(tester);
    expect(backend.requests, 0);
    expect(find.byKey(const Key('sf-image-error')), findsOneWidget);
    expect(find.text('无法访问该图片'), findsOneWidget);
  });

  testWidgets('320 窄屏 / 2.0× 大字号：元信息条两行、无溢出', (tester) async {
    final backend = _Backend(bytes: _png1920x1080());
    tester.platformDispatcher.textScaleFactorTestValue = 2.0;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await _pump(tester, backend, size: const Size(320, 640));
    await _settle(tester);

    expect(tester.takeException(), isNull);
    final meta = tester.widget<Text>(find.byKey(const Key('sf-image-meta')));
    expect(meta.maxLines, 2);
    expect(meta.overflow, TextOverflow.ellipsis);
    // 关闭/下载按钮都在（不重叠、可点）。
    expect(find.byKey(const Key('sf-image-close')), findsOneWidget);
  });
}
