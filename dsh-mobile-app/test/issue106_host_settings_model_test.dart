// issue #106：DSH 设置只读查看器 —— App 侧模型与 API 契约。
//
// 覆盖安全契约里 App 必须守住的部分：
//   - **不保存白名单副本、不补默认值、不猜 schema**：响应里没有的项不可见；
//   - 未知 kind / 缺 ns / 缺路径的行**丢弃**（fail-closed），不猜一半；
//   - secret 只保留 set 状态，值是空串、无默认、无来源；
//   - `complete:false` 的命名空间即使误带 fields 也**不保留任何字段**；
//   - 搜索只匹配标题/命名空间/键路径，**不搜值**；
//   - 旧宿主（404/405）→ unsupported，不当网络失败。
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/host_settings.dart';
import 'package:dsh_mobile_app/l10n.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Api _apiWith(MockClient client) => Api(client: client)
  ..baseUrl = 'http://127.0.0.1:1'
  ..token = 't';

Map<String, dynamic> _field({
  String ns = 'web-search-deepseek',
  String keyPath = 'model',
  String title = '搜索模型',
  String kind = 'value',
  bool secretSet = false,
  String valueText = 'deepseek-v4-flash',
  String valueKind = 'string',
  String? defaultText,
  bool hasDefault = false,
  String source = 'default',
  Map<String, dynamic>? layers,
}) => {
  'ns': ns,
  'keyPath': keyPath,
  'title': title,
  'titleEn': '',
  'groupId': 'model-routing',
  'kind': kind,
  if (kind == 'secret') 'secretSet': secretSet,
  if (kind == 'value') ...{
    'valueText': valueText,
    'valueKind': valueKind,
    'defaultText': defaultText,
    'hasDefault': hasDefault,
    'source': source,
  },
  'layers': layers ?? {'user': false, 'base': false, 'schema': false},
};

Map<String, dynamic> _namespace({
  String ns = 'web-search-deepseek',
  String title = '联网搜索',
  bool complete = true,
  String reason = '',
  List<Object?>? fields,
}) => {
  'ns': ns,
  'title': title,
  'titleEn': '',
  'groupId': 'model-routing',
  'revision': 1,
  'complete': complete,
  'reason': reason,
  'fields': fields ?? [_field()],
};

