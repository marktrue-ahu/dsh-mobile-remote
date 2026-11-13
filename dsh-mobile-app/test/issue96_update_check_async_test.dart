// issue #96：App 后端异步检查（POST checkId → GET 轮询 done）、超时保留 checkId、
// 旧宿主 POST 404/200{} 回退同步 GET；确认只在 done+update-available 返回。

import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> _available() => {
  'ok': true,
  'state': 'done',
  'checkId': 'chk-1',
  'pluginUpdate': {
    'state': 'update-available',
    'reason': 'version-newer',
    'candidate': {
      'plugin': {'version': '3.2.5'},
      'carrier': {'version': '3.2.5-app', 'appVersion': '3.2.5+47'},
    },
  },
};

void main() {
  test('POST → checkId → 1s/2s 轮询 → done 才返回 update-available', () async {
    final requests = <http.Request>[];
    var polls = 0;
    final api = Api(client: MockClient((request) async {
      requests.add(request);
      if (request.method == 'POST' &&
          request.url.path.endsWith('/api/plugin-update/check')) {
        expect(jsonDecode(request.body), {'force': true});
        return http.Response(
          jsonEncode({'ok': true, 'state': 'checking', 'checkId': 'chk-1'}),
          200,
        );
      }
      polls += 1;
      if (polls == 1) {
        return http.Response(
          jsonEncode({'ok': true, 'state': 'checking', 'checkId': 'chk-1'}),
          200,
        );
      }
      return http.Response(jsonEncode(_available()), 200);
    }))
      ..baseUrl = 'http://host:3080'
      ..path = '/m'
      ..token = 'tok';
    final states = <String>[];
    final result = await api.checkPluginUpdateAsync(
      force: true,
      pollDelays: const [Duration(milliseconds: 5), Duration(milliseconds: 5)],
      onProgress: states.add,
    );
    expect(requests.first.method, 'POST');
    expect(requests.last.url.queryParameters['checkId'], 'chk-1');
    expect(polls, 2);
    expect(states, ['checking', 'done']);
    expect((result['pluginUpdate'] as Map)['state'], 'update-available');
  });

  test('总 35s 超时（测试缩短）抛 PluginUpdateCheckTimeout 且保留 checkId', () async {
    final api = Api(client: MockClient((request) async {
      if (request.method == 'POST') {
        return http.Response(
          jsonEncode({'ok': true, 'state': 'checking', 'checkId': 'chk-timeout'}),
          200,
        );
      }
      return http.Response(
        jsonEncode({'ok': true, 'state': 'checking', 'checkId': 'chk-timeout'}),
        200,
      );
    }))
      ..baseUrl = 'http://host:3080'
      ..path = '/m'
      ..token = 'tok';
    await expectLater(
      api.checkPluginUpdateAsync(
        totalTimeout: const Duration(milliseconds: 40),
        pollDelays: const [Duration(milliseconds: 10)],
      ),
      throwsA(isA<PluginUpdateCheckTimeout>()
          .having((e) => e.checkId, 'checkId', 'chk-timeout')),
    );
  });

  test('旧宿主 POST 404 → 回退同步 GET，不报错', () async {
    final requests = <http.Request>[];
    final api = Api(client: MockClient((request) async {
      requests.add(request);
      if (request.method == 'POST') {
        return http.Response(
          jsonEncode({'ok': false, 'error': 'not-found'}),
          404,
        );
      }
      return http.Response(
        jsonEncode({
          'ok': true,
          'pluginUpdate': {'state': 'up-to-date', 'reason': 'same-version'},
        }),
        200,
      );
    }))
      ..baseUrl = 'http://host:3080'
      ..path = '/m'
      ..token = 'tok';
    final result = await api.checkPluginUpdateAsync();
    expect(requests.map((r) => r.method), ['POST', 'GET']);
    expect((result['pluginUpdate'] as Map)['state'], 'up-to-date');
  });

  test('POST 200 但无 checkId（旧宿主/代理）→ 回退同步 GET', () async {
    final requests = <http.Request>[];
    final api = Api(client: MockClient((request) async {
      requests.add(request);
      if (request.method == 'POST') return http.Response('{}', 200);
      return http.Response(
        jsonEncode({
          'ok': true,
          'pluginUpdate': {'state': 'up-to-date'},
        }),
        200,
      );
    }))
      ..baseUrl = 'http://host:3080'
      ..path = '/m'
      ..token = 'tok';
    final result = await api.checkPluginUpdateAsync();
    expect(requests.map((r) => r.method), ['POST', 'GET']);
    expect((result['pluginUpdate'] as Map)['state'], 'up-to-date');
  });

  test('error 状态抛 ApiException，不把半结果当 done', () async {
    final api = Api(client: MockClient((request) async {
      if (request.method == 'POST') {
        return http.Response(
          jsonEncode({'ok': true, 'state': 'checking', 'checkId': 'chk-err'}),
          200,
        );
      }
      return http.Response(
        jsonEncode({
          'ok': true,
          'state': 'error',
          'checkId': 'chk-err',
          'error': 'check-timeout',
        }),
        200,
      );
    }))
      ..baseUrl = 'http://host:3080'
      ..path = '/m'
      ..token = 'tok';
    await expectLater(
      api.checkPluginUpdateAsync(
        pollDelays: const [Duration(milliseconds: 5)],
      ),
      throwsA(isA<ApiException>()
          .having((e) => e.code, 'code', 'update-check-failed')),
    );
  });
}
