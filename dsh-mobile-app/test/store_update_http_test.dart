import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/plugin_update_resume.dart';
import 'package:dsh_mobile_app/plugin_update_status.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/update_core.dart';
import 'package:dsh_mobile_app/updater.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

const oldHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const pluginHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const apkHash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const journalKey = 'dsh_mr_plugin_update_journal';
Map<String, dynamic> release() => {
  'schema': 1,
  'manifestUrl': 'https://custom.example/releases/fixed/manifest.json',
  'app': {'version': '3.3.0+55', 'file': 'fixed.apk', 'size': 4, 'sha256': apkHash, 'url': 'https://custom.example/releases/fixed/app.apk'},
  'plugin': {'version': '3.3.0', 'file': 'fixed.tgz', 'size': 8, 'sha256': oldHash, 'contentSha256': pluginHash, 'url': 'https://custom.example/releases/fixed/plugin.tgz'},
};
Map<String, dynamic> transaction({String phase = 'settled', String opId = 'op-fixed'}) => {
  'opId': opId, 'phase': phase, 'targetVersion': '3.3.0', 'targetContentSha256': pluginHash,
  'release': release(),
};
Map<String, dynamic> bootstrap({String phase = 'settled', String loaded = pluginHash, String state = 'up-to-date', String opId = 'op-fixed'}) => {
  'plugin': {'version': '3.3.0', 'contentSha256': loaded},
  'pluginUpdate': {'state': state, 'canSelfUpdate': true, 'release': release(), 'transaction': transaction(phase: phase, opId: opId)},
};
String savedJournal({String phase = UpdatePhase.appPending}) => jsonEncode({
  'opId': 'op-fixed', 'targetVersion': '3.3.0', 'targetContentSha256': pluginHash,
  'startedAt': DateTime.now().toUtc().toIso8601String(), 'phase': phase,
  'appVersion': '3.3.0+55', 'release': release(),
});
void localVersion(String version, String build) => PackageInfo.setMockInitialValues(
  appName: 'DSH', packageName: 'com.dsh.remote', version: version, buildNumber: build, buildSignature: '',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() { SharedPreferences.setMockInitialValues({}); localVersion('3.2.0', '44'); });

  test('C7 accepted release is fixed across source changes and server latest advancing', () async {
    var opId = '';
    final requests = <String>[];
    final client = Api(client: MockClient((request) async {
      requests.add(request.url.path);
      if (request.method == 'POST') {
        opId = jsonDecode(request.body)['opId'] as String;
        return http.Response(jsonEncode({'action': 'accepted', 'opId': opId, 'release': release(),
          'check': {'state': 'update-available', 'release': release()}}), 200);
      }
      final data = bootstrap(opId: opId);
      data['pluginUpdate']['release']['app']['url'] = 'https://latest.example/new.apk';
      data['pluginUpdate']['transaction']['release']['app']['url'] = 'https://latest.example/new.apk';
      return http.Response(jsonEncode(data), 200);
    }))..baseUrl = 'https://desktop.example';
    final store = AppStore(apiClient: client);
    addTearDown(store.dispose);
    await store.loadPrefs();
    await store.beginPluginUpdate();
    expect(store.pluginUpdateJournal?.toJson()['release'], release());
    expect(store.appUpdateGate().allowed, isFalse);
    await store.setUpdateSource('host');
    client.absorbBootstrap(await client.getJson('/api/bootstrap'));
    await store.resumePluginUpdate();
    expect(store.pluginUpdateJournal?.phase, UpdatePhase.appPending);
    expect(store.updateCandidate?.downloadUrl, release()['app']['url']);
    expect(store.appUpdateGate().allowed, isTrue);
    expect(requests, ['/m/api/plugin-update', '/m/api/bootstrap']);
  });

  test('C6 plugin-pending needs matching operation settled AND loaded target', () async {
    for (final scenario in [
      bootstrap(phase: 'restart-pending'),
      bootstrap(loaded: oldHash),
      bootstrap(opId: 'someone-else'),
    ]) {
      SharedPreferences.setMockInitialValues({journalKey: savedJournal(phase: UpdatePhase.pluginPending)});
      final client = Api(client: MockClient((_) async => http.Response(jsonEncode(scenario), 200)))
        ..baseUrl = 'https://desktop.example';
      final store = AppStore(apiClient: client);
      await store.loadPrefs();
      client.absorbBootstrap(await client.getJson('/api/bootstrap'));
      await store.resumePluginUpdate();
      expect(store.pluginUpdateJournal?.phase, UpdatePhase.pluginPending);
      expect(store.updateCandidate, isNull);
      expect(store.appUpdateGate().allowed, isFalse);
      store.dispose();
    }
  });

  test('W3 explicit HTTP refusals clear submitted intent; busy shows existing op and retries immediately', () async {
    for (final status in [400, 401, 403, 404, 409, 422]) {
      SharedPreferences.setMockInitialValues({});
      var posts = 0;
      final client = Api(client: MockClient((request) async {
        if (request.method == 'POST') posts++;
        return http.Response(jsonEncode({'error': status == 409 ? 'update-busy' : 'unsupported',
          'transaction': transaction(phase: 'installing', opId: 'existing-op')}), status);
      }))..baseUrl = 'https://desktop.example';
      final store = AppStore(apiClient: client);
      await store.loadPrefs();
      await store.beginPluginUpdate();
      expect(store.pluginUpdateJournal, isNull, reason: 'HTTP $status is not accepted');
      expect((await SharedPreferences.getInstance()).getString(journalKey), '');
      expect(store.pluginUpdateNotice, isNot(contains('结果待确认')));
      if (status == 409) {
        expect(store.pluginUpdateNotice, contains('existing-op'));
        expect(client.pluginUpdate.transaction?.opId, 'existing-op');
      }
      await store.beginPluginUpdate();
      expect(posts, 2);
      store.dispose();
    }
  });

  test('C9 failed rollback and unknown status never permit candidate APK; only target health does', () async {
    for (final scenario in [
      bootstrap(state: 'update-failed', phase: 'failed', loaded: oldHash),
      bootstrap(state: 'update-failed', phase: 'rolled-back', loaded: oldHash),
      bootstrap(state: 'future-status', phase: 'future-phase', loaded: oldHash),
      bootstrap(state: 'up-to-date', loaded: oldHash),
    ]) {
      SharedPreferences.setMockInitialValues({});
      final client = Api(client: MockClient((_) async => http.Response(jsonEncode(scenario), 200)))
        ..baseUrl = 'https://desktop.example';
      final store = AppStore(apiClient: client);
      await store.loadPrefs();
      client.absorbBootstrap(await client.getJson('/api/bootstrap'));
      store.setUpdateCandidate(ReleaseSnapshot.fromJson(release())!.candidate);
      expect(store.appUpdateGate().allowed, isFalse);
      client.absorbBootstrap(bootstrap());
      expect(store.appUpdateGate().allowed, isTrue);
      store.dispose();
    }
  });

  test('C8 local App check errors preserve retryable confirmed phase and never report latest', () async {
    SharedPreferences.setMockInitialValues({journalKey: savedJournal(phase: UpdatePhase.pluginConfirmed)});
    final client = Api(client: MockClient((_) async => http.Response(jsonEncode(bootstrap()), 200)))
      ..baseUrl = 'https://desktop.example';
    var broken = true;
    final store = AppStore(apiClient: client, localVersion: () async {
      if (broken) throw StateError('package-info unavailable');
      return parseAppVersion('3.2.0+44');
    });
    addTearDown(store.dispose);
    await store.loadPrefs();
    client.absorbBootstrap(await client.getJson('/api/bootstrap'));
    await store.resumePluginUpdate();
    expect(store.pluginUpdateJournal?.phase, UpdatePhase.pluginConfirmed);
    expect(store.updateCandidate, isNull);
    expect(store.pluginUpdateNotice, contains('保留'));
    expect(store.pluginUpdateNotice, isNot(contains('最新')));
    broken = false;
    await store.resumePluginUpdate();
    expect(store.pluginUpdateJournal?.phase, UpdatePhase.appPending);
  });

  test('C7 manual and silent checks consume recovered snapshot, not host/latest', () async {
    SharedPreferences.setMockInitialValues({journalKey: savedJournal(), 'dsh_mr_update_source': 'host'});
    final requests = <String>[];
    final client = Api(client: MockClient((request) async {
      requests.add(request.url.path);
      return http.Response(jsonEncode(bootstrap()), 200);
    }))..baseUrl = 'https://desktop.example';
    final store = AppStore(apiClient: client);
    addTearDown(store.dispose);
    await store.loadPrefs();
    client.absorbBootstrap(await client.getJson('/api/bootstrap'));
    await store.resumePluginUpdate();
    final outcome = await Updater.check(store);
    expect(outcome.error, isNull);
    expect(outcome.candidate?.downloadUrl, release()['app']['url']);
    await Updater.autoCheckSilent(store);
    expect(store.updateCandidate?.downloadUrl, release()['app']['url']);
    expect(requests, ['/m/api/bootstrap']);
  });

  test('host check consumes normalized two-artifact manifest through injected Api before candidate gate', () async {
    final requests = <String>[];
    final client = Api(client: MockClient((request) async {
      requests.add(request.url.path);
      if (request.url.path.endsWith('/bootstrap')) return http.Response(jsonEncode(bootstrap()), 200);
      return http.Response(jsonEncode({'manifest': release()}), 200);
    }))..baseUrl = 'https://desktop.example';
    final store = AppStore(apiClient: client);
    addTearDown(store.dispose);
    await store.loadPrefs();
    await store.setUpdateSource('host');
    client.absorbBootstrap(await client.getJson('/api/bootstrap'));
    final outcome = await Updater.check(store);
    expect(outcome.error, isNull);
    expect(outcome.candidate?.release?.plugin.contentSha256, pluginHash);
    store.setUpdateCandidate(outcome.candidate);
    expect(store.appUpdateGate().allowed, isTrue);
    expect(requests, ['/m/api/bootstrap', '/m/api/update/manifest']);
  });

  test('installer launch and cancellation keep journal; mutated candidate never reaches installer; new App closes it', () async {
    SharedPreferences.setMockInitialValues({journalKey: savedJournal()});
    var launches = 0;
    var result = 'cancelled';
    final client = Api(client: MockClient((_) async => http.Response(jsonEncode(bootstrap()), 200)))
      ..baseUrl = 'https://desktop.example';
    final store = AppStore(apiClient: client, installer: (candidate, {onProgress, onStage, cancel}) async {
      launches++;
      return result.isEmpty ? null : result;
    });
    await store.loadPrefs();
    client.absorbBootstrap(await client.getJson('/api/bootstrap'));
    await store.resumePluginUpdate();
    final fixed = store.updateCandidate!;
    final wrong = UpdateCandidate(version: fixed.version, downloadUrl: 'https://latest.example/app.apk',
      sizeBytes: fixed.sizeBytes, sha256: fixed.sha256, source: fixed.source, release: fixed.release);
    expect(await store.installAppUpdate(wrong), isNotNull);
    expect(launches, 0);
    expect(await store.installAppUpdate(fixed), 'cancelled');
    expect(store.pluginUpdateJournal?.phase, UpdatePhase.appPending);
    result = '';
    expect(await store.installAppUpdate(fixed), isNull);
    await store.resumePluginUpdate();
    expect(store.pluginUpdateJournal?.phase, UpdatePhase.appPending);
    expect(store.updateCandidate?.downloadUrl, fixed.downloadUrl);
    store.dispose();
    localVersion('3.3.0', '55');
    final restarted = AppStore(apiClient: client);
    addTearDown(restarted.dispose);
    await restarted.loadPrefs();
    client.absorbBootstrap(await client.getJson('/api/bootstrap'));
    await restarted.resumePluginUpdate();
    expect(restarted.pluginUpdateJournal, isNull);
    expect(restarted.updateCandidate, isNull);
    expect(restarted.pluginUpdateNotice, contains('两端已更新'));
  });

  test('failed plugin operation stays retryable and target-blocked until a fresh accepted retry', () async {
    SharedPreferences.setMockInitialValues({journalKey: savedJournal(phase: UpdatePhase.pluginPending)});
    var submitted = '';
    final client = Api(client: MockClient((request) async {
      if (request.method == 'POST') {
        submitted = jsonDecode(request.body)['opId'] as String;
        return http.Response(jsonEncode({'action': 'accepted', 'opId': submitted, 'release': release()}), 200);
      }
      return http.Response(jsonEncode(bootstrap(state: 'update-failed', phase: 'failed', loaded: oldHash)), 200);
    }))..baseUrl = 'https://desktop.example';
    final store = AppStore(apiClient: client);
    addTearDown(store.dispose);
    await store.loadPrefs();
    client.absorbBootstrap(await client.getJson('/api/bootstrap'));
    await store.resumePluginUpdate();
    expect(store.pluginUpdateJournal?.phase, 'plugin-retry');
    expect(store.pluginUpdateJournal?.toJson()['release'], release());
    expect(store.appUpdateGate().allowed, isFalse);
    await store.beginPluginUpdate();
    expect(submitted, isNotEmpty);
    expect(submitted, isNot('op-fixed'));
    client.absorbBootstrap(bootstrap(opId: submitted));
    await store.resumePluginUpdate();
    expect(store.pluginUpdateJournal?.phase, UpdatePhase.appPending);
    expect(store.appUpdateGate().allowed, isTrue);
  });

  test('C6 old App cold-start and refresh retain fixed app-pending candidate, never call latest', () async {
    SharedPreferences.setMockInitialValues({journalKey: savedJournal()});
    final requests = <String>[];
    final client = Api(client: MockClient((request) async {
      requests.add(request.url.path);
      return http.Response(jsonEncode(bootstrap()), 200);
    }))..baseUrl = 'https://desktop.example';
    final store = AppStore(apiClient: client);
    addTearDown(store.dispose);
    await store.loadPrefs();
    client.absorbBootstrap(await client.getJson('/api/bootstrap'));
    await store.resumePluginUpdate();
    expect(store.pluginUpdateJournal?.phase, UpdatePhase.appPending);
    expect(store.updateCandidate?.downloadUrl, release()['app']['url']);
    expect(store.updateCandidate?.sha256, apkHash);
    expect(store.updateCandidate?.sizeBytes, 4);
    expect(store.appUpdateGate().allowed, isTrue);
    expect(requests, ['/m/api/bootstrap']);
    expect(store.pluginUpdateNotice, isNot(contains('两端已更新')));
  });

  test('D1: pre-installed healthy plugin with no historical transaction still allows the app-only update', () async {
    var installs = 0;
    final client = Api(client: MockClient((request) async =>
        http.Response(jsonEncode(bootstrap()), 200)))..baseUrl = 'https://desktop.example';
    final store = AppStore(apiClient: client, localVersion: () async => parseAppVersion('3.2.0+44'),
      installer: (candidate, {onProgress, onStage, cancel}) async { installs++; return null; });
    addTearDown(store.dispose);
    await store.loadPrefs();
    client.absorbBootstrap(await client.getJson('/api/bootstrap'));
    // 预装且已加载目标内容：没有 settled 事务也必须放行
    api.pluginUpdate = PluginUpdateStatus.fromJson({
      'state': 'up-to-date',
      'release': release(),
      'transaction': {'opId': 'op-none', 'phase': 'staging', 'targetContentSha256': pluginHash},
    });
    api.pluginContentSha256 = pluginHash;
    final candidate = ReleaseSnapshot.fromJson(release())!.candidate;
    expect(store.appUpdateGate(candidate).allowed, isTrue);
    expect(await store.installAppUpdate(candidate), isNull);
    expect(installs, 1, reason: '预装插件不该阻塞 App 安装');
    // 取消后仍可重试：记录保留，门禁仍允许
    expect(store.pluginUpdateJournal, isNotNull);
    expect(store.appUpdateGate(candidate).allowed, isTrue);
  });

  test('D2: accepted-but-response-lost recovers the fixed snapshot from the server before deciding', () async {
    var opId = '';
    var postSeen = false;
    final client = Api(client: MockClient((request) async {
      if (request.method == 'POST') {
        postSeen = true;
        opId = jsonDecode(request.body)['opId'] as String;
        throw ApiException('timeout', status: 504); // 已接受但响应丢失
      }
      return http.Response(jsonEncode(bootstrap(opId: opId)), 200);
    }))..baseUrl = 'https://desktop.example';
    final store = AppStore(apiClient: client, localVersion: () async => parseAppVersion('3.2.0+44'));
    addTearDown(store.dispose);
    await store.loadPrefs();
    await store.beginPluginUpdate();
    expect(postSeen, isTrue);
    // 本地快照为空（提交意图时还不知道目标）
    expect(store.pluginUpdateJournal?.release, isNull);
    client.absorbBootstrap(await client.getJson('/api/bootstrap'));
    await store.resumePluginUpdate();
    // 服务端同 opId 的 settled 事务带完整 release：必须先回填再判定，否则永远 wait
    expect(store.pluginUpdateJournal?.release?.plugin.contentSha256, pluginHash);
    expect(store.pluginUpdateJournal?.phase, isNot(UpdatePhase.pluginPending));
    expect(store.updateCandidate?.downloadUrl, release()['app']['url']);
  });
}
