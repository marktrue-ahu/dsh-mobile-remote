// GitLab #152：Dart → Android Keystore 凭据桥。
//
// 明文 token 只存在于进程内 Api 与 Android CredentialStore；Dart prefs 不写 token。
// 测试使用 [MemoryCredentialStore]，生产使用 [MethodChannelCredentialStore]。
import 'package:flutter/services.dart';

import 'connection_profile.dart';

abstract class CredentialStore {
  Future<String?> readToken(String profileId);
  Future<String?> readActiveToken();
  Future<String?> activeProfileId();
  Future<void> writeToken(String profileId, String token);
  Future<void> deleteToken(String profileId);
  Future<void> activate(String profileId);
  Future<void> deactivate();
  Future<CredentialStatus> status();
}

class CredentialStatus {
  const CredentialStatus({
    this.activeProfileId = '',
    this.hasToken = false,
    this.migrationState = '',
  });
  final String activeProfileId;
  final bool hasToken;
  final String migrationState;
}

class MethodChannelCredentialStore implements CredentialStore {
  MethodChannelCredentialStore([this.channel = const MethodChannel('dsh/credentials')]);
  final MethodChannel channel;

  @override
  Future<String?> readToken(String profileId) async {
    final value = await channel.invokeMethod<String>('readToken', {'profileId': profileId});
    return value == null || value.isEmpty ? null : value;
  }

  @override
  Future<String?> readActiveToken() async {
    final value = await channel.invokeMethod<String>('readActive');
    return value == null || value.isEmpty ? null : value;
  }

  @override
  Future<String?> activeProfileId() async {
    final status = await this.status();
    return status.activeProfileId.isEmpty ? null : status.activeProfileId;
  }

  @override
  Future<void> writeToken(String profileId, String token) =>
      channel.invokeMethod<void>('writeToken', {'profileId': profileId, 'token': token});

  @override
  Future<void> deleteToken(String profileId) =>
      channel.invokeMethod<void>('deleteToken', {'profileId': profileId});

  @override
  Future<void> activate(String profileId) =>
      channel.invokeMethod<void>('activate', {'profileId': profileId});

  @override
  Future<void> deactivate() => channel.invokeMethod<void>('deactivate');

  @override
  Future<CredentialStatus> status() async {
    final value = await channel.invokeMapMethod<String, dynamic>('status');
    return CredentialStatus(
      activeProfileId: value?['activeProfileId']?.toString() ?? '',
      hasToken: value?['hasToken'] == true,
      migrationState: value?['migrationState']?.toString() ?? '',
    );
  }
}

/// 测试/非 Android 的内存实现：不提供明文持久化。
class MemoryCredentialStore implements CredentialStore {
  final Map<String, String> _tokens = {};
  String _active = '';
  String migrationState = '';

  @override
  Future<String?> readToken(String profileId) async => _tokens[profileId];

  @override
  Future<String?> readActiveToken() async => _tokens[_active];

  @override
  Future<String?> activeProfileId() async => _active.isEmpty ? null : _active;

  @override
  Future<void> writeToken(String profileId, String token) async {
    _tokens[profileId] = token;
  }

  @override
  Future<void> deleteToken(String profileId) async {
    _tokens.remove(profileId);
    if (_active == profileId) _active = '';
  }

  @override
  Future<void> activate(String profileId) async {
    if (!_tokens.containsKey(profileId)) {
      throw StateError('credential-missing');
    }
    _active = profileId;
  }

  @override
  Future<void> deactivate() async => _active = '';

  @override
  Future<CredentialStatus> status() async => CredentialStatus(
    activeProfileId: _active,
    hasToken: _tokens.containsKey(_active),
    migrationState: migrationState,
  );
}

/// 非敏感连接描述符（原生只读）：Swift/Kotlin 用它校验 active/generation。
Map<String, dynamic> nativeConnectionDescriptor({
  required ConnectionProfile profile,
  required String hostId,
  required int generation,
}) => {
  'profileId': profile.id,
  'hostId': hostId,
  'generation': generation,
  'baseUrl': profile.primaryBase,
  'path': profile.path,
  'tlsPolicy': profile.tlsPolicy.name,
  'migrationState': 'complete',
};
