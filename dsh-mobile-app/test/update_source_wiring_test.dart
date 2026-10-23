// 来源接线（设计稿 §5.6 / §5.9、F04 / F19）：App 只消费宿主投影的**固定目标绝对地址**，
// 不再直连 GitHub、不自行拼 Release 资产地址；旧版本留下的外部地址要明确拒绝并给迁移提示。
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/update_core.dart';
import 'package:dsh_mobile_app/updater.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

const pluginHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const apkHash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const oldHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const hostBase = 'http://192.168.1.5:3080';
const mount = '/m';

String fixedAppUrl({String releaseId = 'r1'}) =>
    '$hostBase$mount/api/update/apk?release=$releaseId&sha256=$apkHash';

Map<String, dynamic> releaseJson({String? appUrl, String version = '3.3.0+55'}) => {
      'schema': 1,
      'manifestUrl': '$hostBase$mount/api/update/manifest',
      'app': {'version': version, 'file': 'app.apk', 'size': 4096, 'sha256': apkHash, 'url': appUrl ?? fixedAppUrl()},
      'plugin': {'version': '3.3.0', 'file': 'plugin.tgz', 'size': 2048, 'sha256': oldHash,
        'contentSha256': pluginHash, 'url': '$hostBase$mount/api/update/plugin'},
    };

Map<String, dynamic> pointerJson({String releaseId = 'r1', Map<String, dynamic>? release}) => {
      'releaseId': releaseId,
      'release': release ?? releaseJson(),
    };

Map<String, dynamic> bootstrapJson({
  String state = 'up-to-date',
  Map<String, dynamic>? currentRelease,
  Map<String, dynamic>? updateTarget,
  Map<String, dynamic>? release,
  Map<String, dynamic>? transaction,
  String loaded = pluginHash,
}) => {
      'plugin': {'version': '3.3.0', 'contentSha256': loaded, 'instanceId': 'inst-1'},
      'pluginUpdate': {
        'state': state,
        'canSelfUpdate': true,
        'release': ?release,
        'transaction': transaction,
      },
      'currentRelease': currentRelease,
      'updateTarget': updateTarget,
    };

