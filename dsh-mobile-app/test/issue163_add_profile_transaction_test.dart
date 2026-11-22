// #163 P2：addProfile 是写 Keystore + 内存 profiles + prefs 的复合事务；
// write/readback/_saveProfiles 任一失败都必须回滚，重启后无档案、无凭据。
import 'dart:async';
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/connection_manager.dart';
import 'package:dsh_mobile_app/connection_profile.dart';
import 'package:dsh_mobile_app/credential_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FaultCredentialStore implements CredentialStore {
  final Map<String, String> tokens = {};
  String active = '';
  bool failWrite = false;
  bool failRead = false;
  bool failDelete = false;

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
    if (failDelete) throw StateError('credential-delete-failed');
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
  test('回滚持久化也失败：marker 保留，重启后修复半成品', () async {
    SharedPreferences.setMockInitialValues({});
    final creds = _FaultCredentialStore();
    final manager = await _manager(creds);
    manager.persistOverride = () async {
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
      throw StateError('forward-partial');
    };
    manager.restoreOverride = () async => throw StateError('rollback-failed');
    await expectLater(
      manager.addProfile(
        displayName: '测试电脑',
        baseUrl: 'https://home.example.com/m',
        token: 'token',
      ),
      throwsA(anything),
    );
    final prefs = await SharedPreferences.getInstance();
    expect(
      prefs.getString('dsh_mr_add_txn'),
      isNotNull,
      reason: '回滚失败必须留 marker',
    );
    expect(creds.tokens, isEmpty, reason: 'token 清理仍应成功');

    // 模拟重启：load 通过 marker 修复 profiles，不留半成品。
    final restarted = ConnectionManager(
      api: Api()..baseUrl = '',
      credentials: creds,
    );
    await restarted.load();
    expect(restarted.profiles, isEmpty);
    expect(restarted.connectionStateError, isEmpty);
    expect(prefs.getString('dsh_mr_add_txn'), isNull);
    final raw = prefs.getString('dsh_mr_connection_profiles');
    expect(raw == null || raw == '[]', isTrue);
  });

  test('回滚与凭据删除都失败：marker 保留并明确标记 cleanup-incomplete', () async {
    SharedPreferences.setMockInitialValues({});
    final creds = _FaultCredentialStore()..failDelete = true;
    final manager = await _manager(creds);
    manager.persistOverride = () async {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('dsh_mr_connection_profiles', '[{"id":"orphan"}]');
      throw StateError('forward-partial');
    };
    manager.restoreOverride = () async => throw StateError('rollback-failed');
    await expectLater(
      manager.addProfile(
        displayName: '测试电脑',
        baseUrl: 'https://home.example.com/m',
        token: 'token',
      ),
      throwsA(anything),
    );
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('dsh_mr_add_txn'), isNotNull);
    expect(creds.tokens, isNotEmpty, reason: '删除失败时 token 仍在，不能假装清理完成');

    final restarted = ConnectionManager(
      api: Api()..baseUrl = '',
      credentials: creds,
    );
    await restarted.load();
    expect(restarted.connectionStateError, contains('清理未完成'));
    expect(prefs.getString('dsh_mr_add_txn'), isNotNull);
    expect(restarted.profiles, isEmpty, reason: '内存不得展示半成品');

    // 存储/凭据恢复后再次 load 应完成修复。
    creds.failDelete = false;
    await restarted.load();
    expect(restarted.connectionStateError, isEmpty);
    expect(prefs.getString('dsh_mr_add_txn'), isNull);
    expect(restarted.profiles, isEmpty);
    expect(creds.tokens, isEmpty);
  });

  test('add 失败 gate 期间 A2 提交成功：串行队列不得用过时快照覆盖 A2', () async {
    SharedPreferences.setMockInitialValues({});
    final creds = _FaultCredentialStore();
    final manager = ConnectionManager(
      api: Api()..baseUrl = '',
      credentials: creds,
    );
    final a = ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: 'A',
      baseUrls: ['https://a.example.com/m'],
      hostId: 'host-a',
    );
    manager.profiles.add(a);
    manager.activeProfileId = a.id;
    manager.generation = 1;
    await creds.writeToken(a.id, 'a-token');
    await creds.activate(a.id);

    final entered = Completer<void>();
    final release = Completer<void>();
    manager.addProfileGate = () async {
      entered.complete();
      await release.future;
    };
    manager.persistOverride = () async {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        'dsh_mr_connection_profiles',
        jsonEncode([a.toJson()]),
      );
      throw StateError('forward-partial');
    };
    manager.restoreOverride = () async => throw StateError('rollback-failed');

    final addFuture = manager.addProfile(
      displayName: 'new',
      baseUrl: 'https://new.example.com/m',
      token: 'new-token',
    );
    await entered.future;
    final a2Future = manager.commitActiveBase('https://a2.example.com');
    release.complete();
    await expectLater(addFuture, throwsA(anything));
    expect(await a2Future, isTrue);
    expect(manager.active!.primaryBase, 'https://a2.example.com');
    expect(manager.generation, 2);
    expect(manager.profiles.map((p) => p.id), [a.id]);

    // 重启：marker 看到 A2 已推进 generation，只清失败新增，不覆盖 A2。
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('dsh_mr_add_txn'), isNotNull);
    final restarted = ConnectionManager(
      api: Api()..baseUrl = '',
      credentials: creds,
    );
    await restarted.load();
    expect(restarted.connectionStateError, isEmpty);
    expect(restarted.active!.primaryBase, 'https://a2.example.com');
    expect(restarted.generation, 2);
    expect(restarted.profiles.map((p) => p.id), [a.id]);
    expect(creds.tokens.keys, [a.id]);
    final descriptor =
        jsonDecode(prefs.getString('dsh_native_connection')!) as Map;
    expect(descriptor['baseUrl'], 'https://a2.example.com');
    expect(descriptor['generation'], 2);
    expect(prefs.getString('dsh_mr_add_txn'), isNull);
  });
}
