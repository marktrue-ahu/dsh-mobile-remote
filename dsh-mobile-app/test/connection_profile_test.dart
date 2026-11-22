// GitLab #152：连接档案迁移、staged 切换、失败保留旧连接、hostId 绑定、
// (profileId,hostId) 命名空间与凭据清理。
import 'dart:async';
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/connection_manager.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/connection_profile.dart';
import 'package:dsh_mobile_app/credential_store.dart';
import 'package:dsh_mobile_app/attention_storage.dart';
import 'package:dsh_mobile_app/git_file_history_controller.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _StoreApi extends Api {
  final controller = StreamController<Map<String, dynamic>>.broadcast();

  @override
  Stream<Map<String, dynamic>> eventsRaw() => controller.stream;
}

class _FailAfterActivateStore extends MemoryCredentialStore {
  bool failNext = false;

  @override
  Future<void> activate(String profileId) async {
    await super.activate(profileId);
    if (failNext) {
      failNext = false;
      throw StateError('activate-committed-then-failed');
    }
  }
}

class _FailingActivateStore extends MemoryCredentialStore {
  @override
  Future<void> activate(String profileId) async {
    throw StateError('keystore-unavailable');
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('旧单连接迁移：Keystore 写入/readback 后删旧 token，档案成为 active', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'http://192.168.1.20:3080',
      'dsh_mr_path': '/m',
      'dsh_mr_token': 'legacy-token',
      'dsh_mr_urls': ['http://192.168.1.20:3080', 'http://100.64.0.7:3080'],
    });
    final creds = MemoryCredentialStore();
    final api = Api()..baseUrl = '';
    final manager = ConnectionManager(api: api, credentials: creds);
    await manager.load();

