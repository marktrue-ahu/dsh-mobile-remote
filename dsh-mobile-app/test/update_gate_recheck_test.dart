// 插件优先门禁 + 状态复核（设计稿 §5.3 / §5.9、F8 / F14 / F16）：
// 门禁同时核对固定快照、正在运行的内容标识、健康结果与在飞/回滚矛盾；
// 下载前重新读取当前状态，无法复核时不靠旧缓存证明启动安装。
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/plugin_update_resume.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/update_core.dart';
import 'package:dsh_mobile_app/updater.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const pluginHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const apkHash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const oldHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const hostBase = 'http://192.168.1.5:3080';
const mount = '/m';

Map<String, dynamic> releaseJson({String version = '3.3.0+55'}) => {
      'schema': 1,
      'manifestUrl': '$hostBase$mount/api/update/manifest',
      'app': {'version': version, 'file': 'app.apk', 'size': 4096, 'sha256': apkHash,
        'url': '$hostBase$mount/api/update/apk?release=r1&sha256=$apkHash'},
      'plugin': {'version': '3.3.0', 'file': 'plugin.tgz', 'size': 2048, 'sha256': oldHash,
        'contentSha256': pluginHash, 'url': '$hostBase$mount/api/update/plugin'},
    };

Map<String, dynamic> healthJson({String state = 'confirmed', String running = pluginHash,
    String instanceId = 'inst-1'}) => {
      'state': state,
      'runningContentSha256': running,
      'instanceId': instanceId,
      'transaction': {'opId': 'op-1', 'generation': 1},
    };

Map<String, dynamic> bootstrapJson({
  String state = 'up-to-date',
  Map<String, dynamic>? currentRelease,
  Map<String, dynamic>? release,
  Map<String, dynamic>? transaction,
  Map<String, dynamic>? health,
  Map<String, dynamic>? appArtifact,
  String loaded = pluginHash,
  String instanceId = 'inst-1',
}) => {
      'plugin': {'version': '3.3.0', 'contentSha256': loaded, 'instanceId': instanceId},
      'pluginUpdate': {
        'state': state,
        'canSelfUpdate': true,
        'release': ?release,
        'transaction': transaction,
      },
      'currentRelease': currentRelease ?? {'releaseId': 'r1', 'release': releaseJson()},
      'currentReleaseHealth': health ?? healthJson(),
      'appArtifact': appArtifact,
    };

AppStore storeFor(Api client, {int Function()? onInstall}) => AppStore(
      apiClient: client,
      localVersion: () async => parseAppVersion('3.2.0+44'),
      installer: (candidate, {onProgress, onStage, cancel}) async {
        onInstall?.call();
        return null;
      },
    );

