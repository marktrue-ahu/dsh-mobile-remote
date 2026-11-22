// GitLab #152：Drawer 切换 sheet / 聊天页确认 / 添加电脑的最小 UI 契约。
import 'dart:async';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/connection_manager.dart';
import 'package:dsh_mobile_app/connection_profile.dart';
import 'package:dsh_mobile_app/credential_store.dart';
import 'package:dsh_mobile_app/screens/connection_profiles_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeSwitchStore extends AppStore {
  _FakeSwitchStore() : super(apiClient: _NoopApi());

  @override
  Future<String?> switchProfile(
    String profileId, {
    bool allowHostChange = false,
    bool allowInsecure = false,
  }) async {
    connections!.activeProfileId = profileId;
    return null;
  }
}

class _NoopApi extends Api {
  _NoopApi()
    : super(
        client: MockClient(
          (_) async => http.Response(
            '{"ok":true,"sessions":[],"events":[]}',
            200,
            headers: {'content-type': 'application/json'},
          ),
        ),
      );

  final controller = StreamController<Map<String, dynamic>>.broadcast();

  @override
  Stream<Map<String, dynamic>> eventsRaw() => controller.stream;
}

ConnectionProfile _profile(String name, String base, {String host = ''}) =>
    ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: name,
      baseUrls: [base],
      hostId: host,
      tlsPolicy: base.startsWith('https://')
          ? ProfileTlsPolicy.https
          : ProfileTlsPolicy.httpPrivate,
      insecureConfirmed: !base.startsWith('https://'),
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Api api;
  late MemoryCredentialStore credentials;
  late ConnectionManager manager;
  late AppStore store;
  late ConnectionProfile a;
  late ConnectionProfile b;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    api = _NoopApi();
    credentials = MemoryCredentialStore();
    manager = ConnectionManager(
      api: api,
      credentials: credentials,
      probeBootstrap: (_) async => {
        'plugin': {'hostId': 'host-b'},
      },
    );
    a = _profile('家里', 'https://a.example.com/m', host: 'host-a');
    b = _profile('公司', 'https://b.example.com/m');
    manager.profiles.addAll([a, b]);
    manager.activeProfileId = a.id;
    await credentials.writeToken(a.id, 'token-a');
    await credentials.writeToken(b.id, 'token-b');
    await credentials.activate(a.id);
    store = _FakeSwitchStore()..attachConnections(manager);
  });

  tearDown(() => store.disposeBridge());

  testWidgets('切换 sheet：当前档案、列表、添加入口', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => showConnectionProfilesScreen(context, store),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('连接档案'), findsOneWidget);
    expect(find.text('家里'), findsWidgets);
    expect(find.text('公司'), findsOneWidget);
    expect(find.byKey(const ValueKey('connection-add')), findsOneWidget);
  });

  testWidgets('设置页可直接嵌入的自包含连接区块', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: ConnectionSettingsSection(store: store)),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('connection-settings-section')), findsOneWidget);
    expect(find.text('家里'), findsOneWidget);
  });

  testWidgets('320 / 1.5× / 深色：sheet 不溢出', (tester) async {
    await tester.binding.setSurfaceSize(const Size(320, 640));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData.dark(),
        home: MediaQuery(
          data: const MediaQueryData(
            size: Size(320, 640),
            textScaler: TextScaler.linear(1.5),
          ),
          child: Builder(
            builder: (context) => TextButton(
              onPressed: () => showConnectionProfilesScreen(context, store),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('connection-add')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('切换成功：提交 active 并关闭 sheet', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => showConnectionProfilesScreen(context, store),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(ValueKey('connection-profile-${b.id}')));
    for (var i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    expect(manager.activeProfileId, b.id);
    // sheet 已关闭（open 按钮是根页唯一文本）
    expect(find.byKey(const ValueKey('connection-add')), findsNothing);
  });
}
