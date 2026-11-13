// issue #96：设置页更新行异步检查进度（检查中…），done 后显示结果；不在 checking
// 时弹确认/结果。

import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/notify_diag.dart';
import 'package:dsh_mobile_app/screens/settings_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    NotifyDiag.notificationsEnabled = true;
  });

  Future<AppStore> pumpSettings(WidgetTester tester, MockClient client) async {
    final api = Api(client: client)
      ..baseUrl = 'http://host:3080'
      ..path = '/m'
      ..token = 'tok';
    final store = AppStore(apiClient: api);
    await store.loadPrefs();
    addTearDown(store.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SettingsScreen(store: store, onReconfigure: () async {}),
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
}