Future<Api> absorb(Api client) async {
  client.absorbBootstrap(await client.getJson('/api/bootstrap'));
  return client;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('F14: 远端检查 disabled，但本地当前发布完整且健康 → 仍允许本地 App 安装', () async {
    final data = bootstrapJson(state: 'disabled');
    var installs = 0;
    final client = Api(client: MockClient((_) async => http.Response(jsonEncode(data), 200)))
      ..baseUrl = hostBase;
    final store = storeFor(client, onInstall: () => installs++);
    addTearDown(store.dispose);
    await store.loadPrefs();
    await absorb(client);

    final outcome = await Updater.check(store);
    expect(outcome.error, isNull);
    final candidate = outcome.candidate!;
    expect(store.appUpdateGate(candidate).allowed, isTrue,
        reason: '本地配对已验证且健康时，外部检查 off/failed 不得否定本地 App 安装');

    final result = await store.installAppUpdate(candidate);
    expect(result, isNull);
    expect(installs, 1);
    expect(store.pluginUpdateJournal?.phase, UpdatePhase.appPending);
  });

  test('健康结果未确认（waiting）→ 门禁拒绝等待；failed → 拒绝并报失败', () async {
    for (final scenario in [
      ('waiting', 'plugin-transaction-pending'),
      ('failed', 'plugin-update-failed'),
    ]) {
      final client = Api(client: MockClient((_) async => http.Response(jsonEncode(
        bootstrapJson(health: healthJson(state: scenario.$1)),
      ), 200)))..baseUrl = hostBase;
      final store = AppStore(apiClient: client, localVersion: () async => parseAppVersion('3.2.0+44'));
      addTearDown(store.dispose);
      await store.loadPrefs();
      await absorb(client);

      final candidate = ReleaseSnapshot.fromJson(releaseJson())!.candidate;
      final gate = store.appUpdateGate(candidate);
      expect(gate.allowed, isFalse, reason: scenario.$1);
      expect(gate.reason, scenario.$2, reason: scenario.$1);
    }
  });

  test('健康结果里的运行内容/服务实例与当前实例不符 → 门禁拒绝（旧健康结论不能冒充）', () async {
    for (final data in [
      bootstrapJson(health: healthJson(running: oldHash)),
      bootstrapJson(instanceId: 'inst-2', health: healthJson(instanceId: 'inst-1')),
    ]) {
      final client = Api(client: MockClient((_) async => http.Response(jsonEncode(data), 200)))
        ..baseUrl = hostBase;
      final store = AppStore(apiClient: client, localVersion: () async => parseAppVersion('3.2.0+44'));
      addTearDown(store.dispose);
      await store.loadPrefs();
      await absorb(client);
      final candidate = ReleaseSnapshot.fromJson(releaseJson())!.candidate;
      expect(store.appUpdateGate(candidate).allowed, isFalse,
          reason: '运行内容/实例不一致时不能复用旧健康结论');
    }
  });

  test('下载前重新读取状态：复核失败 → 拒绝安装（不靠旧缓存证明）', () async {
    var calls = 0;
    var installs = 0;
    final data = bootstrapJson();
    final client = Api(client: MockClient((_) async {
      calls++;
      if (calls == 1) return http.Response(jsonEncode(data), 200);
      return http.Response(jsonEncode({'error': 'internal', 'detail': 'boom'}), 500);
    }))..baseUrl = hostBase;
    final store = storeFor(client, onInstall: () => installs++);
    addTearDown(store.dispose);
    await store.loadPrefs();
    await absorb(client);

    final candidate = (await Updater.check(store)).candidate!;
    final result = await store.installAppUpdate(candidate);
    expect(result, contains('无法复核'));
    expect(installs, 0);
    expect(store.pluginUpdateJournal, isNull);
  });

  test('下载前重新读取状态：出现新的在飞事务 → 拒绝安装', () async {
    var calls = 0;
    var installs = 0;
    final healthy = bootstrapJson();
    final inFlight = bootstrapJson(transaction: {
      'opId': 'op-new', 'phase': 'staging', 'targetContentSha256': pluginHash, 'rolledBack': false,
    });
    final client = Api(client: MockClient((_) async {
      calls++;
      return http.Response(jsonEncode(calls == 1 ? healthy : inFlight), 200);
    }))..baseUrl = hostBase;
    final store = storeFor(client, onInstall: () => installs++);
    addTearDown(store.dispose);
    await store.loadPrefs();
    await absorb(client);

    final candidate = (await Updater.check(store)).candidate!;
    final result = await store.installAppUpdate(candidate);
    expect(result, isNotNull, reason: '复核发现在飞事务必须拒绝并给出可读原因');
    expect(installs, 0);
  });

  test('F16: appArtifact=mismatch 时停在校验阶段，不给候选', () async {
    final client = Api(client: MockClient((_) async => http.Response(jsonEncode(
      bootstrapJson(appArtifact: {'state': 'mismatch', 'reason': 'app-hash-mismatch'}),
    ), 200)))..baseUrl = hostBase;
    final store = AppStore(apiClient: client, localVersion: () async => parseAppVersion('3.2.0+44'));
    addTearDown(store.dispose);
    await store.loadPrefs();
    await absorb(client);

    final outcome = await Updater.check(store);
    expect(outcome.candidate, isNull);
    expect(outcome.error, contains('不一致'));
    expect(outcome.error, contains('app-hash-mismatch'));
  });
}
