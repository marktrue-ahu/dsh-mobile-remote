// GitLab #138：会话文件下载控制器的最小单测（真实 ResumableDownloads + MockClient）。
import 'dart:async';
import 'dart:io';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/resumable_download.dart';
import 'package:dsh_mobile_app/session_file_download.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class _PauseResumeClient extends http.BaseClient {
  _PauseResumeClient(this.bytes);

  final List<int> bytes;
  int calls = 0;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    calls++;
    final range = request.headers['range'];
    if (range == null) {
      final controller = StreamController<List<int>>();
      controller.add(bytes.take(10).toList());
      // 不关闭流：模拟慢网络，等用户暂停。
      return http.StreamedResponse(
        controller.stream,
        200,
        contentLength: bytes.length,
        headers: {'etag': '"abc"', 'content-type': 'application/octet-stream'},
      );
    }
    final start = int.parse(
      RegExp(r'bytes=(\d+)-').firstMatch(range)!.group(1)!,
    );
    return http.StreamedResponse(
      Stream<List<int>>.value(bytes.sublist(start)),
      206,
      contentLength: bytes.length - start,
      headers: {
        'etag': '"abc"',
        'content-type': 'application/octet-stream',
        'content-range': 'bytes $start-${bytes.length - 1}/${bytes.length}',
      },
    );
  }
}

Future<void> _waitFor(bool Function() condition) async {
  for (var i = 0; i < 200; i++) {
    if (condition()) return;
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  fail('等待超时');
}

void main() {
  late Directory temp;

  setUp(() {
    temp = Directory.systemTemp.createTempSync('file-download-test-');
  });

  tearDown(() {
    if (temp.existsSync()) temp.deleteSync(recursive: true);
  });

  late MockClient mockClient;

  Api apiWith(Future<http.Response> Function(http.Request) handler) {
    mockClient = MockClient(handler);
    return Api(client: mockClient)
      ..baseUrl = 'http://files.test'
      ..path = '/m'
      ..token = 'token';
  }

  test('成功下载：只用 sessionId + cwd 相对路径；保存后清理断点', () async {
    final bytes = List<int>.generate(2048, (i) => i % 256);
    final requests = <Uri>[];
    final api = apiWith((request) async {
      requests.add(request.url);
      return http.Response.bytes(
        bytes,
        200,
        headers: {
          'etag': '"abc"',
          'content-type': 'application/octet-stream',
          'content-length': '${bytes.length}',
        },
      );
    });
    final downloads = ResumableDownloads(
      Directory('${temp.path}/downloads'),
      api,
    );
    final controller = SessionFileDownloadController(
      api: api,
      sessionId: 'session-1',
      root: '/work',
      downloads: downloads,
      saveFile: (file, name) async => '/saved/$name',
      downloadClient: mockClient,
    );
    addTearDown(controller.dispose);

    expect(await controller.start('/work/sub/file.bin'), isTrue);
    expect(controller.phase, SessionFileDownloadPhase.done);
    expect(controller.savedPath, '/saved/file.bin');
    expect(requests, isNotEmpty);
    expect(requests.single.queryParameters['sessionId'], 'session-1');
    expect(requests.single.queryParameters['path'], 'sub/file.bin');
    expect(await downloads.pending(), isEmpty, reason: '完成后不应残留 pending');
  });

  test('路径不在 cwd：零请求、明确失败', () async {
    final requests = <Uri>[];
    final api = apiWith((request) async {
      requests.add(request.url);
      return http.Response('should not request', 500);
    });
    final downloads = ResumableDownloads(
      Directory('${temp.path}/downloads'),
      api,
    );
    final controller = SessionFileDownloadController(
      api: api,
      sessionId: 'session-1',
      root: '/work',
      downloads: downloads,
      saveFile: (file, name) async => '/saved/$name',
      downloadClient: mockClient,
    );
    addTearDown(controller.dispose);

    await controller.start('/etc/passwd');
    expect(controller.phase, SessionFileDownloadPhase.failed);
    expect(requests, isEmpty);
  });

  test('暂停保留断点，继续用 Range 续传完成', () async {
    final bytes = List<int>.generate(64, (i) => i);
    final client = _PauseResumeClient(bytes);
    final api = Api(client: client)
      ..baseUrl = 'http://files.test'
      ..path = '/m'
      ..token = 'token';
    final downloads = ResumableDownloads(
      Directory('${temp.path}/downloads'),
      api,
    );
    final controller = SessionFileDownloadController(
      api: api,
      sessionId: 'session-1',
      root: '/work',
      downloads: downloads,
      saveFile: (file, name) async => '/saved/$name',
      downloadClient: client,
    );
    addTearDown(controller.dispose);

    final running = controller.start('/work/file.bin');
    await _waitFor(() => controller.progress.received > 0);
    controller.pause();
    await running;
    expect(controller.phase, SessionFileDownloadPhase.paused);
    final pending = await downloads.pending();
    expect(pending.single.bytes, greaterThan(0));

    await controller.retry();
    expect(controller.phase, SessionFileDownloadPhase.done);
    expect(client.calls, greaterThanOrEqualTo(2));
    expect(controller.savedPath, '/saved/file.bin');
  });

  test('服务端拒绝 → failed + 可读 failure', () async {
    final api = apiWith((request) async => http.Response(
      '{"error":"path-outside-workspace"}',
      403,
      headers: {'content-type': 'application/json'},
    ));
    final downloads = ResumableDownloads(
      Directory('${temp.path}/downloads'),
      api,
    );
    final controller = SessionFileDownloadController(
      api: api,
      sessionId: 'session-1',
      root: '/work',
      downloads: downloads,
      saveFile: (file, name) async => '/saved/$name',
      downloadClient: mockClient,
    );
    addTearDown(controller.dispose);

    await controller.start('/work/file.bin');
    expect(controller.phase, SessionFileDownloadPhase.failed);
    expect(controller.failure, isNotNull);
    expect(controller.failure!.summary, isNotEmpty);
  });
}
