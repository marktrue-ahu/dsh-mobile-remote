// #163 P2：addProfile 是写 Keystore + 内存 profiles + prefs 的复合事务；
// write/readback/_saveProfiles 任一失败都必须回滚，重启后无档案、无凭据。
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/connection_manager.dart';
import 'package:dsh_mobile_app/credential_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FaultCredentialStore implements CredentialStore {
  final Map<String, String> tokens = {};
  String active = '';
  bool failWrite = false;
  bool failRead = false;

  @override
  Future<String?> readToken(String profileId) async {
    if (failRead) throw StateError('credential-read-failed');
    return tokens[profileId];
  }

  @override
  Future<String?> readActiveToken() async => tokens[active];

  @override
  Future<String?> activeProfileId() async => active.isEmpty ? null : active;

  @override
  Future<void> writeToken(String profileId, String token) async {
    if (failWrite) throw StateError('credential-write-failed');
    tokens[profileId] = token;
  }

  @override
  Future<void> deleteToken(String profileId) async {
    tokens.remove(profileId);
    if (active == profileId) active = '';
  }

  @override
  Future<void> activate(String profileId) async {
    if (!tokens.containsKey(profileId)) throw StateError('credential-missing');
    active = profileId;
  }

  @override
  Future<void> deactivate() async => active = '';

  @override
  Future<void> refreshNative() async {}

  @override
  Future<CredentialStatus> status() async => CredentialStatus(
    activeProfileId: active,
    hasToken: tokens.containsKey(active),
  );
}

Future<ConnectionManager> _manager(_FaultCredentialStore creds) async =>
    ConnectionManager(api: Api()..baseUrl = '', credentials: creds);

Future<void> _expectNoPersistedProfile(
  ConnectionManager manager,
  _FaultCredentialStore creds,
) async {
  expect(manager.profiles, isEmpty);
  expect(manager.activeProfileId, isEmpty);
  expect(creds.tokens, isEmpty, reason: '失败不得留下孤儿 Keystore 凭据');
  final prefs = await SharedPreferences.getInstance();
  final raw = prefs.getString('dsh_mr_connection_profiles');
  expect(raw == null || raw == '[]', isTrue, reason: 'prefs 不得留半成品档案');

  // 模拟重启：同一 prefs/凭据重新 load，应仍是空档案。
  final restarted = ConnectionManager(
    api: Api()..baseUrl = '',
    credentials: creds,
  );
  await restarted.load();
  expect(restarted.profiles, isEmpty);
  expect(restarted.active, isNull);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('Keystore write 失败：回滚内存/prefs，重启无档案无凭据', () async {
    SharedPreferences.setMockInitialValues({});
    final creds = _FaultCredentialStore()..failWrite = true;
    final manager = await _manager(creds);
    await expectLater(
      manager.addProfile(
        displayName: '测试电脑',
        baseUrl: 'https://home.example.com/m',
        token: 'token',
      ),
      throwsA(anything),
    );
    await _expectNoPersistedProfile(manager, creds);
  });

  test('write 后 readback 失败：删除已写 token 并回滚档案', () async {
    SharedPreferences.setMockInitialValues({});
    final creds = _FaultCredentialStore()..failRead = true;
    final manager = await _manager(creds);
    await expectLater(
      manager.addProfile(
        displayName: '测试电脑',
        baseUrl: 'https://home.example.com/m',
        token: 'token',
      ),
      throwsA(anything),
    );
    await _expectNoPersistedProfile(manager, creds);
  });

  test('profiles 持久化部分写入后失败：恢复旧快照并删 token', () async {
    SharedPreferences.setMockInitialValues({});
    final creds = _FaultCredentialStore();
    final manager = await _manager(creds);
    manager.persistOverride = () async {
      // 模拟 setString 写入了半成品后抛错；外层必须恢复旧快照。
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        'dsh_mr_connection_profiles',
        jsonEncode([
          {
            'id': 'orphan',
            'displayName': 'orphan',
            'baseUrls': ['https://orphan.example.com/m'],
          },
        ]),
      );
      throw StateError('partial-prefs-write');
    };
    await expectLater(
      manager.addProfile(
        displayName: '测试电脑',
        baseUrl: 'https://home.example.com/m',
        token: 'token',
      ),
      throwsA(anything),
    );
    await _expectNoPersistedProfile(manager, creds);
  });
}
