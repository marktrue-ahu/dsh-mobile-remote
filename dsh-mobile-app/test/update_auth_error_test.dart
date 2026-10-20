// 认证未配置 / 口令错误的专门文案（设计稿 §5.7 / §5.10、F21）：
// 宿主返回 401 auth-not-configured 时不能显示成通用网络错误，要提示用电脑连接页
// 二维码重扫一次；401 auth-required（口令错误）用另一条文案。
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/update_core.dart';
import 'package:dsh_mobile_app/updater.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const pluginHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const oldHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const hostBase = 'http://192.168.1.5:3080';
const mount = '/m';

Map<String, dynamic> releaseJson() => {
      'schema': 1,
      'manifestUrl': '$hostBase$mount/api/update/manifest',
      'app': {'version': '3.3.0+55', 'file': 'app.apk', 'size': 4096,
        'sha256': 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        'url': '$hostBase$mount/api/update/apk?release=r1'},
      'plugin': {'version': '3.3.0', 'file': 'plugin.tgz', 'size': 2048, 'sha256': oldHash,
        'contentSha256': pluginHash, 'url': '$hostBase$mount/api/update/plugin'},
    };

Map<String, dynamic> bootstrapJson() => {
      'plugin': {'version': '3.2.0', 'contentSha256': oldHash, 'instanceId': 'inst-0'},
      'pluginUpdate': {'state': 'unknown', 'canSelfUpdate': false, 'transaction': null},
    };

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('authFixHint', () {
    test('auth-required（普通情况）→ 重扫二维码；auth-not-configured（罕见）→ 检查状态目录权限', () {
      final notConfigured = ApiException('认证未配置', code: 'auth-not-configured', status: 401);
      final wrongToken = ApiException('访问口令未通过验证', code: 'auth-required', status: 401);
      expect(isAuthNotConfigured(notConfigured), isTrue);
      expect(isAuthNotConfigured(wrongToken), isFalse);
      expect(authFixHint(notConfigured), contains('状态目录'));
      expect(authFixHint(notConfigured), contains('权限'));
      expect(authFixHint(notConfigured), contains('无效'), reason: '重扫也拿不到口令');
      expect(authFixHint(wrongToken), contains('未通过验证'));
      expect(authFixHint(wrongToken), contains('连接页'));
      expect(authFixHint(wrongToken), contains('二维码'));
      expect(authFixHint(StateError('network down')), isNull);
    });

    test('detail 文本兼容：宿主只给中文"认证未配置"也按罕见故障文案处理', () {
      final e = ApiException('电脑端认证未配置，已拒绝访问', status: 401);
      expect(authFixHint(e), contains('状态目录'));
    });
  });

  test('提交插件更新遇到 401 auth-not-configured → 专门文案（不是"结果待确认/通用失败"）', () async {
    final client = Api(client: MockClient((_) async => http.Response(
      jsonEncode({'error': 'auth-not-configured', 'detail': '认证未配置'}),
      401,
      headers: {'content-type': 'application/json; charset=utf-8'},
    )))..baseUrl = hostBase;
    final store = AppStore(apiClient: client);
    addTearDown(store.dispose);
    await store.loadPrefs();

    await store.beginPluginUpdate();
    expect(store.pluginUpdateJournal, isNull, reason: '明确的 401 不本地保留"待确认"意图');
    expect(store.pluginUpdateNotice, contains('状态目录'));
    expect(store.pluginUpdateNotice, contains('权限'));
    expect(store.pluginUpdateNotice, isNot(contains('结果待确认')));
    expect(store.pluginUpdateNotice, isNot(contains('网络')));
  });

  test('检查主机清单遇到 401 auth-not-configured → 检查结果给重扫提示', () async {
    final client = Api(client: MockClient((request) async {
      if (request.url.path.endsWith('/bootstrap')) {
        return http.Response(jsonEncode(bootstrapJson()), 200);
      }
      return http.Response(jsonEncode({'error': 'auth-not-configured', 'detail': '认证未配置'}), 401,
          headers: {'content-type': 'application/json; charset=utf-8'});
    }))..baseUrl = hostBase;
    final store = AppStore(apiClient: client, localVersion: () async => parseAppVersion('3.2.0+44'));
    addTearDown(store.dispose);
    await store.loadPrefs();
    await store.setUpdateSource('host');
    client.absorbBootstrap(await client.getJson('/api/bootstrap'));

    final outcome = await Updater.check(store);
    expect(outcome.candidate, isNull);
    expect(outcome.error, contains('状态目录'));
    expect(outcome.error, contains('权限'));
  });

  test('固定发布下载遇到 401 → 失败分类为认证（不退出旧目标，重扫或修权限后重试）', () {
    final notConfigured = artifactFailure(401, code: 'auth-not-configured');
    expect(notConfigured.authFailure, isTrue);
    expect(notConfigured.targetGone, isFalse);
    expect(notConfigured.message, contains('状态目录'));
    final required = artifactFailure(401, code: 'auth-required');
    expect(required.authFailure, isTrue);
    expect(required.message, contains('二维码'));
    final generic = artifactFailure(500);
    expect(generic.authFailure, isFalse, reason: '403/5xx 不按认证文案处理（契约只分流 401）');
  });

  test('release() 夹具仍使用宿主投影地址（防止测试误把外部资产地址当固定目标）', () {
    expect(fixedArtifactUrlIssue(ReleaseSnapshot.fromJson(releaseJson())!), isNull);
    expect(
      fixedArtifactUrlIssue(ReleaseSnapshot.fromJson(releaseJson()..['app']['url'] = 'https://github.com/x/y.apk')!),
      contains('固定目标'),
    );
  });
}
