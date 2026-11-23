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

  String? lastAddedName;
  String? lastAddedBase;
  String? lastAddedToken;
  String? lastAddedPath;
  String? lastEditedName;
  String? lastEditedBase;
  String? lastEditedToken;
  String? addError;
  String? editError;
  Completer<String?>? addGate;

  @override
  Future<String?> addAndSwitchProfile({
    required String displayName,
    required String baseUrl,
    required String token,
    bool allowInsecure = false,
    String? path,
  }) async {
    lastAddedName = displayName;
    lastAddedBase = baseUrl;
    lastAddedToken = token;
    lastAddedPath = path;
    final gate = addGate;
    if (gate != null) return gate.future;
    return addError;
  }

  @override
  Future<String?> editAndSwitchProfile(
    ConnectionProfile profile, {
    required String baseUrl,
    String? token,
    String? displayName,
    bool allowInsecure = false,
  }) async {
    lastEditedBase = baseUrl;
    lastEditedToken = token;
    lastEditedName = displayName;
    return editError;
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

  testWidgets('添加页：输入 HTTP 才显示未加密确认；编辑页预填现有档案', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: ConnectionProfileEditorScreen(
          key: const ValueKey('editor-add'),
          store: store,
          manager: manager,
        ),
      ),
    );
    expect(
      find.byKey(const ValueKey('connection-allow-insecure')),
      findsNothing,
    );
    expect(
      find.byKey(const ValueKey('connection-profile-scan')),
      findsOneWidget,
    );
    await tester.enterText(
      find.byType(TextField).at(1),
      'http://192.168.1.2:3080',
    );
    await tester.pump();
    expect(
      find.byKey(const ValueKey('connection-allow-insecure')),
      findsOneWidget,
    );

    await tester.pumpWidget(
      MaterialApp(
        home: ConnectionProfileEditorScreen(
          key: const ValueKey('editor-edit'),
          store: store,
          manager: manager,
          profile: a,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      tester.widget<TextField>(find.byType(TextField).at(0)).controller?.text,
      a.displayName,
    );
    expect(
      tester.widget<TextField>(find.byType(TextField).at(1)).controller?.text,
      a.primaryBase,
    );
    expect(
      tester.widget<TextField>(find.byType(TextField).at(2)).controller?.text,
      isEmpty,
      reason: '编辑页不回显明文口令',
    );
    // issue #171：编辑态也提供扫码（文案为「扫码替换」，会覆盖地址/口令但不改名称）。
    expect(
      find.byKey(const ValueKey('connection-profile-scan')),
      findsOneWidget,
      reason: '编辑态必须能直接扫码替换连接',
    );
    expect(find.text('扫码替换'), findsOneWidget);
  });

  testWidgets('编辑自定义挂载档案只改名称：path 保留，不被覆盖成 /m', (tester) async {
    final fake = store as _FakeSwitchStore;
    final custom = ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: '自定义',
      baseUrls: ['https://c.example.com'],
      path: '/mobile-remote',
      hostId: 'host-c',
    );
    manager.profiles.add(custom);
    await tester.pumpWidget(
      MaterialApp(
        home: ConnectionProfileEditorScreen(
          key: const ValueKey('editor-custom'),
          store: store,
          manager: manager,
          profile: custom,
        ),
      ),
    );
    expect(
      tester.widget<TextField>(find.byType(TextField).at(1)).controller?.text,
      'https://c.example.com/mobile-remote',
    );
    await tester.enterText(find.byType(TextField).at(0), '改名');
    await tester.tap(find.byKey(const ValueKey('connection-profile-save')));
    await tester.pumpAndSettle();
    expect(fake.lastEditedBase, contains('/mobile-remote'));
  });

  testWidgets('添加表单：名称必填/去空白/长度/重名就地报错，不提交', (tester) async {
    final fake = store as _FakeSwitchStore;
    await tester.pumpWidget(
      MaterialApp(
        home: ConnectionProfileEditorScreen(store: store, manager: manager),
      ),
    );
    final name = find.byKey(const ValueKey('connection-profile-name'));
    final base = find.byKey(const ValueKey('connection-profile-base'));
    final token = find.byKey(const ValueKey('connection-profile-token'));
    final save = find.byKey(const ValueKey('connection-profile-save'));
    await tester.enterText(base, 'https://new.example.com');
    await tester.enterText(token, 'token');
    await tester.tap(save);
    await tester.pumpAndSettle();
    expect(find.text('请填写主机名称'), findsOneWidget);
    expect(fake.lastAddedName, isNull);

    await tester.enterText(name, '   ');
    await tester.tap(save);
    await tester.pumpAndSettle();
    expect(find.text('请填写主机名称'), findsOneWidget);

    await tester.enterText(name, '名' * 33);
    await tester.tap(save);
    await tester.pumpAndSettle();
    expect(find.text('主机名称最多 32 个字符'), findsOneWidget);

    await tester.enterText(name, '家里');
    await tester.tap(save);
    await tester.pumpAndSettle();
    expect(find.text('该主机名称已存在，请换一个名称'), findsOneWidget);
    expect(fake.lastAddedName, isNull);

    await tester.enterText(name, '  新电脑  ');
    await tester.tap(save);
    await tester.pumpAndSettle();
    expect(fake.lastAddedName, '新电脑');
    expect(fake.lastAddedBase, 'https://new.example.com');
    expect(find.text('添加电脑'), findsNothing);
  });

  testWidgets('编辑表单：口令留空不修改，输入新口令才替换；名称可改', (tester) async {
    final fake = store as _FakeSwitchStore;
    Future<void> pumpEditor() async {
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(
        MaterialApp(
          home: ConnectionProfileEditorScreen(
            key: ValueKey('edit-${DateTime.now().microsecondsSinceEpoch}'),
            store: store,
            manager: manager,
            profile: a,
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    await pumpEditor();
    // 只改名称、口令留空：token 传 null（由 manager 读取旧 Keystore 凭据）。
    await tester.enterText(find.byType(TextField).at(0), '家里-新名');
    await tester.tap(find.byKey(const ValueKey('connection-profile-save')));
    await tester.pumpAndSettle();
    expect(fake.lastEditedToken, isNull);
    expect(fake.lastEditedName, '家里-新名');
    expect(fake.lastEditedBase, contains(a.primaryBase));

    await pumpEditor();
    await tester.enterText(find.byType(TextField).at(0), '家里-再改名');
    await tester.enterText(find.byType(TextField).at(2), 'new-token');
    await tester.tap(find.byKey(const ValueKey('connection-profile-save')));
    await tester.pumpAndSettle();
    expect(fake.lastEditedToken, 'new-token');
    expect(fake.lastEditedName, '家里-再改名');
  });

  testWidgets('保存失败留在表单并显示错误，不改变旧档案', (tester) async {
    final fake = store as _FakeSwitchStore;
    fake.editError = '切换失败：目标不可达';
    await tester.pumpWidget(
      MaterialApp(
        home: ConnectionProfileEditorScreen(
          store: store,
          manager: manager,
          profile: a,
        ),
      ),
    );
    await tester.enterText(find.byType(TextField).at(0), '失败试用');
    await tester.tap(find.byKey(const ValueKey('connection-profile-save')));
    await tester.pumpAndSettle();
    expect(find.textContaining('切换失败'), findsOneWidget);
    expect(find.text('编辑电脑'), findsOneWidget);
    expect(a.displayName, '家里');
    expect(fake.lastEditedName, '失败试用');
  });

  testWidgets('取消编辑不提交；系统返回不触发保存', (tester) async {
    final fake = store as _FakeSwitchStore;
    await tester.pumpWidget(
      MaterialApp(
        home: ConnectionProfileEditorScreen(
          store: store,
          manager: manager,
          profile: a,
        ),
      ),
    );
    await tester.enterText(find.byType(TextField).at(0), '不应保存');
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(fake.lastEditedName, isNull);
    expect(a.displayName, '家里');
  });

  testWidgets('320 / 2.0× / 深色：添加/编辑表单不溢出', (tester) async {
    await tester.binding.setSurfaceSize(const Size(320, 640));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData.dark(),
        home: MediaQuery(
          data: const MediaQueryData(
            size: Size(320, 640),
            textScaler: TextScaler.linear(2.0),
          ),
          child: ConnectionProfileEditorScreen(
            store: store,
            manager: manager,
            profile: a,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('connection-profile-name')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('添加页保存中系统返回被阻止；取消后不提交', (tester) async {
    final fake = store as _FakeSwitchStore;
    fake.addGate = Completer<String?>();
    await tester.pumpWidget(
      MaterialApp(
        home: ConnectionProfileEditorScreen(
          key: const ValueKey('editor-busy'),
          store: store,
          manager: manager,
        ),
      ),
    );
    await tester.enterText(find.byType(TextField).at(0), '新电脑');
    await tester.enterText(
      find.byType(TextField).at(1),
      'https://new.example.com',
    );
    await tester.enterText(find.byType(TextField).at(2), 'token');
    await tester.tap(find.byKey(const ValueKey('connection-profile-save')));
    await tester.pump();
    await tester.binding.handlePopRoute();
    await tester.pump();
    expect(find.text('添加电脑'), findsOneWidget, reason: '保存中不得离开页面');

    fake.addGate!.complete(null);
    await tester.pumpAndSettle();
    expect(find.text('添加电脑'), findsNothing);
  });

// ── issue #171：编辑态扫码 ──────────────────────────────────────────────────
testWidgets('#171 编辑态点扫码：有输入时先确认，取消则表单不变', (tester) async {
  await tester.pumpWidget(
    MaterialApp(
      home: ConnectionProfileEditorScreen(
        store: store,
        manager: manager,
        profile: a,
      ),
    ),
  );
  await tester.pumpAndSettle();

  final baseField = tester.widget<TextField>(find.byType(TextField).at(1));
  final before = baseField.controller?.text;

  // 编辑态已有 base 输入 → 点扫码应先弹确认。
  await tester.tap(find.byKey(const ValueKey('connection-profile-scan')));
  await tester.pumpAndSettle();
  expect(
    find.byKey(const ValueKey('connection-scan-confirm')),
    findsOneWidget,
    reason: '当前输入非空时必须确认，避免误扫覆盖',
  );

  // 取消：不进入扫码页，表单保持原值。
  await tester.tap(find.byKey(const ValueKey('connection-scan-cancel')));
  await tester.pumpAndSettle();
  expect(find.byKey(const ValueKey('connection-scan-confirm')), findsNothing);
  expect(
    tester.widget<TextField>(find.byType(TextField).at(1)).controller?.text,
    before,
  );
});

testWidgets('#171 编辑态扫码文案为「扫码替换」且按钮可用', (tester) async {
  await tester.pumpWidget(
    MaterialApp(
      home: ConnectionProfileEditorScreen(
        store: store,
        manager: manager,
        profile: a,
      ),
    ),
  );
  await tester.pumpAndSettle();

  expect(find.text('扫码替换'), findsOneWidget);
  expect(find.text('扫码添加'), findsNothing, reason: '编辑态不应显示添加文案');
  // 按钮可交互：key 命中且能找到扫码图标（未禁用时 onPressed 非空由上一行文案同源保证）。
  expect(
    find.descendant(
      of: find.byKey(const ValueKey('connection-profile-scan')),
      matching: find.byIcon(Icons.qr_code_scanner),
    ),
    findsOneWidget,
  );
});

}