    final prefs = await SharedPreferences.getInstance();
    expect(manager.profiles, hasLength(1));
    expect(manager.activeProfileId, manager.profiles.single.id);
    expect(manager.profiles.single.tlsPolicy, ProfileTlsPolicy.httpPrivate);
    expect(manager.profiles.single.insecureConfirmed, isTrue);
    expect(manager.profiles.single.baseUrls, hasLength(2));
    expect(manager.profiles.single.path, '/m');
    expect(await creds.readToken(manager.activeProfileId), 'legacy-token');
    expect(prefs.getString('dsh_mr_token'), isNull, reason: '双端 readback 成功后才删旧 token');
    expect(api.token, 'legacy-token');
    expect(api.baseUrl, 'http://192.168.1.20:3080');
    expect(manager.profileScope, contains(manager.activeProfileId));
    expect(prefs.getString('dsh_native_connection'), isNotNull);
  });

  test('迁移失败保留旧 token，不把旧明文当活动凭据', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'http://192.168.1.20:3080',
      'dsh_mr_token': 'legacy-token',
    });
    final manager = ConnectionManager(
      api: Api()..baseUrl = '',
      credentials: _FailingActivateStore(),
    );
    await manager.load();
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('dsh_mr_token'), 'legacy-token');
    expect(manager.profiles, isEmpty);
    expect(manager.activeProfileId, isEmpty);
    expect(manager.migrationState, 'legacy-migration-failed');
  });

  test('staged 切换失败：old active/Api/token 全部不变', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'http://192.168.1.20:3080',
      'dsh_mr_token': 'old-token',
    });
    final creds = MemoryCredentialStore();
    final api = Api()..baseUrl = '';
    var failProbe = false;
    final manager = ConnectionManager(
      api: api,
      credentials: creds,
      probeBootstrap: (probe) async {
        if (failProbe) throw StateError('offline');
        return {
          'plugin': {'hostId': 'host-a'},
        };
      },
    );
    await manager.load();
    final oldActive = manager.activeProfileId;
    final oldBase = api.baseUrl;
    final oldToken = api.token;

    final second = ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: 'B',
      baseUrls: ['http://192.168.1.21:3080'],
      tlsPolicy: ProfileTlsPolicy.httpPrivate,
      insecureConfirmed: true,
    );
    await creds.writeToken(second.id, 'new-token');
    manager.profiles.add(second);
    failProbe = true;
    await expectLater(
      manager.stageSwitch(second.id, allowInsecure: true),
      throwsA(isA<ConnectionSwitchException>()),
    );
    expect(manager.activeProfileId, oldActive);
    expect(api.baseUrl, oldBase);
    expect(api.token, oldToken);
    expect(await creds.readActiveToken(), 'old-token');
  });

  test('staged 切换成功：hostId 绑定、Api 原子替换、命名空间变化', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'http://192.168.1.20:3080',
      'dsh_mr_token': 'old-token',
    });
    final creds = MemoryCredentialStore();
    final api = Api()..baseUrl = '';
    final manager = ConnectionManager(
      api: api,
      credentials: creds,
      probeBootstrap: (probe) async => {
        'plugin': {'hostId': 'host-b', 'instanceId': 'instance-1'},
      },
    );
    await manager.load();
    final oldScope = manager.profileScope;
    final oldActive = manager.activeProfileId;

    final second = ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: 'B',
      baseUrls: ['https://b.example.com/m'],
      tlsPolicy: ProfileTlsPolicy.https,
    );
    await creds.writeToken(second.id, 'b-token');
    manager.profiles.add(second);
    final stage = await manager.stageSwitch(second.id);
    expect(manager.activeProfileId, oldActive, reason: 'stage 阶段不切换');
    expect(api.token, 'old-token');
    await manager.commitSwitch(stage);

    expect(manager.activeProfileId, second.id);
    expect(manager.active!.hostId, 'host-b');
    expect(api.profileId, second.id);
    expect(api.hostIdentity, 'host-b');
    expect(api.token, 'b-token');
    expect(api.baseUrl, 'https://b.example.com');
    expect(manager.profileScope, '${second.id}:host-b');
    expect(manager.profileScope, isNot(oldScope));
    expect(await creds.readActiveToken(), 'b-token');
  });

  test('hostId 变化默认拒绝；显式确认后绑定新身份', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'https://a.example.com/m',
      'dsh_mr_token': 'a-token',
    });
    final manager = ConnectionManager(
      api: Api()..baseUrl = '',
      credentials: MemoryCredentialStore(),
      probeBootstrap: (_) async => {
        'plugin': {'hostId': 'host-new'},
      },
    );
    await manager.load();
    manager.active!.hostId = 'host-old';
    await expectLater(
      manager.stageSwitch(manager.activeProfileId),
      throwsA(
        isA<ConnectionSwitchException>().having(
          (e) => e.code,
          'code',
          'host-identity-changed',
        ),
      ),
    );
    final stage = await manager.stageSwitch(
      manager.activeProfileId,
      allowHostChange: true,
    );
    expect(stage.hostId, 'host-new');
  });

  test('公网 HTTP 拒绝；私网 HTTP 需显式确认', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'https://a.example.com/m',
      'dsh_mr_token': 'a-token',
    });
    final manager = ConnectionManager(
      api: Api()..baseUrl = '',
      credentials: MemoryCredentialStore(),
      probeBootstrap: (_) async => {'plugin': {'hostId': 'h'}},
    );
    await manager.load();
    final publicHttp = ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: '公网 HTTP',
      baseUrls: ['http://8.8.8.8:3080/m'],
      tlsPolicy: ProfileTlsPolicy.httpPrivate,
      insecureConfirmed: true,
    );
    await manager.credentials.writeToken(publicHttp.id, 't');
    manager.profiles.add(publicHttp);
    await expectLater(
      manager.stageSwitch(publicHttp.id, allowInsecure: true),
      throwsA(isA<ConnectionSwitchException>().having((e) => e.code, 'code', 'https-required')),
    );

    final privateHttp = publicHttp.copyWith(
      displayName: '私网 HTTP',
      baseUrls: ['http://192.168.1.30:3080/m'],
    );
    final id = ConnectionProfile.newId();
    final privateProfile = ConnectionProfile(
      id: id,
      displayName: privateHttp.displayName,
      baseUrls: privateHttp.baseUrls,
      tlsPolicy: ProfileTlsPolicy.httpPrivate,
      insecureConfirmed: false,
    );
    await manager.credentials.writeToken(id, 't');
    manager.profiles.add(privateProfile);
    await expectLater(
      manager.stageSwitch(id),
      throwsA(isA<ConnectionSwitchException>().having((e) => e.code, 'code', 'http-requires-confirmation')),
    );
  });

  test('同一 sessionId 在不同 hostId 命名空间不同', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'https://a.example.com/m',
      'dsh_mr_token': 'a-token',
    });
    final manager = ConnectionManager(
      api: Api()..baseUrl = '',
      credentials: MemoryCredentialStore(),
    );
    await manager.load();
    final profile = ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: 'B',
      baseUrls: ['https://b.example.com/m'],
      hostId: 'host-b',
    );
    manager.profiles.add(profile);
    final oldScope = manager.profileScope;
    manager.activeProfileId = profile.id;
    expect(manager.profileScope, isNot(oldScope));
    expect(manager.profileScope, contains('host-b'));
    // sessionId 不在命名空间中，同一 sessionId 也不会因为 host 不同而串缓存。
  });

  test('草稿/最近文件/通知账本按 (profileId,hostId) 隔离，切回恢复旧草稿', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'https://a.example.com/m',
      'dsh_mr_token': 'a-token',
    });
    final manager = ConnectionManager(
      api: Api()..baseUrl = '',
      credentials: MemoryCredentialStore(),
    );
    await manager.load();
    final a = manager.profiles.single;
    final b = ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: 'B',
      baseUrls: ['https://b.example.com/m'],
      hostId: 'host-b',
    );
    manager.profiles.add(b);
    final store = AppStore(apiClient: Api());
    addTearDown(store.disposeBridge);

    manager.activeProfileId = a.id;
    store.attachConnections(manager);
    store.saveDraft('same-session', 'draft-for-a');
    final gitKeyA = GitFileHistoryController.recentFilesKey('repo-1');
    final ledgerKeyA = AttentionStorage.preferenceKey;

    manager.activeProfileId = b.id;
    store.attachConnections(manager);
    expect(store.draftOf('same-session'), isEmpty, reason: '同一 sessionId 不得串到 B');
    store.saveDraft('same-session', 'draft-for-b');
    expect(GitFileHistoryController.recentFilesKey('repo-1'), isNot(gitKeyA));
    expect(AttentionStorage.preferenceKey, isNot(ledgerKeyA));

    manager.activeProfileId = a.id;
    store.attachConnections(manager);
    expect(store.draftOf('same-session'), 'draft-for-a', reason: '切回 A 应恢复 A 的草稿');
  });

  test('删除档案清理该命名空间缓存', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'https://a.example.com/m',
      'dsh_mr_token': 'a-token',
    });
    final manager = ConnectionManager(
      api: Api()..baseUrl = '',
      credentials: MemoryCredentialStore(),
    );
    await manager.load();
    final other = ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: 'B',
      baseUrls: ['https://b.example.com/m'],
      hostId: 'host-b',
    );
    manager.profiles.add(other);
    final prefs = await SharedPreferences.getInstance();
    final scopedKey = 'dsh_mr_session.${other.id}:host-b';
    await prefs.setString(scopedKey, 'cached-session');
    await manager.deleteProfile(other.id);
    expect(prefs.getString(scopedKey), isNull);
  });

  test('token-bearing 请求禁止跟随跨 origin 重定向', () async {
    var seen = false;
    final api = Api(
      client: MockClient((request) async {
        seen = true;
        expect(request.followRedirects, isFalse);
        return http.Response('{"ok":true}', 200);
      }),
    )..baseUrl = 'https://host.example.com';
    await api.getJson('/api/bootstrap');
    expect(seen, isTrue);
  });

  test('删除档案清理凭据；活动档案不可删除', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'https://a.example.com/m',
      'dsh_mr_token': 'a-token',
    });
    final creds = MemoryCredentialStore();
    final manager = ConnectionManager(
      api: Api()..baseUrl = '',
      credentials: creds,
    );
    await manager.load();
    final active = manager.activeProfileId;
    final other = ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: 'B',
      baseUrls: ['https://b.example.com/m'],
    );
    manager.profiles.add(other);
    await creds.writeToken(other.id, 'b-token');

    await expectLater(
      manager.deleteProfile(active),
      throwsA(isA<ConnectionSwitchException>()),
    );
    await manager.deleteProfile(other.id);
    expect(manager.profiles.where((p) => p.id == other.id), isEmpty);
    expect(await creds.readToken(other.id), isNull);
  });

  test('commit 在 activate 后失败：回滚 active/token/descriptor/profiles/Api', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'https://a.example.com/m',
      'dsh_mr_token': 'a-token',
    });
    final creds = _FailAfterActivateStore();
    final api = Api()..baseUrl = '';
    final manager = ConnectionManager(
      api: api,
      credentials: creds,
      probeBootstrap: (_) async => {'plugin': {'hostId': 'host-b'}},
    );
    await manager.load();
    creds.failNext = true;
    final a = manager.profiles.single;
    final oldGeneration = manager.generation;
    final b = ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: 'B',
      baseUrls: ['https://b.example.com/m'],
      hostId: 'host-b',
    );
    manager.profiles.add(b);
    await creds.writeToken(b.id, 'b-token');
    final stage = await manager.stageSwitch(b.id);
    await expectLater(manager.commitSwitch(stage), throwsA(anything));

    expect(manager.activeProfileId, a.id);
    expect(manager.generation, oldGeneration);
    expect(api.token, 'a-token');
    expect(api.baseUrl, 'https://a.example.com');
    expect(await creds.status().then((s) => s.activeProfileId), a.id);
    final prefs = await SharedPreferences.getInstance();
    expect((jsonDecode(prefs.getString('dsh_native_connection')!) as Map)['profileId'], a.id);
    expect(manager.profileScope, contains(a.id));
  });

  test('commit 在 profiles 持久化失败：回滚 descriptor/active/token/Api', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'https://a.example.com/m',
      'dsh_mr_token': 'a-token',
    });
    final creds = MemoryCredentialStore();
    final api = Api()..baseUrl = '';
    final manager = ConnectionManager(
      api: api,
      credentials: creds,
      probeBootstrap: (_) async => {'plugin': {'hostId': 'host-b'}},
    );
    await manager.load();
    final a = manager.profiles.single;
    final b = ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: 'B',
      baseUrls: ['https://b.example.com/m'],
      hostId: 'host-b',
    );
    manager.profiles.add(b);
    await creds.writeToken(b.id, 'b-token');
    final stage = await manager.stageSwitch(b.id);
    manager.persistOverride = () async => throw StateError('prefs-full');
    await expectLater(manager.commitSwitch(stage), throwsA(anything));

    expect(manager.activeProfileId, a.id);
    expect(api.token, 'a-token');
    expect(await creds.status().then((s) => s.activeProfileId), a.id);
    final prefs = await SharedPreferences.getInstance();
    expect((jsonDecode(prefs.getString('dsh_native_connection')!) as Map)['profileId'], a.id);
    expect(await creds.readToken(b.id), 'b-token', reason: 'target 旧 token 必须恢复');
  });

  test('启动检测 active A + token B / descriptor B：fail-closed 不套 token', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'https://a.example.com/m',
      'dsh_mr_token': 'a-token',
    });
    final creds = MemoryCredentialStore();
    final manager = ConnectionManager(api: Api()..baseUrl = '', credentials: creds);
    await manager.load();
    final a = manager.profiles.single;
    final b = ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: 'B',
      baseUrls: ['https://b.example.com/m'],
      hostId: 'host-b',
    );
    manager.profiles.add(b);
    await creds.writeToken(b.id, 'b-token');
    await creds.activate(b.id);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      'dsh_native_connection',
      jsonEncode({
        'profileId': b.id,
        'hostId': 'host-b',
        'generation': manager.generation,
        'baseUrl': 'https://b.example.com',
        'path': '/m',
      }),
    );

    final restarted = ConnectionManager(api: Api()..baseUrl = '', credentials: creds);
    await restarted.load();
    expect(restarted.activeProfileId, a.id);
    expect(restarted.migrationState, 'connection-state-mismatch');
    expect(restarted.api.token, isEmpty);
    expect(restarted.connectionStateError, isNotEmpty);
  });

  test('connectManual probe 失败：旧档案 endpoint/token 不变', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'https://a.example.com/m',
      'dsh_mr_token': 'a-token',
    });
    final creds = MemoryCredentialStore();
    final manager = ConnectionManager(
      api: Api()..baseUrl = '',
      credentials: creds,
      probeBootstrap: (_) async => throw StateError('offline'),
    );
    await manager.load();
    final before = manager.active!.toJson();
    await expectLater(
      manager.connectManual(
        baseUrl: 'https://changed.example.com/m',
        token: 'new-token',
      ),
      throwsA(isA<ConnectionSwitchException>()),
    );
    expect(manager.active!.toJson(), before);
    expect(await creds.readToken(manager.active!.id), 'a-token');
    expect(manager.api.baseUrl, 'https://a.example.com');
  });

  test('自定义挂载路径 probe 使用 /mobile-remote，且公网 HTTP 0 请求', () async {
    SharedPreferences.setMockInitialValues({});
    final seen = <String>[];
    final client = MockClient((request) async {
      seen.add(request.url.path);
      return http.Response(
        '{"ok":true,"plugin":{"hostId":"host-x"}}',
        200,
        headers: {'content-type': 'application/json'},
      );
    });
    final manager = ConnectionManager(
      api: Api()..baseUrl = '',
      credentials: MemoryCredentialStore(),
      probeClient: client,
    );
    final p = ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: '自定义',
      baseUrls: ['https://host.example.com'],
      path: '/mobile-remote',
      tlsPolicy: ProfileTlsPolicy.https,
    );
    manager.profiles.add(p);
    await manager.credentials.writeToken(p.id, 't');
    final stage = await manager.stageSwitch(p.id);
    expect(stage.hostId, 'host-x');
    expect(seen, ['/mobile-remote/api/bootstrap']);

    final publicHttp = ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: '公网 HTTP',
      baseUrls: ['http://8.8.8.8:3080'],
      tlsPolicy: ProfileTlsPolicy.httpPrivate,
      insecureConfirmed: true,
    );
    manager.profiles.add(publicHttp);
    await manager.credentials.writeToken(publicHttp.id, 't');
    seen.clear();
    await expectLater(
      manager.stageSwitch(publicHttp.id, allowInsecure: true),
      throwsA(isA<ConnectionSwitchException>()),
    );
    expect(seen, isEmpty, reason: '公网 HTTP 必须在 probe 前拒绝，0 token/0 请求');
  });

  test('旧未命名空间缓存只一次性迁移到首个档案', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'https://a.example.com/m',
      'dsh_mr_token': 'a-token',
      'dsh_mr_session': 'session-a',
      'dsh_mr_sessions_cache': 'cache-a',
      'dsh_mr_plugin_update_journal': '{"opId":"op-a"}',
    });
    final manager = ConnectionManager(
      api: Api()..baseUrl = '',
      credentials: MemoryCredentialStore(),
    );
    await manager.load();
    final a = manager.profiles.single;
    final b = ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: 'B',
      baseUrls: ['https://b.example.com/m'],
      hostId: 'host-b',
    );
    manager.profiles.add(b);
    final prefs = await SharedPreferences.getInstance();

    final storeA = AppStore(apiClient: Api())..attachConnections(manager);
    await storeA.loadPrefs();
    final scopeA = '${a.id}:${a.hostId}';
    expect(prefs.getString('dsh_mr_session.$scopeA'), 'session-a');
    expect(prefs.getString('dsh_mr_sessions_cache.$scopeA'), 'cache-a');
    expect(prefs.getBool('dsh_mr_profile_cache_migrated_v1'), isTrue);
    expect(prefs.getString('dsh_mr_session'), isNull);

    manager.activeProfileId = b.id;
    final storeB = AppStore(apiClient: Api())..attachConnections(manager);
    await storeB.loadPrefs();
    expect(storeB.sessionId, isNull, reason: 'B 不得借 A 的旧 session');
    expect(storeB.pluginUpdateJournal, isNull, reason: 'B 不得恢复 A 的插件事务');
    // marker 后新出现的全局旧 key 也不会被再次迁移。
    await prefs.setString('dsh_mr_session', 'late-global');
    final storeBAgain = AppStore(apiClient: Api())..attachConnections(manager);
    await storeBAgain.loadPrefs();
    expect(storeBAgain.sessionId, isNull);

    // 切回 A（模拟重启）：scoped 缓存仍在，恢复 A 的会话。
    manager.activeProfileId = a.id;
    final storeA2 = AppStore(apiClient: Api())..attachConnections(manager);
    await storeA2.loadPrefs();
    expect(storeA2.sessionId, 'session-a');
  });

  test('自动轮换：公网 HTTP 0 请求；hostId 变化拒绝；确认候选才允许', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'https://a.example.com/m',
      'dsh_mr_token': 'a-token',
    });
    final seen = <String>[];
    var probeHost = 'host-a';
    final client = MockClient((request) async {
      seen.add(request.url.path);
      return http.Response(
        '{"ok":true,"plugin":{"hostId":"$probeHost"}}',
        200,
        headers: {'content-type': 'application/json'},
      );
    });
    final api = Api()..baseUrl = '';
    final manager = ConnectionManager(
      api: api,
      credentials: MemoryCredentialStore(),
      probeClient: client,
    );
    await manager.load();
    final a = manager.profiles.single;
    a.hostId = 'host-a';
    manager.profiles[0] = a;
    await manager.credentials.writeToken(a.id, 'a-token');
    api.baseUrls = [
      'https://a.example.com',
      'http://8.8.8.8:3080',
    ];
    api.baseUrl = 'https://a.example.com';
    a.baseUrls = ['https://a.example.com'];
    manager.profiles[0] = a;

    // 广告/候选中的公网 HTTP：admission/verify 均拒绝，0 请求。
    seen.clear();
    expect((await api.rotateBaseUrlVerified()).rotated, isFalse);
    expect(seen, isEmpty);

    // 加入已确认 HTTPS 候选；hostId 变化拒绝。
    api.baseUrls = [
      'https://a.example.com',
      'https://c.example.com',
      'https://d.example.com',
    ];
    a.baseUrls = [
      'https://a.example.com',
      'https://c.example.com',
      'https://d.example.com',
    ];
    manager.profiles[0] = a;
    seen.clear();
    probeHost = 'host-b';
    expect((await api.rotateBaseUrlVerified()).rotated, isFalse);
    expect(seen, isNotEmpty);
    expect(api.baseUrl, 'https://a.example.com');

    // 确认且 hostId 一致：允许且只切该候选。
    seen.clear();
    probeHost = 'host-a';
    expect((await api.rotateBaseUrlVerified()).rotated, isTrue);
    expect(api.baseUrl, 'https://c.example.com');
    expect(seen, ['/m/api/bootstrap']);
  });

  test('切 B 清空全部宿主投影（running/jobs/queue/pending/未读）', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'https://a.example.com/m',
      'dsh_mr_token': 'a-token',
    });
    final api = _StoreApi();
    final manager = ConnectionManager(
      api: api,
      credentials: MemoryCredentialStore(),
      probeBootstrap: (_) async => {'plugin': {'hostId': 'host-b'}},
    );
    await manager.load();
    final b = ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: 'B',
      baseUrls: ['https://b.example.com/m'],
      hostId: 'host-b',
    );
    manager.profiles.add(b);
    await manager.credentials.writeToken(b.id, 'b-token');
    final store = AppStore(apiClient: api)..attachConnections(manager);
    addTearDown(store.disposeBridge);

    store.agentStatus = 'running';
    store.agentStatusMap['a'] = 'running';
    store.sessionAgentStatus['same-session'] = 'running';
    store.jobsBySession['same-session'] = [
      {'id': 'job-a', 'status': 'running'},
    ];
    store.queueBySession['same-session'] = [
      {'id': 'queue-a'},
    ];
    store.unread = 5;
    store.pendingQuestion = QuestionRequest(
      sessionId: 'same-session',
      rpcId: 'q-a',
      questions: const [],
    );

    final error = await store.switchProfile(b.id);
    expect(error, isNull);
    expect(store.agentStatus, 'idle');
    expect(store.agentStatusMap, isEmpty);
    expect(store.sessionAgentStatus, isEmpty);
    expect(store.jobsBySession, isEmpty);
    expect(store.queueBySession, isEmpty);
    expect(store.unread, 0);
    expect(store.pendingQuestion, isNull);
    expect(api.token, 'b-token');
    expect(api.hostIdentity, 'host-b');
  });

  test('已绑定 hostId → 探测缺失：fail-closed；确认后使用隔离身份', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'https://a.example.com/m',
      'dsh_mr_token': 'a-token',
    });
    final manager = ConnectionManager(
      api: Api()..baseUrl = '',
      credentials: MemoryCredentialStore(),
      probeBootstrap: (_) async => {'plugin': <String, dynamic>{}},
    );
    await manager.load();
    final a = manager.profiles.single;
    a.hostId = 'host-a';
    manager.profiles[0] = a;

    await expectLater(
      manager.stageSwitch(a.id),
      throwsA(
        isA<ConnectionSwitchException>().having(
          (e) => e.code,
          'code',
          'host-identity-missing',
        ),
      ),
    );
    final confirmed = await manager.stageSwitch(a.id, allowHostChange: true);
    expect(confirmed.hostId, isNot('host-a'));
    expect(confirmed.hostId, startsWith('legacy:'));
  });

  test('A2 probe 挂起时切 B：完成 true 也不改 B base/token，B token 不发 A2', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'https://a.example.com/m',
      'dsh_mr_token': 'a-token',
    });
    final gate = Completer<http.Response>();
    final tokens = <String?>[];
    final client = MockClient((request) async {
      tokens.add(request.headers['x-mobile-token']);
      return gate.future;
    });
    final api = Api()..baseUrl = '';
    final manager = ConnectionManager(
      api: api,
      credentials: MemoryCredentialStore(),
      probeClient: client,
    );
    await manager.load();
    final a = manager.profiles.single;
    a.hostId = 'host-a';
    a.baseUrls = ['https://a.example.com', 'https://a2.example.com'];
    manager.profiles[0] = a;
    api.baseUrls = ['https://a.example.com', 'https://a2.example.com'];
    api.baseUrl = 'https://a.example.com';

    final rotating = api.rotateBaseUrlVerified();
    for (var i = 0; i < 100 && tokens.isEmpty; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    expect(tokens, isNotEmpty);
    expect(tokens.every((t) => t == 'a-token'), isTrue);

    // 用户成功切 B：B token/profile 已生效。
    api.applyConnection(
      base: 'https://b.example.com',
      connectionPath: '/m',
      connectionToken: 'b-token',
      profile: 'profile-b',
      hostIdentity: 'host-b',
    );
    gate.complete(http.Response(
      '{"ok":true,"plugin":{"hostId":"${a.hostId}"}}',
      200,
      headers: {'content-type': 'application/json'},
    ));
    expect((await rotating).rotated, isFalse, reason: '旧 A2 验证结果必须被 CAS 丢弃');
    expect(api.baseUrl, 'https://b.example.com');
    expect(api.token, 'b-token');
    expect(api.profileId, 'profile-b');
    expect(tokens.every((t) => t == 'a-token'), isTrue, reason: 'B token 绝不能发到 A2');
  });

  test('首次绑定 hostId：旧 scope 缓存/草稿迁到新 scope，重启可见', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'https://a.example.com/m',
      'dsh_mr_token': 'a-token',
    });
    final manager = ConnectionManager(
      api: Api()..baseUrl = '',
      credentials: MemoryCredentialStore(),
      probeBootstrap: (_) async => {'plugin': {'hostId': 'host-a'}},
    );
    await manager.load();
    final a = manager.profiles.single;
    a.hostId = '';
    manager.profiles[0] = a;
    manager.activeProfileId = a.id;
    final api = _StoreApi();
    final store = AppStore(apiClient: api)..attachConnections(manager);
    addTearDown(store.disposeBridge);
    store.saveDraft('same', 'draft-before-binding');
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('dsh_mr_session.${a.id}:', 'session-before-binding');
    await prefs.setString(
      'dsh_attention_ledger_v1@${a.id}:',
      '{"version":1,"entries":[]}',
    );
    await prefs.setString(
      'dsh_mr_git_recent_files_repo@${a.id}:',
      '["old.txt"]',
    );

    final error = await store.switchProfile(a.id);
    expect(error, isNull);
    expect(manager.profileScope, '${a.id}:host-a');
    final moved = prefs.getString('dsh_mr_session.${a.id}:host-a');
    expect(moved, 'session-before-binding');
    expect(store.draftOf('same'), 'draft-before-binding');
    expect(prefs.getString('dsh_attention_ledger_v1@${a.id}:host-a'), isNotNull);
    expect(prefs.getString('dsh_mr_git_recent_files_repo@${a.id}:host-a'), isNotNull);
    expect(prefs.getString('dsh_attention_ledger_v1@${a.id}:'), isNull);
  });

  test('A1→A2 自动轮换同步 active profile/descriptor；重启沿用 A2', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'https://a1.example.com/m',
      'dsh_mr_token': 'a-token',
    });
    final api = Api()..baseUrl = '';
    final manager = ConnectionManager(
      api: api,
      credentials: MemoryCredentialStore(),
      probeClient: MockClient((request) async => http.Response(
        '{"ok":true,"plugin":{"hostId":"host-a"}}',
        200,
        headers: {'content-type': 'application/json'},
      )),
    );
    await manager.load();
    final a = manager.profiles.single;
    a.hostId = 'host-a';
    a.baseUrls = ['https://a1.example.com', 'https://a2.example.com'];
    manager.profiles[0] = a;
    api.baseUrls = ['https://a1.example.com', 'https://a2.example.com'];
    api.baseUrl = 'https://a1.example.com';
    final oldGeneration = manager.generation;

    expect((await api.rotateBaseUrlVerified()).rotated, isTrue);
    expect(api.baseUrl, 'https://a2.example.com');
    expect(manager.active!.primaryBase, 'https://a2.example.com');
    expect(manager.generation, oldGeneration + 1);
    final prefs = await SharedPreferences.getInstance();
    expect((jsonDecode(prefs.getString('dsh_native_connection')!) as Map)['baseUrl'],
        'https://a2.example.com');

    final restarted = ConnectionManager(
      api: Api()..baseUrl = '',
      credentials: manager.credentials,
      probeClient: manager.probeClient,
    );
    await restarted.load();
    expect(restarted.active!.primaryBase, 'https://a2.example.com');
    expect(restarted.api.baseUrl, 'https://a2.example.com');
  });

  test('A→B→A 草稿不跨档：B 看不到 A，切回 A 恢复', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'https://a.example.com/m',
      'dsh_mr_token': 'a-token',
    });
    var host = 'host-a';
    final manager = ConnectionManager(
      api: Api()..baseUrl = '',
      credentials: MemoryCredentialStore(),
      probeBootstrap: (_) async => {'plugin': {'hostId': host}},
    );
    await manager.load();
    final a = manager.profiles.single;
    a.hostId = 'host-a';
    manager.profiles[0] = a;
    final b = ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: 'B',
      baseUrls: ['https://b.example.com/m'],
      hostId: 'host-b',
    );
    manager.profiles.add(b);
    await manager.credentials.writeToken(b.id, 'b-token');
    final store = AppStore(apiClient: _StoreApi())..attachConnections(manager);
    addTearDown(store.disposeBridge);
    store.saveDraft('same-session', 'draft-a');

    host = 'host-b';
    expect(await store.switchProfile(b.id), isNull);
    expect(store.draftOf('same-session'), isEmpty, reason: 'B 不得看到 A 草稿');

    host = 'host-a';
    expect(await store.switchProfile(a.id), isNull);
    expect(store.draftOf('same-session'), 'draft-a', reason: '切回 A 应恢复 A 草稿');
  });

  test('A2 active-base 提交在途切 B：B 的持久档案/descriptor 不被 A 覆盖', () async {
    SharedPreferences.setMockInitialValues({
      'dsh_mr_base': 'https://a1.example.com/m',
      'dsh_mr_token': 'a-token',
    });
    var probeHost = 'host-a';
    final api = Api()..baseUrl = '';
    final manager = ConnectionManager(
      api: api,
      credentials: MemoryCredentialStore(),
      probeClient: MockClient((_) async => http.Response(
        '{"ok":true,"plugin":{"hostId":"$probeHost"}}',
        200,
        headers: {'content-type': 'application/json'},
      )),
    );
    await manager.load();
    final a = manager.profiles.single;
    a.hostId = 'host-a';
    a.baseUrls = ['https://a1.example.com', 'https://a2.example.com'];
    manager.profiles[0] = a;
    api.baseUrls = ['https://a1.example.com', 'https://a2.example.com'];
    api.baseUrl = 'https://a1.example.com';
    final gate = Completer<void>();
    var entered = false;
    manager.activeBaseGate = () {
      entered = true;
      return gate.future;
    };
    final b = ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: 'B',
      baseUrls: ['https://b.example.com/m'],
      hostId: 'host-b',
    );
    manager.profiles.add(b);
    await manager.credentials.writeToken(b.id, 'b-token');

    final rotation = api.rotateBaseUrlVerified();
    for (var i = 0; i < 100 && !entered; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    expect(entered, isTrue);
    probeHost = 'host-b';
    final stageB = await manager.stageSwitch(b.id);
    final switchingB = manager.commitSwitch(stageB);
    gate.complete();
    await rotation;
    await switchingB;

    final prefs = await SharedPreferences.getInstance();
    expect(manager.activeProfileId, b.id);
    expect((jsonDecode(prefs.getString('dsh_native_connection')!) as Map)['profileId'], b.id);
    expect((jsonDecode(prefs.getString('dsh_native_connection')!) as Map)['baseUrl'], 'https://b.example.com/m');
    expect(prefs.getString('dsh_mr_active_profile'), b.id);
    expect(await manager.credentials.status().then((s) => s.activeProfileId), b.id);
  });
}
