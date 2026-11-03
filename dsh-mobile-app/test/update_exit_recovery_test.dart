// 接续失败出口 + 装完复核（设计稿 §5.9、F13 / F16）：
// 目标改变、过期（410）、失败、另一事务回滚时给明确取消/重查出口，不能永久停在
// "更新进行中"又拒绝重试；安装器返回后首次启动核对真实版本/构建号与两端配对。
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/plugin_update_resume.dart';
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
const journalKey = 'dsh_mr_plugin_update_journal';

Map<String, dynamic> releaseJson({String appVersion = '3.3.0+55'}) => {
      'schema': 1,
      'manifestUrl': '$hostBase$mount/api/update/manifest',
      'app': {'version': appVersion, 'file': 'app.apk', 'size': 4096, 'sha256': apkHash,
        'url': '$hostBase$mount/api/update/apk?release=r1&sha256=$apkHash'},
      'plugin': {'version': '3.3.0', 'file': 'plugin.tgz', 'size': 2048, 'sha256': oldHash,
        'contentSha256': pluginHash, 'url': '$hostBase$mount/api/update/plugin'},
    };

String savedJournal({String phase = UpdatePhase.appPending, String appVersion = '3.3.0+55'}) => jsonEncode({
      'opId': 'op-fixed', 'targetVersion': '3.3.0', 'targetContentSha256': pluginHash,
      'startedAt': DateTime.now().toUtc().toIso8601String(), 'phase': phase,
      'appVersion': appVersion, 'release': releaseJson(appVersion: appVersion),
    });

Map<String, dynamic> bootstrapJson({
  String state = 'up-to-date',
  Map<String, dynamic>? transaction,
  Map<String, dynamic>? currentRelease,
  String loaded = pluginHash,
}) => {
      'plugin': {'version': '3.3.0', 'contentSha256': loaded, 'instanceId': 'inst-1'},
      'pluginUpdate': {
        'state': state,
        'canSelfUpdate': true,
        'release': releaseJson(),
        'transaction': transaction,
      },
      'currentRelease': currentRelease,
      'currentReleaseHealth': {
        'state': 'confirmed',
        'runningContentSha256': loaded,
        'instanceId': 'inst-1',
        'transaction': {'opId': 'op-fixed', 'generation': 1},
      },
    };

Map<String, dynamic> rolledBackTransaction() => {
      'opId': 'op-fixed', 'phase': 'rolled-back', 'targetVersion': '3.3.0',
      'targetContentSha256': pluginHash, 'rolledBack': true, 'result': {'reason': 'health-check-failed'},
    };

Map<String, dynamic> settledTransaction() => {
      'opId': 'op-fixed', 'phase': 'settled', 'targetVersion': '3.3.0',
      'targetContentSha256': pluginHash, 'rolledBack': false,
    };

void localVersion(String version, String build) => PackageInfo.setMockInitialValues(
      appName: 'DSH', packageName: 'com.dsh.remote', version: version, buildNumber: build, buildSignature: '',
    );

UpdateCandidate updateCandidateOf(Map<String, dynamic> release) => ReleaseSnapshot.fromJson(release)!.candidate;

Future<AppStore> openStore(Api client, {String version = '3.2.0', String build = '44'}) async {
  final store = AppStore(apiClient: client, localVersion: () async => parseAppVersion('$version+$build'));
  addTearDown(store.dispose);
  await store.loadPrefs();
  client.absorbBootstrap(await client.getJson('/api/bootstrap'));
  return store;
}

