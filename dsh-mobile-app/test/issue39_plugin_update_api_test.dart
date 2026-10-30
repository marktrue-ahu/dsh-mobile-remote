import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test('plugin check, legacy prepare, update and log use authenticated host routes', () async {
    final seen = <http.Request>[];
    final api = Api(client: MockClient((request) async {
      seen.add(request);
      if (request.url.path.endsWith('/api/plugin-update/check')) {
        return http.Response(jsonEncode({'pluginUpdate': {
          'state': 'update-available',
          'candidate': {'plugin': {'name': 'demo', 'version': '2.0.0'}, 'carrier': {'version': '2.0.0', 'appVersion': '4.0.0+9', 'legacyMetadataMissing': true}},
        }}), 200);
      }
      if (request.url.path.endsWith('/api/plugin-update/prepare')) {
        return http.Response(jsonEncode({'action': 'prepared', 'opId': 'op-39', 'prepareId': 'prep-1', 'candidate': {'carrier': {'appVersion': '4.0.0+9'}}}), 200);
      }
      if (request.url.path.endsWith('/api/plugin-update/log')) {
        return http.Response(jsonEncode({'ok': true, 'opId': 'op-39', 'events': [
          {'seq': 4, 'at': '2026-01-01T00:00:00Z', 'stage': 'install', 'stream': 'stdout', 'text': 'installed'},
          {'seq': 5, 'at': '2026-01-01T00:00:01Z', 'stage': 'install', 'stream': 'stderr', 'text': 'token=secret'},
        ]}), 200);
      }
      return http.Response(jsonEncode({'action': 'accepted'}), 200);
    }))..baseUrl = 'http://host:3080'..path = '/m'..token = 'secret-token';

    final check = await api.checkPluginUpdate();
    expect((check['pluginUpdate'] as Map)['state'], 'update-available');
    final prepared = await api.preparePluginUpdate(opId: 'op-39');
    expect(prepared['prepareId'], 'prep-1');
    await api.triggerPluginUpdate(opId: 'op-39', targetVersion: '2.0.0', prepareId: 'prep-1');
    final log = await api.pluginUpdateLog(opId: 'op-39', afterSeq: 3);

    expect(seen.map((r) => r.url.path), [
      '/m/api/plugin-update/check', '/m/api/plugin-update/prepare',
      '/m/api/plugin-update', '/m/api/plugin-update/log',
    ]);
    expect(seen.every((r) => r.headers['x-mobile-token'] == 'secret-token'), isTrue);
    expect(jsonDecode(seen[1].body), {'opId': 'op-39'});
    expect(jsonDecode(seen[2].body), {'opId': 'op-39', 'targetVersion': '2.0.0', 'prepareId': 'prep-1'});
    expect(seen[3].url.queryParameters, {'opId': 'op-39', 'afterSeq': '3'});
    expect((log['events'] as List).length, 2);
  });
}
