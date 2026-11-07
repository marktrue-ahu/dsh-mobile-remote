// issue #60 R15：通知 scope 用宿主稳定身份，不用可能复用的访问口令。

import 'package:dsh_mobile_app/api.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Api _api({
  String base = 'http://host-a.test',
  String token = 'same-token-123456',
  String path = '/m',
  String hostId = '',
}) {
  final api = Api(client: MockClient((_) async => http.Response('{}', 200)))
    ..baseUrl = base
    ..token = token
    ..path = path
    ..hostIdentity = hostId;
  return api;
}

void main() {
  test('两个宿主同口令同挂载路径但 hostId 不同 → notificationScope 不同', () {
    final a = _api(hostId: '11111111-1111-4111-8111-111111111111');
    final b = _api(hostId: '22222222-2222-4222-8222-222222222222');
    expect(a.notificationScope, isNot(b.notificationScope));
  });

  test('同一宿主跨地址轮换 scope 稳定', () {
    final lan = _api(base: 'http://192.168.1.10:3080', hostId: 'host-uuid');
    final tail = _api(base: 'http://100.64.0.2:3080', hostId: 'host-uuid');
    expect(lan.notificationScope, tail.notificationScope);
  });

  test('旧插件缺 hostId 时回退现状（口令+路径）；不同口令仍隔离', () {
    final a = _api(token: 'token-a');
    final same = _api(token: 'token-a');
    final other = _api(token: 'token-b');
    expect(a.notificationScope, same.notificationScope);
    expect(a.notificationScope, isNot(other.notificationScope));
  });

  test('absorbBootstrap 解析 plugin.hostId', () {
    final api = _api();
    expect(api.hostIdentity, isEmpty);
    api.absorbBootstrap({
      'plugin': {
        'version': '3.3.0',
        'hostId': '33333333-3333-4333-8333-333333333333',
      },
    });
    expect(api.hostIdentity, '33333333-3333-4333-8333-333333333333');
  });
}
