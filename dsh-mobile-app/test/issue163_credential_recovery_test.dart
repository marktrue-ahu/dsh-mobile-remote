// #163 P2：迁移/Keystore 恢复失败时，首装根壳和新连接档案页都必须展示
// 脱敏原因与 retryConnectionLoad 入口；旧凭据保留，重试失败仍可再试。
import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/connection_manager.dart';
import 'package:dsh_mobile_app/connection_profile.dart';
import 'package:dsh_mobile_app/credential_store.dart';
import 'package:dsh_mobile_app/main.dart';
import 'package:dsh_mobile_app/screens/connection_profiles_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _RecoveryManager extends ConnectionManager {
  _RecoveryManager({
    required super.api,
    required super.credentials,
    required this.profile,
  });

  final ConnectionProfile profile;
  bool failNext = true;
  int loadCalls = 0;

  @override
  Future<void> load() async {
    loadCalls++;
    if (failNext) {
      connectionStateError = '迁移安全凭据失败；旧口令仍保留，可重试迁移';
      this.api.token = '';
      return;
    }
    connectionStateError = '';
    this.api.baseUrl = 'https://home.example.com';
    this.api.path = '/m';
    this.api.token = await credentials.readToken(profile.id) ?? 'old-token';
  }
}

class _RecoveryStore extends AppStore {
  _RecoveryStore(Api api) : super(apiClient: api);

  /// 不触发真实 SSE/刷新；只模拟 retryConnectionLoad 的 manager.load + 通知。
  @override
  Future<String?> retryConnectionLoad() async {
    final manager = connections;
    if (manager == null) return '连接档案未初始化';
    await manager.load();
    if (!manager.configured) {
      return manager.connectionStateError.isNotEmpty
          ? manager.connectionStateError
          : '安全凭据仍不可用，请重新输入口令';
    }
    notifyListeners();
    return null;
  }
}

class _Fixture {
  _Fixture(this.api, this.manager, this.store, this.profile);

  final Api api;
  final _RecoveryManager manager;
  final _RecoveryStore store;
  final ConnectionProfile profile;
  String? get token => _token;
  String? _token;
}

Future<_Fixture> _fixture(WidgetTester tester) async {
  SharedPreferences.setMockInitialValues({});
  final api = Api();
  final credentials = MemoryCredentialStore();
  final profile = ConnectionProfile(
    id: ConnectionProfile.newId(),
    displayName: '家里',
    baseUrls: ['https://home.example.com/m'],
  );
  final manager = _RecoveryManager(
    api: api,
    credentials: credentials,
    profile: profile,
  )..failNext = true;
  manager.profiles.add(profile);
  manager.activeProfileId = profile.id;
  manager.connectionStateError = '迁移安全凭据失败；旧口令仍保留，可重试迁移';
  await credentials.writeToken(profile.id, 'old-token');
  final store = _RecoveryStore(api)..attachConnections(manager);
  await store.loadPrefs();
  await store.markIconMigrationTipShown();
  return _Fixture(api, manager, store, profile)
    .._token = await credentials.readToken(profile.id);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('RootScreen 迁移失败→提示→重试失败→重试恢复，旧凭据保留', (tester) async {
    final f = await _fixture(tester);
    addTearDown(f.store.disposeBridge);
    await tester.pumpWidget(
      MaterialApp(
        home: RootScreen(storeOverride: f.store, apiOverride: f.api),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('root-unconfigured')), findsOneWidget);
    expect(find.byKey(const ValueKey('root-credential-error')), findsOneWidget);
    expect(find.textContaining('迁移安全凭据失败；旧口令仍保留，可重试迁移'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('root-retry-credentials')),
      findsOneWidget,
    );
    expect(await _tokenOf(f), 'old-token');

    // 第一次重试仍失败：提示可见，凭据不删除。
    await tester.tap(find.byKey(const ValueKey('root-retry-credentials')));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('root-credential-retry-error')),
      findsOneWidget,
    );
    expect(f.api.token, '');
    expect(await _tokenOf(f), 'old-token');

    // 第二次重试恢复：根壳切到已配置主界面，凭据仍在。
    f.manager.failNext = false;
    await tester.tap(find.byKey(const ValueKey('root-retry-credentials')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('root-unconfigured')), findsNothing);
    expect(f.manager.connectionStateError, isEmpty);
    expect(f.api.baseUrl, 'https://home.example.com');
    expect(f.api.token, 'old-token');
    expect(await _tokenOf(f), 'old-token');
  });

  testWidgets('连接档案页同样展示脱敏原因与重试入口，恢复后清除横幅', (tester) async {
    final f = await _fixture(tester);
    addTearDown(f.store.disposeBridge);
    await tester.pumpWidget(
      MaterialApp(home: ConnectionProfilesScreen(store: f.store)),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('connection-credential-error')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('connection-retry-credentials')),
      findsOneWidget,
    );
    expect(
      tester
          .widget<Text>(
            find.byKey(const ValueKey('connection-credential-reason')),
          )
          .data,
      contains('旧口令仍保留'),
    );

    f.manager.failNext = false;
    await tester.tap(
      find.byKey(const ValueKey('connection-retry-credentials')),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('connection-credential-error')),
      findsNothing,
    );
    expect(await _tokenOf(f), 'old-token');
  });
}

Future<String?> _tokenOf(_Fixture f) async {
  final manager = f.store.connections!;
  return manager.credentials.readToken(f.profile.id);
}