void localVersion(String version, String build) => PackageInfo.setMockInitialValues(
      appName: 'DSH', packageName: 'com.dsh.remote', version: version, buildNumber: build, buildSignature: '',
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    localVersion('3.2.0', '44');
  });

  test('F04: 自动来源（原 GitHub）的候选也只消费宿主固定地址，不访问 GitHub 资产', () async {
    final requests = <String>[];
    final client = Api(client: MockClient((request) async {
      requests.add(request.url.toString());
      return http.Response(jsonEncode(bootstrapJson(currentRelease: pointerJson())), 200);
    }))..baseUrl = hostBase;
    final store = AppStore(apiClient: client);
    addTearDown(store.dispose);
    await store.loadPrefs();
    client.absorbBootstrap(await client.getJson('/api/bootstrap'));

    final outcome = await Updater.check(store);
    expect(outcome.verdict, UpdateVerdict.updateAvailable);
    expect(outcome.candidate?.downloadUrl, fixedAppUrl(),
        reason: '下载地址只取宿主下发的 release.app.url（含宿主拼好的固定目标 query）');
    expect(outcome.candidate?.sha256, apkHash);
    expect(requests, hasLength(1), reason: 'check 只读本地固定快照，不再额外查外部源');
    expect(requests.every((u) => !u.contains('github')), isTrue,
        reason: '不得请求 GitHub / 拼 GitHub 资产地址');
  });

  test('插件有内容更新时优先消费宿主 updateTarget（固定目标仍是宿主地址）', () async {
    final client = Api(client: MockClient((_) async => http.Response(jsonEncode(bootstrapJson(
      state: 'update-available',
      currentRelease: pointerJson(release: releaseJson(version: '3.2.0+44')),
      updateTarget: pointerJson(releaseId: 'r2', release: releaseJson(appUrl: fixedAppUrl(releaseId: 'r2'))),
    )), 200)))..baseUrl = hostBase;
    final store = AppStore(apiClient: client);
    addTearDown(store.dispose);
    await store.loadPrefs();
    client.absorbBootstrap(await client.getJson('/api/bootstrap'));

    expect(store.hostReleasePointer?.releaseId, 'r2');
    final outcome = await Updater.check(store);
    expect(outcome.verdict, UpdateVerdict.updateAvailable);
    expect(outcome.candidate?.downloadUrl, fixedAppUrl(releaseId: 'r2'));
  });

  test('旧宿主兼容：只给 pluginUpdate.release 时沿用（地址同样由宿主投影）', () async {
    final client = Api(client: MockClient((_) async => http.Response(jsonEncode(bootstrapJson(
      release: releaseJson(),
    )), 200)))..baseUrl = hostBase;
    final store = AppStore(apiClient: client);
    addTearDown(store.dispose);
    await store.loadPrefs();
    client.absorbBootstrap(await client.getJson('/api/bootstrap'));

    final outcome = await Updater.check(store);
    expect(outcome.error, isNull);
    expect(outcome.candidate?.downloadUrl, fixedAppUrl());
  });

  test('F19: 旧快照里的 GitHub 资产地址被明确拒绝（不复用、不改写、不自行拼接）', () async {
    final client = Api(client: MockClient((_) async => http.Response(jsonEncode(bootstrapJson(
      currentRelease: pointerJson(release: releaseJson(
        appUrl: 'https://github.com/201222-L/dsh-mobile-remote/releases/download/v3.3.0/DSH-Remote-v3.3.0.apk',
      )),
    )), 200)))..baseUrl = hostBase;
    final store = AppStore(apiClient: client);
    addTearDown(store.dispose);
    await store.loadPrefs();
    client.absorbBootstrap(await client.getJson('/api/bootstrap'));

    final outcome = await Updater.check(store);
    expect(outcome.candidate, isNull);
    expect(outcome.error, contains('固定目标'));
    expect(outcome.error, contains('重新检查'));
  });

  test('旧宿主兼容：主机目录清单显式给出的宿主地址被原样使用', () async {
    final requests = <String>[];
    final manifest = Map<String, dynamic>.from(releaseJson(appUrl: fixedAppUrl(releaseId: 'r9')));
    final client = Api(client: MockClient((request) async {
      requests.add(request.url.path);
      if (request.url.path.endsWith('/bootstrap')) {
        return http.Response(jsonEncode(bootstrapJson()), 200);
      }
      return http.Response(jsonEncode({'ok': true, 'manifest': manifest}), 200);
    }))..baseUrl = hostBase;
    final store = AppStore(apiClient: client);
    addTearDown(store.dispose);
    await store.loadPrefs();
    await store.setUpdateSource('host');
    client.absorbBootstrap(await client.getJson('/api/bootstrap'));

    final outcome = await Updater.check(store);
    expect(outcome.candidate?.downloadUrl, fixedAppUrl(releaseId: 'r9'));
    expect(requests, ['$mount/api/bootstrap', '$mount/api/update/manifest']);
  });

  test('没有任何宿主固定发布时不回退 GitHub：给可执行的迁移提示', () async {
    final requests = <String>[];
    final client = Api(client: MockClient((request) async {
      requests.add(request.url.toString());
      return http.Response(jsonEncode(bootstrapJson()), 200);
    }))..baseUrl = hostBase;
    final store = AppStore(apiClient: client);
    addTearDown(store.dispose);
    await store.loadPrefs();
    client.absorbBootstrap(await client.getJson('/api/bootstrap'));

    final outcome = await Updater.check(store);
    expect(outcome.candidate, isNull);
    expect(outcome.error, contains('电脑端固定目标'));
    expect(outcome.error, contains('不再直连 GitHub'));
    expect(requests.every((u) => !u.contains('github')), isTrue);
  });
}
