// issue #96：设置页更新行异步检查进度（检查中…），done 后显示结果；不在 checking
// 时弹确认/结果。

import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/notify_diag.dart';
import 'package:dsh_mobile_app/screens/settings_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _ResumeApi extends Api {
  _ResumeApi()
      : super(
          client: MockClient(
            (request) async => http.Response('{}', 200),
          ),
        );

  int posts = 0;
  int resumes = 0;
  bool expireResume = false;

  static Map<String, dynamic> _done() => {
    'pluginUpdate': {
      'state': 'up-to-date',
      'reason': 'same-version',
      'canSelfUpdate': true,
      'checkLog': <Object>[],
      'transaction': null,
    },
  };

  @override
  Future<Map<String, dynamic>> checkPluginUpdateAsync({
    bool force = false,
    Duration totalTimeout = const Duration(seconds: 35),
    void Function(String state)? onProgress,
    List<Duration>? pollDelays,
  }) async {
    posts += 1;
    if (posts == 1) {
      throw const PluginUpdateCheckTimeout('chk-ui');
    }
    return _done();
  }

  @override
  Future<Map<String, dynamic>> resumePluginUpdateCheck(
    String checkId, {
    Duration totalTimeout = const Duration(seconds: 35),
    void Function(String state)? onProgress,
    List<Duration>? pollDelays,
  }) async {
    resumes += 1;
    if (expireResume) throw PluginUpdateCheckExpired(checkId);
    return _done();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    NotifyDiag.notificationsEnabled = true;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('dsh/floating'),
      (call) async => false,
    );
  });

  Future<AppStore> pumpSettings(
    WidgetTester tester,
    MockClient client, {
    Duration checkTimeout = const Duration(seconds: 35),
    Api? apiOverride,
  }) async {
    final api = apiOverride ??
        (Api(client: client)
          ..baseUrl = 'http://host:3080'
          ..path = '/m'
          ..token = 'tok');
    final store = AppStore(apiClient: api);
    await store.loadPrefs();
    addTearDown(store.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SettingsScreen(
            store: store,
            onReconfigure: () async {},
            pluginCheckTotalTimeout: checkTimeout,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final title = find.text('更新电脑端插件');
    await tester.scrollUntilVisible(
      title,
      240,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
    return store;
  }

  testWidgets('检查中显示进度，done 后才显示结果', (tester) async {
    var polls = 0;
    final client = MockClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/api/plugin-update/check') &&
          request.method == 'POST') {
        return http.Response(
          jsonEncode({'ok': true, 'state': 'checking', 'checkId': 'chk-ui'}),
          200,
        );
      }
      if (path.endsWith('/api/plugin-update/check') &&
          request.url.queryParameters.containsKey('checkId')) {
        polls += 1;
        if (polls == 1) {
          return http.Response(
            jsonEncode({'ok': true, 'state': 'checking', 'checkId': 'chk-ui'}),
            200,
          );
        }
        return http.Response(
          jsonEncode({
            'ok': true,
            'state': 'done',
            'checkId': 'chk-ui',
            'pluginUpdate': {
              'state': 'up-to-date',
              'reason': 'same-version',
              'canSelfUpdate': true,
              'checkLog': <Object>[],
              'transaction': null,
            },
          }),
          200,
        );
      }
      if (path == '/m/api/history') {
        return http.Response(
          jsonEncode({'ok': true, 'events': <Object>[], 'hasMore': false}),
          200,
        );
      }
      return http.Response('{}', 200);
    });
    await pumpSettings(tester, client);
    final row = find
        .ancestor(of: find.text('更新电脑端插件'), matching: find.byType(InkWell))
        .first;
    await tester.tap(row);
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('检查中…'), findsOneWidget, reason: '检查中不得空白/可重复点');
    expect(find.text('电脑端插件已是最新'), findsNothing, reason: 'checking 阶段不得提前出结果');

    // 第一次轮询（1s）返回 checking。
    await tester.pump(const Duration(milliseconds: 1100));
    expect(find.text('检查中…'), findsOneWidget);
    // 第二次轮询（2s）返回 done → 结果提示。
    await tester.pump(const Duration(milliseconds: 2100));
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('电脑端插件已是最新'), findsOneWidget);
    expect(find.text('检查中…'), findsNothing);
  });
  testWidgets('超时保留 checkId，更新行“继续检查”复用原 checkId 不新 POST', (tester) async {
    final fake = _ResumeApi();
    await pumpSettings(
      tester,
      MockClient((request) async => http.Response('{}', 200)),
      apiOverride: fake,
    );
    final row = find
        .ancestor(of: find.text('更新电脑端插件'), matching: find.byType(InkWell))
        .first;
    await tester.tap(row);
    await tester.pump(const Duration(milliseconds: 100));
    expect(fake.posts, 1);
    expect(find.text('继续检查 ▸'), findsOneWidget);

    await tester.tap(row);
    await tester.pump(const Duration(milliseconds: 100));
    expect(fake.resumes, 1, reason: '续查必须复用原 checkId');
    expect(fake.posts, 1, reason: '续查不得重新 POST');
    expect(find.text('继续检查 ▸'), findsNothing);
  });

  testWidgets('续查 410 → 清旧 checkId 并自动重启新检查', (tester) async {
    final fake = _ResumeApi()..expireResume = true;
    await pumpSettings(
      tester,
      MockClient((request) async => http.Response('{}', 200)),
      apiOverride: fake,
    );
    final row = find
        .ancestor(of: find.text('更新电脑端插件'), matching: find.byType(InkWell))
        .first;
    await tester.tap(row);
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('继续检查 ▸'), findsOneWidget);

    await tester.tap(row);
    await tester.pump(const Duration(milliseconds: 100));
    expect(fake.resumes, 1);
    expect(fake.posts, 2, reason: '410 后应自动重启检查');
    expect(find.text('继续检查 ▸'), findsNothing);
  });

}
