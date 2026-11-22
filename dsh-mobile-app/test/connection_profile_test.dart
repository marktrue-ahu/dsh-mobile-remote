// GitLab #152：连接档案迁移、staged 切换、失败保留旧连接、hostId 绑定、
// (profileId,hostId) 命名空间与凭据清理。
import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/connection_manager.dart';
import 'package:dsh_mobile_app/connection_profile.dart';
import 'package:dsh_mobile_app/credential_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

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
}