Map<String, dynamic> _body({
  bool supported = true,
  bool complete = true,
  String reason = '',
  List<Map<String, dynamic>>? namespaces,
  String dshVersion = '0.2.2-rc.5',
}) => {
  'ok': true,
  'supported': supported,
  'complete': complete,
  'reason': reason,
  'writable': false,
  'whitelistVersion': 1,
  'generatedAt': '2026-11-23T00:00:00.000Z',
  'host': {'dshVersion': dshVersion, 'pluginVersion': '3.3.1-alpha.2'},
  'groups': [
    {'id': 'model-routing', 'title': '模型与路由', 'titleEn': ''},
  ],
  'namespaces': namespaces ?? [_namespace()],
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => L10n.lang = 'zh');

  group('解析：字段 / 命名空间 / 响应', () {
    test('完整形状：值、来源、默认值、层级', () {
      final view = HostSettingsView.fromJson(_body(namespaces: [
        _namespace(fields: [
          _field(
            valueText: 'deepseek-v4-pro',
            defaultText: 'deepseek-v4-flash',
            hasDefault: true,
            source: 'user',
            layers: {'user': true, 'base': true, 'schema': true},
          ),
        ]),
      ]));
      expect(view.supported, isTrue);
      expect(view.dshVersion, '0.2.2-rc.5');
      final field = view.visibleNamespaces.single.fields.single;
      expect(field.valueText, 'deepseek-v4-pro');
      expect(field.defaultText, 'deepseek-v4-flash');
      expect(field.hasDefault, isTrue);
      expect(field.source, HostSettingSource.user);
      expect(field.userLayer, isTrue);
      expect(field.isOverridden, isTrue);
    });

    test('secret 只保留 set 状态：无值、无默认、无来源', () {
      final view = HostSettingsView.fromJson(_body(namespaces: [
        _namespace(fields: [
          _field(
            keyPath: 'apiKey',
            title: 'API 密钥',
            kind: 'secret',
            secretSet: true,
            // 即使宿主误带"值"，App 也不保留。
            valueText: 'sk-should-not-survive',
            defaultText: 'sk-default-should-not-survive',
            hasDefault: true,
            source: 'user',
          ),
        ]),
      ]));
      final field = view.visibleNamespaces.single.fields.single;
      expect(field.isSecret, isTrue);
      expect(field.secretSet, isTrue);
      expect(field.valueText, isEmpty);
      expect(field.defaultText, isNull);
      expect(field.hasDefault, isFalse);
      expect(field.source, HostSettingSource.unknown);
      expect(field.isOverridden, isFalse, reason: 'secret 不参与来源筛选');
      expect(field.hasDefaultDelta, isFalse);
      // 序列化后的字段对象里也不得残留值。
      expect(
        jsonEncode({
          'valueText': field.valueText,
          'defaultText': field.defaultText,
        }).contains('should-not-survive'),
        isFalse,
      );
    });

    test('未知 kind / 缺 ns / 缺路径 / 缺标题的行一律丢弃（fail-closed）', () {
      final view = HostSettingsView.fromJson(_body(namespaces: [
        _namespace(fields: [
          _field(),
          {..._field(keyPath: 'x'), 'kind': 'something-new'},
          {..._field(), 'ns': ''},
          {..._field(), 'keyPath': ''},
          {..._field(), 'title': ''},
          'not-a-map',
        ]),
      ]));
      final fields = view.visibleNamespaces.single.fields;
      expect(fields, hasLength(1), reason: '只保留形状完全合法的行');
      expect(fields.single.keyPath, 'model');
    });

    test('complete:false 的命名空间不保留任何字段（即使宿主误带）', () {
      final view = HostSettingsView.fromJson(_body(
        complete: false,
        reason: 'value-with-absolute-path',
        namespaces: [
          _namespace(
            complete: false,
            reason: 'value-with-absolute-path',
            fields: [_field(valueText: '/home/mark/.ssh/id_ed25519')],
          ),
        ],
      ));
      expect(view.complete, isFalse);
      expect(view.namespaces.single.fields, isEmpty);
      expect(view.visibleNamespaces, isEmpty);
      expect(view.failedNamespaces, hasLength(1));
    });

    test('supported:false 整页降级；原因码映射不泄露原文', () {
      final view = HostSettingsView.fromJson(_body(
        supported: false,
        complete: false,
        reason: 'settings-describe-unavailable',
      ));
      expect(view.supported, isFalse);
      expect(view.reasonText(), contains('过旧'));
      expect(view.reasonText().contains('/'), isFalse);

      final missing = HostSettingsView.unsupported('endpoint-missing');
      expect(missing.supported, isFalse);
      expect(missing.reasonText(), contains('不支持'));
    });

    test('不可见项：响应里没有的命名空间/字段不出现在模型里', () {
      final view = HostSettingsView.fromJson(_body(namespaces: [
        _namespace(ns: 'agent-default-model', title: '默认模型', fields: [
          _field(ns: 'agent-default-model', keyPath: 'model', title: '默认模型'),
        ]),
      ]));
      final nsIds = view.namespaces.map((n) => n.ns).toList();
      expect(nsIds, ['agent-default-model']);
      // App 不会因为"宿主没给"就补出 web-search-deepseek 或 permission。
      expect(nsIds.contains('web-search-deepseek'), isFalse);
      expect(nsIds.contains('permission'), isFalse);
      expect(
        view.visibleNamespaces.single.fields.map((f) => f.keyPath).toList(),
        ['model'],
      );
    });

    test('搜索只匹配标题/命名空间/键路径，绝不匹配值', () {
      final field = HostSettingField.fromJson(_field(
        keyPath: 'maxUses',
        title: '单次最多搜索次数',
        valueText: 'deepseek-v4-flash',
      ))!;
      expect(field.matches('搜索'), isTrue, reason: '标题命中');
      expect(field.matches('web-search'), isTrue, reason: '命名空间命中');
      expect(field.matches('maxUses'), isTrue, reason: '键路径命中');
      expect(field.matches('deepseek-v4-flash'), isFalse, reason: '值不参与搜索');
    });

    test('筛选：已覆盖只留用户覆盖；有默认差异含组合默认', () {
      final view = HostSettingsView.fromJson(_body(namespaces: [
        _namespace(fields: [
          _field(keyPath: 'a', source: 'user'),
          _field(keyPath: 'b', source: 'base'),
          _field(keyPath: 'c', source: 'default'),
          _field(keyPath: 'd', source: 'unknown'),
        ]),
      ]));
      final namespace = view.visibleNamespaces.single;
      List<String> keys(HostSettingFilter filter) =>
          namespace.filtered(filter, '').map((f) => f.keyPath).toList();
      expect(keys(HostSettingFilter.all), ['a', 'b', 'c', 'd']);
      expect(keys(HostSettingFilter.overridden), ['a']);
      expect(keys(HostSettingFilter.delta), ['a', 'b']);
    });

    test('分组顺序按宿主 groups；未分组的命名空间排在最后', () {
      final view = HostSettingsView.fromJson(_body(namespaces: [
        // groupId 为空 = 宿主未给它分组 → 必须排在已分组项之后。
        _namespace(ns: 'orphan', title: '未分组', fields: [
          _field(ns: 'orphan', keyPath: 'x', title: 'X'),
        ]).map((k, v) => k == 'groupId' ? MapEntry(k, '') : MapEntry(k, v)).cast<String, dynamic>(),
        _namespace(ns: 'web-search-deepseek', fields: [_field()]),
      ]));
      expect(
        view.visibleNamespaces.map((n) => n.ns).toList(),
        ['web-search-deepseek', 'orphan'],
      );
      expect(view.groupTitleOf(view.visibleNamespaces.first), '模型与路由');
      expect(view.groupTitleOf(view.visibleNamespaces.last), isEmpty,
          reason: '未分组不伪造分组名');
    });
  });

  group('API 契约', () {
    test('GET /api/host-settings：解析成功', () async {
      Uri? seen;
      final api = _apiWith(MockClient((request) async {
        seen = request.url;
        return http.Response(jsonEncode(_body()), 200,
            headers: {'content-type': 'application/json'});
      }));
      final view = await api.hostSettings();
      expect(seen?.path, '/m/api/host-settings');
      expect(view.supported, isTrue);
      expect(view.visibleNamespaces.single.fields.single.title, '搜索模型');
    });

    test('旧宿主 404 → unsupported（不当网络失败）', () async {
      final api = _apiWith(MockClient(
        (_) async => http.Response('{"error":"not-found"}', 404),
      ));
      final view = await api.hostSettings();
      expect(view.supported, isFalse);
      expect(view.reason, 'endpoint-missing');
    });

    test('405 同样按旧宿主降级', () async {
      final api = _apiWith(MockClient(
        (_) async => http.Response('{"error":"method-not-allowed"}', 405),
      ));
      final view = await api.hostSettings();
      expect(view.supported, isFalse);
      expect(view.reason, 'endpoint-missing');
    });

    test('宿主 200 + supported:false 原样透出（不当作旧宿主/失败）', () async {
      final api = _apiWith(MockClient((_) async => http.Response(
            jsonEncode(_body(
              supported: false,
              complete: false,
              reason: 'whitelist-empty',
            )),
            200,
            headers: {'content-type': 'application/json'},
          )));
      final view = await api.hostSettings();
      expect(view.supported, isFalse);
      expect(view.reason, 'whitelist-empty');
      expect(view.reason, isNot('endpoint-missing'));
    });

    test('App 不拼路径、不带字段参数：请求 URL 无 query', () async {
      Uri? seen;
      final api = _apiWith(MockClient((request) async {
        seen = request.url;
        return http.Response(jsonEncode(_body()), 200,
            headers: {'content-type': 'application/json'});
      }));
      await api.hostSettings();
      expect(seen?.query, isEmpty, reason: 'App 不按路径取数，只请求固定端点');
      expect(seen?.pathSegments.last, 'host-settings');
    });
  });
}
