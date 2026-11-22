// GitLab #152 / ADR 0036：连接档案仓库 + 单活动 staged 切换。
//
// 职责边界：
// - profileId 主键；hostId 只在探测/提交成功后绑定；instanceId 从不参与身份；
// - 切换先对目标档案做只读 bootstrap（旧连接不动），成功后才写凭据/描述符并替换 Api；
// - token 只经 CredentialStore（Android Keystore），Dart prefs 不存明文；
// - 失败保留旧 active/旧 Api/旧 token，不进入半切换状态。
import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'connection_profile.dart';
import 'credential_store.dart';
import 'profile_namespace.dart';

class ConnectionManager {
  ConnectionManager({
    required this.api,
    required this.credentials,
    SharedPreferences? prefs,
    Future<Map<String, dynamic>> Function(Api probe)? probeBootstrap,
  }) : _prefs = prefs,
       _probeBootstrap = probeBootstrap;

  final Api api;
  final CredentialStore credentials;
  final Future<Map<String, dynamic>> Function(Api probe)? _probeBootstrap;
  SharedPreferences? _prefs;

  final List<ConnectionProfile> profiles = [];
  String activeProfileId = '';
  int generation = 0;
  String migrationState = '';

  ConnectionProfile? get active {
    for (final profile in profiles) {
      if (profile.id == activeProfileId) return profile;
    }
    return null;
  }

  bool get configured => active != null && api.token.isNotEmpty;

  /// `(profileId, hostId)` 命名空间；hostId 为空（旧插件）时只用 profileId。
  String get profileScope {
    final p = active;
    if (p == null) return '';
    return '${p.id}:${p.hostId}';
  }

  Future<SharedPreferences> get _store async =>
      _prefs ??= await SharedPreferences.getInstance();

  static const _kProfiles = 'dsh_mr_connection_profiles';
  static const _kActive = 'dsh_mr_active_profile';
  static const _kGeneration = 'dsh_mr_connection_generation';
  static const _kNativeDescriptor = 'dsh_native_connection';
  static const _kLegacyBase = 'dsh_mr_base';
  static const _kLegacyPath = 'dsh_mr_path';
  static const _kLegacyToken = 'dsh_mr_token';
  static const _kLegacyUrls = 'dsh_mr_urls';
  static const _kMigrationState = 'dsh_mr_connection_migration';

  Future<void> load() async {
    final prefs = await _store;
    generation = prefs.getInt(_kGeneration) ?? 0;
    profiles
      ..clear()
      ..addAll(_readProfiles(prefs));
    activeProfileId = prefs.getString(_kActive) ?? '';

    if (profiles.isEmpty) {
      await _migrateLegacy(prefs);
    }
    if (profiles.isNotEmpty && active == null) {
      activeProfileId = profiles.first.id;
      await prefs.setString(_kActive, activeProfileId);
    }
    final current = active;
    if (current == null) {
      if (migrationState == 'empty' || migrationState == 'complete') {
        migrationState = 'empty';
      }
      return;
    }
    ProfileNamespace.setScope(profileScope);
    try {
      final token = await credentials.readActiveToken() ??
          await credentials.readToken(current.id);
      if (token == null || token.isEmpty) {
        migrationState = 'credential-missing';
        api.token = '';
        return;
      }
      api.applyConnection(
        base: current.primaryBase,
        connectionPath: current.path,
        connectionToken: token,
        profile: current.id,
        hostIdentity: current.hostId,
        urls: current.baseUrls,
      );
      migrationState = 'complete';
    } catch (e) {
      migrationState = 'credential-unavailable';
      api.token = '';
    }
  }

