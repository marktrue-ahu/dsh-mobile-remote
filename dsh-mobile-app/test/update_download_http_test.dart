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
}
