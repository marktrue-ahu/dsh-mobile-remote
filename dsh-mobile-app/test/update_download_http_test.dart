import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:dsh_mobile_app/update_core.dart';
import 'package:dsh_mobile_app/updater.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  var installs = 0;
  setUp(() {
    installs = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('dsh/update'), (call) async {
        if (call.method == 'installApk') { installs++; return null; }
        return 'same-signature';
      });
  });
  tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
    .setMockMethodCallHandler(const MethodChannel('dsh/update'), null));

  test('fixed artifact requires exact size as well as SHA; same URL replaced bytes never install', () async {
    final dir = await Directory.systemTemp.createTemp('issue32-download-');
    addTearDown(() async {
      expect(dir.path, startsWith('${Directory.systemTemp.path}/issue32-download-'));
      await dir.delete(recursive: true);
    });
    final bytes = [1, 2, 3, 4];
    final digest = sha256.convert(bytes).toString();
    Future<String?> download({required int size, required List<int> body}) => Updater.downloadAndInstall(
      UpdateCandidate(version: '3.3.0+55', downloadUrl: 'https://custom.example/fixed.apk',
        sizeBytes: size, sha256: digest, source: 'custom'), temporaryDirectory: dir,
      downloadClient: MockClient((_) async => http.Response.bytes(body, 200)));
    expect(await download(size: 8, body: bytes), isNotNull);
    expect(installs, 0);
    expect(await download(size: 4, body: [4, 3, 2, 1]), contains('校验失败'));
    expect(installs, 0);
    expect(await download(size: 4, body: bytes), isNull);
    expect(installs, 1);
  });

  test('固定目标错误码分流：410/404/400 退出旧目标，503 保留重试，401 认证专门文案', () async {
    final dir = await Directory.systemTemp.createTemp('issue32-artifact-');
    addTearDown(() async {
      expect(dir.path, startsWith('${Directory.systemTemp.path}/issue32-artifact-'));
      await dir.delete(recursive: true);
    });
    UpdateFailure? captured;
    Future<String?> fetch(int status, String? error) => Updater.downloadAndInstall(
      UpdateCandidate(version: '3.3.0+55', downloadUrl: 'http://192.168.1.5:3080/m/api/update/apk?release=r1',
        source: '主机'),
      temporaryDirectory: dir,
      downloadClient: MockClient((_) async => http.Response(
        jsonEncode({'error': ?error}),
        status,
        headers: {'content-type': 'application/json; charset=utf-8'},
      )),
      onFailure: (f) => captured = f,
    );

    expect(await fetch(410, 'app-artifact-expired'), contains('已过期'));
    expect(captured?.code, 'app-artifact-expired');
    expect(captured?.targetGone, isTrue);
    expect(captured?.notReady, isFalse);

    expect(await fetch(404, 'app-artifact-unknown'), contains('固定目标'));
    expect(captured?.targetGone, isTrue);

    expect(await fetch(400, 'bad-request'), contains('标识无效'));
    expect(captured?.targetGone, isTrue);

    expect(await fetch(503, 'app-artifact-not-ready'), contains('尚未就绪'));
    expect(captured?.notReady, isTrue);
    expect(captured?.targetGone, isFalse);

    expect(await fetch(401, 'auth-required'), contains('连接页'));
    expect(captured?.authFailure, isTrue);
    expect(captured?.targetGone, isFalse);
    expect(installs, 0, reason: '错误码分流都在安装器之前');
  });

  test('拉起安装器前的异步复核（§5.9）：复核拒绝时不安装并清理半成品', () async {
    final dir = await Directory.systemTemp.createTemp('issue32-recheck-');
    addTearDown(() async {
      expect(dir.path, startsWith('${Directory.systemTemp.path}/issue32-recheck-'));
      await dir.delete(recursive: true);
    });
    final bytes = [1, 2, 3, 4];
    final digest = sha256.convert(bytes).toString();
    var rechecks = 0;
    final result = await Updater.downloadAndInstall(
      UpdateCandidate(version: '3.3.0+55', downloadUrl: 'http://192.168.1.5:3080/m/api/update/apk?release=r1',
        sizeBytes: 4, sha256: digest, source: '主机'),
      temporaryDirectory: dir,
      downloadClient: MockClient((_) async => http.Response.bytes(bytes, 200)),
      beforeInstall: () async {
        rechecks++;
        return '插件状态已变化，已取消 App 安装；请重试确认';
      },
    );
    expect(rechecks, 1, reason: '校验/签名之后、拉起安装器之前必须重新复核一次');
    expect(result, contains('插件状态已变化'));
    expect(installs, 0);
    final leftovers = dir
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.endsWith('.apk'))
        .toList();
    expect(leftovers, isEmpty, reason: '拒绝安装时半成品必须清理');
  });

  test('拉起安装器前的复核通过 → 正常安装', () async {
    final dir = await Directory.systemTemp.createTemp('issue32-recheck-ok-');
    addTearDown(() async {
      expect(dir.path, startsWith('${Directory.systemTemp.path}/issue32-recheck-ok-'));
      await dir.delete(recursive: true);
    });
    final bytes = [1, 2, 3, 4];
    final digest = sha256.convert(bytes).toString();
    final result = await Updater.downloadAndInstall(
      UpdateCandidate(version: '3.3.0+55', downloadUrl: 'http://192.168.1.5:3080/m/api/update/apk?release=r1',
        sizeBytes: 4, sha256: digest, source: '主机'),
      temporaryDirectory: dir,
      downloadClient: MockClient((_) async => http.Response.bytes(bytes, 200)),
      beforeInstall: () async => null,
    );
    expect(result, isNull);
    expect(installs, 1);
  });
}