  List<ConnectionProfile> _readProfiles(SharedPreferences prefs) {
    final raw = prefs.getString(_kProfiles);
    if (raw == null || raw.isEmpty) return const [];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const [];
      return [
        for (final item in decoded)
          if (ConnectionProfile.fromJson(item) != null)
            ConnectionProfile.fromJson(item)!,
      ];
    } catch (_) {
      return const [];
    }
  }

  Future<void> _saveProfiles() async {
    final prefs = await _store;
    await prefs.setString(
      _kProfiles,
      jsonEncode([for (final profile in profiles) profile.toJson()]),
    );
    await prefs.setString(_kActive, activeProfileId);
    await prefs.setInt(_kGeneration, generation);
  }

  /// 首次升级迁移：base/urls 元数据 + Keystore token + 原生描述符全部成功后才删旧 token。
  Future<void> _migrateLegacy(SharedPreferences prefs) async {
    final base = (prefs.getString(_kLegacyBase) ?? '').trim();
    final legacyToken = prefs.getString(_kLegacyToken) ?? '';
    if (base.isEmpty && legacyToken.isEmpty) {
      migrationState = 'empty';
      return;
    }
    if (base.isEmpty || legacyToken.isEmpty) {
      migrationState = 'legacy-incomplete';
      return;
    }
    final id = ConnectionProfile.newId();
    final urls = prefs.getStringList(_kLegacyUrls) ?? const [];
    final normalized = <String>[base];
    for (final value in urls) {
      if (value.isNotEmpty &&
          value != base &&
          normalized.length < 8 &&
          !normalized.contains(value)) {
        normalized.add(value);
      }
    }
    final profile = ConnectionProfile(
      id: id,
      displayName: _legacyName(base),
      baseUrls: normalized,
      path: prefs.getString(_kLegacyPath) ?? '/m',
      tlsPolicy: base.startsWith('https://')
          ? ProfileTlsPolicy.https
          : ProfileTlsPolicy.httpPrivate,
      insecureConfirmed: !base.startsWith('https://'),
      lastSeen: DateTime.now().millisecondsSinceEpoch,
    );
    try {
      await credentials.writeToken(id, legacyToken);
      final readback = await credentials.readToken(id);
      if (readback != legacyToken) throw StateError('token-readback-mismatch');
      profiles.add(profile);
      activeProfileId = id;
      generation += 1;
      await _writeNativeDescriptor(profile, '', generation);
      await credentials.activate(id);
      final status = await credentials.status();
      if (status.activeProfileId != id || !status.hasToken) {
        throw StateError('native-readback-mismatch');
      }
      await _saveProfiles();
      // 双端 readback/activate 成功后才删旧明文；失败时保留旧 key（原生永不读取）。
      await prefs.remove(_kLegacyToken);
      migrationState = 'complete';
    } catch (e) {
      // 迁移失败不自动回退明文；清理半成品档案，保留旧字段供重试。
      profiles.removeWhere((p) => p.id == id);
      activeProfileId = '';
      migrationState = 'legacy-migration-failed';
      await prefs.setString(_kMigrationState, migrationState);
    }
  }

  static String _legacyName(String base) {
    final host = Uri.tryParse(base)?.host ?? '';
    return host.isEmpty ? '当前电脑' : host;
  }

  /// 只读探测目标档案；不改 Api、不激活凭据、不写 descriptor。
  Future<StagedConnectionSwitch> stageSwitch(
    String profileId, {
    bool allowHostChange = false,
    bool allowInsecure = false,
    String? tokenOverride,
  }) async {
    final profile = profiles.where((p) => p.id == profileId).firstOrNull;
    if (profile == null) {
      throw const ConnectionSwitchException('profile-not-found', '连接档案不存在');
    }
    final token = tokenOverride ?? await credentials.readToken(profile.id);
    if (token == null || token.isEmpty) {
      throw const ConnectionSwitchException(
        'credential-missing',
        '该连接的口令不在安全存储中，请重新输入口令',
      );
    }
    _checkTransport(profile, allowInsecure: allowInsecure);
    final base = profile.primaryBase;
    Map<String, dynamic> bootstrap;
    try {
      final probe = Api.forProbe(base, token);
      bootstrap = await (_probeBootstrap?.call(probe) ??
          probe.getJson(
            '/api/bootstrap',
            timeout: const Duration(seconds: 8),
          ));
    } catch (e) {
      throw ConnectionSwitchException('probe-failed', '连接失败：$e');
    }
    final plugin = bootstrap['plugin'];
    final hostId = plugin is Map
        ? (plugin['hostId']?.toString().trim() ?? '')
        : (bootstrap['hostId']?.toString().trim() ?? '');
    final instanceId = plugin is Map
        ? (plugin['instanceId']?.toString().trim() ?? '')
        : '';
    if (profile.hostId.isNotEmpty &&
        hostId.isNotEmpty &&
        profile.hostId != hostId &&
        !allowHostChange) {
      throw ConnectionSwitchException(
        'host-identity-changed',
        '宿主身份已变化：档案记录 ${_short(profile.hostId)}，实际 ${_short(hostId)}',
      );
    }
    return StagedConnectionSwitch(
      profile: profile,
      token: token,
      hostId: hostId.isNotEmpty ? hostId : profile.hostId,
      instanceId: instanceId,
      generation: generation + 1,
      bootstrap: bootstrap,
    );
  }

  void _checkTransport(ConnectionProfile profile, {required bool allowInsecure}) {
    final uri = Uri.tryParse(profile.primaryBase);
    if (uri == null || uri.host.isEmpty) {
      throw const ConnectionSwitchException('invalid-endpoint', '地址无效');
    }
    if (uri.scheme == 'https') return;
    final private = _isPrivateHost(uri.host);
    if (!private) {
      throw const ConnectionSwitchException(
        'https-required',
        '公网地址必须使用 HTTPS；请改用加密地址',
      );
    }
    if (!profile.insecureConfirmed && !allowInsecure) {
      throw const ConnectionSwitchException(
        'http-requires-confirmation',
        '该地址未加密，需要确认后才能发送口令',
      );
    }
  }

  static bool _isPrivateHost(String host) {
    final h = host.toLowerCase();
    if (h == 'localhost' || h.endsWith('.local')) return true;
    final v4 = RegExp(r'^(\d+)\.(\d+)\.(\d+)\.(\d+)$').firstMatch(h);
    if (v4 != null) {
      final a = int.parse(v4.group(1)!);
      final b = int.parse(v4.group(2)!);
      return a == 10 ||
          (a == 172 && b >= 16 && b <= 31) ||
          (a == 192 && b == 168) ||
          a == 127;
    }
    return h.contains(':') && (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd'));
  }

  static String _short(String id) => id.length <= 8 ? id : id.substring(0, 8);

  /// 提交切换：凭据 readback → descriptor → 原生 activate/readback → Api 原子替换。
  /// 任一步失败抛异常；调用方保留旧连接。
  Future<void> commitSwitch(StagedConnectionSwitch stage) async {
    final profile = stage.profile;
    final prefs = await _store;
    final oldDescriptor = prefs.getString(_kNativeDescriptor);
    try {
      await credentials.writeToken(profile.id, stage.token);
      if (await credentials.readToken(profile.id) != stage.token) {
        throw StateError('token-readback-mismatch');
      }
      await _writeNativeDescriptor(profile, stage.hostId, stage.generation);
      await credentials.activate(profile.id);
      final status = await credentials.status();
      if (status.activeProfileId != profile.id || !status.hasToken) {
        throw StateError('native-readback-mismatch');
      }
      final updated = profile.copyWith(
        hostId: stage.hostId,
        lastSeen: DateTime.now().millisecondsSinceEpoch,
      );
      final index = profiles.indexWhere((p) => p.id == profile.id);
      if (index >= 0) profiles[index] = updated;
      activeProfileId = profile.id;
      generation = stage.generation;
      ProfileNamespace.setScope(profileScope);
      await _saveProfiles();
      api.applyConnection(
        base: updated.primaryBase,
        connectionPath: updated.path,
        connectionToken: stage.token,
        profile: updated.id,
        hostIdentity: updated.hostId,
        urls: updated.baseUrls,
      );
      migrationState = 'complete';
    } catch (e) {
      // descriptor/active 可能已部分写入：恢复旧 descriptor，原生按 active 校验会暂停。
      if (oldDescriptor != null) {
        await prefs.setString(_kNativeDescriptor, oldDescriptor);
      } else {
        await prefs.remove(_kNativeDescriptor);
      }
      rethrow;
    }
  }

  Future<void> _writeNativeDescriptor(
    ConnectionProfile profile,
    String hostId,
    int generation,
  ) async {
    final prefs = await _store;
    final descriptor = nativeConnectionDescriptor(
      profile: profile,
      hostId: hostId,
      generation: generation,
    );
    await prefs.setString(_kNativeDescriptor, jsonEncode(descriptor));
  }

  Future<ConnectionProfile> addProfile({
    required String displayName,
    required String baseUrl,
    required String token,
    String path = '/m',
    ProfileTlsPolicy tlsPolicy = ProfileTlsPolicy.https,
    bool insecureConfirmed = false,
    bool switchNow = true,
  }) async {
    final normalized = Api.forProbe(baseUrl, '').baseUrl;
    final profile = ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: displayName.trim().isEmpty ? _legacyName(normalized) : displayName.trim(),
      baseUrls: [normalized],
      path: path,
      tlsPolicy: tlsPolicy,
      insecureConfirmed: insecureConfirmed,
    );
    await credentials.writeToken(profile.id, token);
    if (await credentials.readToken(profile.id) != token) {
      await credentials.deleteToken(profile.id);
      throw const ConnectionSwitchException('credential-write-failed', '口令写入安全存储失败');
    }
    profiles.add(profile);
    await _saveProfiles();
    if (switchNow) {
      final stage = await stageSwitch(
        profile.id,
        allowInsecure: insecureConfirmed,
      );
      await commitSwitch(stage);
    }
    return profile;
  }

  /// 首次配置/重新配置当前连接（ConnectionSheet）。已存在档案时原地更新，不新增副本。
  Future<void> connectManual({
    required String baseUrl,
    required String token,
    bool allowInsecure = false,
  }) async {
    final normalized = Api.forProbe(baseUrl, '').baseUrl;
    final path = Api.forProbe(baseUrl, '').path;
    final secure = normalized.startsWith('https://');
    final current = active;
    if (current == null) {
      await addProfile(
        displayName: _legacyName(normalized),
        baseUrl: normalized,
        token: token,
        path: path,
        tlsPolicy: secure ? ProfileTlsPolicy.https : ProfileTlsPolicy.httpPrivate,
        insecureConfirmed: !secure && allowInsecure,
        switchNow: true,
      );
      return;
    }
    final updated = current.copyWith(
      baseUrls: [normalized],
      path: path,
      tlsPolicy: secure ? ProfileTlsPolicy.https : ProfileTlsPolicy.httpPrivate,
      insecureConfirmed: !secure && allowInsecure,
    );
    // 先按新 token 探测，失败时旧 token/旧档案/Api 完全不动。
    final index = profiles.indexWhere((p) => p.id == current.id);
    if (index >= 0) profiles[index] = updated;
    final stageRepo = await stageSwitch(
      current.id,
      allowInsecure: allowInsecure,
      tokenOverride: token,
    );
    if (index >= 0) profiles[index] = current;
    await credentials.writeToken(current.id, token);
    if (await credentials.readToken(current.id) != token) {
      throw const ConnectionSwitchException('credential-write-failed', '口令写入安全存储失败');
    }
    await updateProfile(updated);
    await commitSwitch(stageRepo);
  }

  /// 地址候选切换（非档案切换）后同步 active 档案，避免重启回到旧地址。
  Future<void> updateActiveBase(String base) async {
    final current = active;
    if (current == null) return;
    final probe = Api.forProbe(base, '');
    final updated = current.copyWith(
      baseUrls: [probe.baseUrl],
      path: probe.path,
    );
    final index = profiles.indexWhere((p) => p.id == current.id);
    if (index >= 0) profiles[index] = updated;
    await _saveProfiles();
    await _writeNativeDescriptor(updated, updated.hostId, generation);
  }

  Future<void> updateProfile(ConnectionProfile profile) async {
    final index = profiles.indexWhere((p) => p.id == profile.id);
    if (index < 0) return;
    profiles[index] = profile;
    await _saveProfiles();
  }

  Future<void> deleteProfile(String profileId) async {
    if (profileId == activeProfileId) {
      throw const ConnectionSwitchException('profile-active', '当前活动连接不能删除');
    }
    profiles.removeWhere((p) => p.id == profileId);
    await credentials.deleteToken(profileId);
    // 清理该档案命名空间缓存（键格式 '<base>.<profileId>:<hostId>'）。
    final prefs = await _store;
    for (final key in prefs.getKeys().toList(growable: false)) {
      if (key.contains(profileId)) await prefs.remove(key);
    }
    await _saveProfiles();
  }
}


/// 生产单例：api 全局单例 + Android Keystore 桥。
final ConnectionManager appConnections = ConnectionManager(
  api: api,
  credentials: MethodChannelCredentialStore(),
);