/// 只读持久化记录、不吸收 bootstrap（避免自动接续在断言前改写提示）。
Future<AppStore> openStoreWithoutBootstrap() async {
  final store = AppStore();
  addTearDown(store.dispose);
  await store.loadPrefs();
  return store;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    localVersion('3.2.0', '44');
  });

  test('F13: 目标过期（410）→ 自动退出旧候选并提示重新检查，不永久停在"更新进行中"', () async {
    SharedPreferences.setMockInitialValues({journalKey: savedJournal()});
    final store = await openStoreWithoutBootstrap();
    expect(store.pluginUpdateJournal, isNotNull);
    store.setUpdateCandidate(updateCandidateOf(releaseJson()));

    await store.reportInstallOutcome('固定目标已过期…', failure: artifactFailure(410, code: 'app-artifact-expired'));
    expect(store.pluginUpdateJournal, isNull, reason: '过期目标必须退出旧候选，不能继续卡住');
    expect(store.updateCandidate, isNull);
    expect(store.pluginUpdateNotice, contains('已退出旧目标'));
    expect(store.appUpdateGate().reason, isNot('plugin-update-in-progress'));
  });

  test('APK 未就绪（503）/认证失败（401）→ 保留固定目标可重试，不清记录', () async {
    for (final failure in [
      artifactFailure(503, code: 'app-artifact-not-ready'),
      artifactFailure(401, code: 'auth-required'),
    ]) {
      SharedPreferences.setMockInitialValues({journalKey: savedJournal()});
      final store = await openStoreWithoutBootstrap();

      await store.reportInstallOutcome(failure.message, failure: failure);
      expect(store.pluginUpdateJournal, isNotNull, reason: '${failure.code} 应保留固定目标');
      if (failure.notReady) {
        expect(store.pluginUpdateNotice, contains('保留'));
      } else {
        expect(store.pluginUpdateNotice, contains('连接页'));
        expect(store.pluginUpdateNotice, contains('二维码'));
      }
    }
  });

  test('F13: appPending 期间另一事务回滚（尚未安装）→ 退出旧目标、提示重新检查，不永久卡住', () async {
    SharedPreferences.setMockInitialValues({journalKey: savedJournal()});
    final client = Api(client: MockClient((_) async => http.Response(jsonEncode(bootstrapJson(
      state: 'update-failed',
      transaction: rolledBackTransaction(),
      loaded: oldHash,
    )), 200)))..baseUrl = hostBase;
    final store = await openStore(client);

    expect(store.pluginUpdateJournal?.phase, UpdatePhase.appPending);
    await store.resumePluginUpdate();
    expect(store.pluginUpdateJournal, isNull, reason: '回滚后旧固定目标失效，必须退出而不是永久等待');
    expect(store.pluginUpdateNotice, contains('回滚'));
    expect(store.pluginUpdateNotice, contains('重新检查'));
    // 退出后门禁落到可重试的失败态（用户可重新触发插件更新），而不是 in-progress。
    expect(store.appUpdateGate().reason, 'plugin-update-failed');
  });

  test('装完首次启动复核：本机版本已达目标但插件已回滚 → "两端不匹配，请重新检查"，不自动降级', () async {
    SharedPreferences.setMockInitialValues({journalKey: savedJournal()});
    final client = Api(client: MockClient((_) async => http.Response(jsonEncode(bootstrapJson(
      state: 'update-failed',
      transaction: rolledBackTransaction(),
      loaded: oldHash,
    )), 200)))..baseUrl = hostBase;
    final store = await openStore(client, version: '3.3.0', build: '55');
    expect(store.updateCandidate, isNull);

    await store.resumePluginUpdate();
    expect(store.pluginUpdateNotice, contains('两端不匹配'));
    expect(store.pluginUpdateNotice, contains('不会自动降级'));
    expect(store.pluginUpdateJournal, isNull);
    expect(store.updateCandidate, isNull, reason: '不静默继续，也不提供降级');
  });

  test('装完复核：健康结论尚未确认（重启/确认中）→ 保留记录等待收敛，不误报完成或回滚', () async {
    SharedPreferences.setMockInitialValues({journalKey: savedJournal()});
    final client = Api(client: MockClient((_) async => http.Response(jsonEncode(bootstrapJson(
      transaction: {
        'opId': 'op-fixed', 'phase': 'restart-pending', 'targetVersion': '3.3.0',
        'targetContentSha256': pluginHash, 'rolledBack': false,
      },
    )), 200)))..baseUrl = hostBase;
    final store = await openStore(client, version: '3.3.0', build: '55');

    await store.resumePluginUpdate();
    expect(store.pluginUpdateNotice, contains('等待电脑端插件健康确认'));
    expect(store.pluginUpdateNotice, isNot(contains('两端已更新')));
    expect(store.pluginUpdateNotice, isNot(contains('两端不匹配')));
    expect(store.pluginUpdateJournal, isNotNull, reason: '确认前不能清记录（既不宣称完成也不误判回滚）');
  });

  test('装完复核：本机 App 已高于固定目标 → 不降级，提示重新对齐', () async {
    SharedPreferences.setMockInitialValues({journalKey: savedJournal()});
    final client = Api(client: MockClient((_) async => http.Response(jsonEncode(bootstrapJson(
      transaction: settledTransaction(),
    )), 200)))..baseUrl = hostBase;
    final store = await openStore(client, version: '3.4.0', build: '60');

    await store.resumePluginUpdate();
    expect(store.pluginUpdateNotice, contains('不会降级'));
    expect(store.pluginUpdateJournal, isNull);
  });

  test('用户出口：取消进行中的记录并按当前电脑端状态重新检查', () async {
    SharedPreferences.setMockInitialValues({journalKey: savedJournal()});
    final client = Api(client: MockClient((_) async => http.Response(jsonEncode(bootstrapJson(
      currentRelease: {'releaseId': 'r1', 'release': releaseJson()},
      transaction: settledTransaction(),
    )), 200)))..baseUrl = hostBase;
    final store = await openStore(client);

    await store.cancelUpdateAndRecheck();
    expect(store.pluginUpdateJournal, isNull);
    expect(store.updateCandidate?.downloadUrl, releaseJson()['app']['url']);
    expect(store.pluginUpdateNotice, contains('已取消旧更新目标'));
    expect(store.pluginUpdateNotice, contains('发现固定目标'));
    // 旧记录清掉后门禁按当前健康配对重新判定（可继续安装 App），不是永久 in-progress。
    expect(store.appUpdateGate(store.updateCandidate).allowed, isTrue);
  });
}
