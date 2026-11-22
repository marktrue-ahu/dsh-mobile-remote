// GitLab #152 / ADR 0036：连接档案仓库 + 单活动 staged 切换。
//
// 职责边界：
// - profileId 主键；hostId 只在探测/提交成功后绑定；instanceId 从不参与身份；
// - 切换先对目标档案做只读 bootstrap（旧连接不动），成功后才写凭据/描述符并替换 Api；
// - token 只经 CredentialStore（Android Keystore），Dart prefs 不存明文；
// - 失败保留旧 active/旧 Api/旧 token，不进入半切换状态。
import 'dart:convert';

import 'package:http/http.dart' as http;

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
    this.probeClient,
  }) : _prefs = prefs,
       _probeBootstrap = probeBootstrap;

  final Api api;
  final CredentialStore credentials;
  final Future<Map<String, dynamic>> Function(Api probe)? _probeBootstrap;
  final http.Client? probeClient;
  SharedPreferences? _prefs;

  /// 测试注入：模拟 prefs 写入失败；生产为 null → [_saveProfiles]。
  Future<void> Function()? persistOverride;

  /// 测试注入：暂停 active base 提交，构造与档案切换的确定性交错。
  Future<void> Function()? activeBaseGate;

  Future<void> _transactionTail = Future<void>.value();

  Future<T> _serialized<T>(Future<T> Function() action) {
    final run = _transactionTail.then((_) => action());
    _transactionTail = run.then<void>((_) {}, onError: (_, __) {});
    return run;
  }

  /// 启动校验失败时给 UI 的明确原因；不把 token 套到错误 endpoint。
  String connectionStateError = '';

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
    return ProfileNamespace.scopeFor(p.id, p.hostId);
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
    // #152 P1：启动必须核对 persisted active / Keystore active / descriptor / token
    // 四者一致；任一不匹配即 fail-closed，绝不把 B 的 token 套到 A 的 endpoint。
    try {
      final status = await credentials.status();
      final descriptor = _readNativeDescriptor(prefs);
      final expectedGeneration = prefs.getInt(_kGeneration) ?? 0;
      final reason = _startupMismatchReason(
        profile: current,
        persistedActive: activeProfileId,
        credentialActive: status.activeProfileId,
        hasToken: status.hasToken,
        descriptor: descriptor,
        persistedGeneration: expectedGeneration,
      );
      if (reason != null) {
        connectionStateError = reason;
        migrationState = 'connection-state-mismatch';
        api.token = '';
        return;
      }
      // 只显式读 current.id 的 token；不再 readActiveToken() 盲套。
      final token = await credentials.readToken(current.id);
      if (token == null || token.isEmpty) {
        migrationState = 'credential-missing';
        connectionStateError = '该连接的凭据不可读，请重新输入口令';
        api.token = '';
        return;
      }
      ProfileNamespace.setScope(profileScope);
      api.applyConnection(
        base: current.primaryBase,
        connectionPath: current.path,
        connectionToken: token,
        profile: current.id,
        hostIdentity: current.hostId,
        urls: current.baseUrls,
      );
      migrationState = 'complete';
      connectionStateError = '';
      _installCandidateGuards();
    } catch (e) {
      migrationState = 'credential-unavailable';
      connectionStateError = '无法读取安全凭据，请重新输入口令';
      api.token = '';
    }
  }

  Map<String, dynamic>? _readNativeDescriptor(SharedPreferences prefs) {
    final raw = prefs.getString(_kNativeDescriptor);
    if (raw == null || raw.isEmpty) return null;
    try {
      final value = jsonDecode(raw);
      return value is Map ? Map<String, dynamic>.from(value) : null;
    } catch (_) {
      return null;
    }
  }

  String? _startupMismatchReason({
    required ConnectionProfile profile,
    required String persistedActive,
    required String credentialActive,
    required bool hasToken,
    required Map<String, dynamic>? descriptor,
    required int persistedGeneration,
  }) {
    if (persistedActive != profile.id) return '活动档案记录不一致';
    if (credentialActive != profile.id) return '安全存储的活动档案与设置不一致';
    if (!hasToken) return '活动凭据缺失';
    if (descriptor == null) return '原生连接描述符缺失';
    if (descriptor['profileId'] != profile.id) return '原生连接描述符指向其他档案';
    if (descriptor['baseUrl'] != profile.primaryBase) return '原生连接地址与档案不一致';
    if (descriptor['path'] != profile.path) return '原生连接路径与档案不一致';
    if (generation != persistedGeneration) return '连接代记录不一致';
    if (descriptor['generation'] != persistedGeneration) return '原生连接代不一致';
    final descriptorHost = descriptor['hostId']?.toString() ?? '';
    if (descriptorHost.isNotEmpty &&
        profile.hostId.isNotEmpty &&
        descriptorHost != profile.hostId) {
      return '原生宿主身份与档案不一致';
    }
    return null;
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
      connectionStateError = '旧连接信息不完整；旧口令仍保留，可重试迁移或重新输入';
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
      connectionStateError = '迁移安全凭据失败；旧口令仍保留，可重试迁移';
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
      // base 已被 _normBase 去掉路径；必须把 profile.path 拼回 probe，
      // 否则自定义挂载（如 /mobile-remote）会错误探测 /m。
      final probe = Api.forProbe(
        '$base${profile.path == '/' ? '' : profile.path}',
        token,
        client: probeClient,
      );
      bootstrap = await (_probeBootstrap?.call(probe) ??
          probe.getJson(
            '/api/bootstrap',
            timeout: const Duration(seconds: 8),
          ));
    } catch (e) {
      throw ConnectionSwitchException('probe-failed', '连接失败：$e');
    }
    final plugin = bootstrap['plugin'];
    final reportedHostId = plugin is Map
        ? (plugin['hostId']?.toString().trim() ?? '')
        : (bootstrap['hostId']?.toString().trim() ?? '');
    final instanceId = plugin is Map
        ? (plugin['instanceId']?.toString().trim() ?? '')
        : '';
    final uri = Uri.tryParse(base);
    final legacyIdentity = 'legacy:${uri?.origin ?? base}';
    String resolvedHostId;
    if (reportedHostId.isEmpty) {
      // 空/缺失 hostId 不等于匹配。已绑定真实身份的档案必须显式确认，
      // 且确认后使用**隔离身份**，绝不沿用 A 的 hostId/缓存。
      final alreadyLegacy = profile.hostId.startsWith('legacy:');
      if (profile.hostId.isEmpty) {
        resolvedHostId = legacyIdentity;
      } else if (alreadyLegacy) {
        if (profile.hostId != legacyIdentity && !allowHostChange) {
          throw ConnectionSwitchException(
            'host-identity-missing',
            '目标未提供宿主身份，且与旧降级身份不一致；确认后将使用隔离身份（不继承旧缓存）',
          );
        }
        resolvedHostId = legacyIdentity;
      } else if (allowHostChange) {
        resolvedHostId = legacyIdentity;
      } else {
        throw const ConnectionSwitchException(
          'host-identity-missing',
          '目标未提供宿主身份；未确认前不会沿用旧宿主的身份或缓存（hostId 不是认证/TLS 证明）',
        );
      }
    } else if (profile.hostId.isNotEmpty &&
        profile.hostId != reportedHostId &&
        !allowHostChange) {
      throw ConnectionSwitchException(
        'host-identity-changed',
        '宿主身份已变化：档案记录 ${_short(profile.hostId)}，实际 ${_short(reportedHostId)}',
      );
    } else {
      resolvedHostId = reportedHostId;
    }
    return StagedConnectionSwitch(
      profile: profile,
      token: token,
      hostId: resolvedHostId,
      instanceId: instanceId,
      generation: generation + 1,
      bootstrap: bootstrap,
    );
  }

  /// 统一 URL/传输策略；**不携带 token、不发请求**，供 UI 预检与 probe 前共享。
  static void validateEndpoint(
    String baseUrl, {
    bool insecureConfirmed = false,
    bool allowInsecure = false,
  }) {
    final uri = Uri.tryParse(baseUrl.trim());
    if (uri == null || uri.host.isEmpty) {
      throw const ConnectionSwitchException('invalid-endpoint', '地址无效');
    }
    if (uri.scheme == 'https') return;
    if (!_isPrivateHost(uri.host)) {
      throw const ConnectionSwitchException(
        'https-required',
        '公网地址必须使用 HTTPS；请改用加密地址',
      );
    }
    if (!insecureConfirmed && !allowInsecure) {
      throw const ConnectionSwitchException(
        'http-requires-confirmation',
        '该地址未加密，需要确认后才能发送口令',
      );
    }
  }

  void _checkTransport(ConnectionProfile profile, {required bool allowInsecure}) {
    validateEndpoint(
      profile.primaryBase,
      insecureConfirmed: profile.insecureConfirmed,
      allowInsecure: allowInsecure,
    );
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

  /// 提交切换：凭据 readback → descriptor → 原生 activate/readback → profiles → Api。
  ///
  /// 可恢复事务：任一步失败都回滚 target token、Keystore active、descriptor、
  /// profiles/activeProfileId/generation/ProfileNamespace；不允许留下
  /// “descriptor A + native token B”或“current A + token B”。
  Future<void> commitSwitch(StagedConnectionSwitch stage) =>
      _serialized(() => _commitSwitchUnlocked(stage));

  Future<void> _commitSwitchUnlocked(StagedConnectionSwitch stage) async {
    final profile = stage.profile;
    final prefs = await _store;
    final oldDescriptor = prefs.getString(_kNativeDescriptor);
    final oldProfiles = List<ConnectionProfile>.of(profiles);
    final oldActive = activeProfileId;
    final oldGeneration = generation;
    final oldScope = ProfileNamespace.scope;
    final index = profiles.indexWhere((p) => p.id == profile.id);
    final oldHostId = index >= 0 ? profiles[index].hostId : '';
    final oldToken = await credentials.readToken(profile.id);
    var applied = false;
    var credentialsMutated = false;
    try {
      await credentials.writeToken(profile.id, stage.token);
      credentialsMutated = true;
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
      if (index >= 0) {
        profiles[index] = updated;
      } else {
        profiles.add(updated);
      }
      activeProfileId = profile.id;
      generation = stage.generation;
      // 先失效旧 Api/SSE 代（旧帧不再通过门禁），再持久化，最后才切全局通知 scope；
      // 防止 A 的迟到事件在窗口内被按 B scope 入队。
      api.applyConnection(
        base: updated.primaryBase,
        connectionPath: updated.path,
        connectionToken: stage.token,
        profile: updated.id,
        hostIdentity: updated.hostId,
        urls: updated.baseUrls,
      );
      applied = true;
      await (persistOverride ?? _saveProfiles)();
      // 首次绑定 hostId：旧缓存 key 从 `profileId:` 迁到 `profileId:hostId`，
      // 否则原档案历史会话/工作区/草稿在新 scope 下不可见。
      if (oldHostId.isEmpty && stage.hostId.isNotEmpty) {
        await _migrateScopedPrefs('${profile.id}:', profileScope);
      }
      ProfileNamespace.setScope(profileScope);
      migrationState = 'complete';
      connectionStateError = '';
      _installCandidateGuards();
    } catch (e) {
      // 1) 先恢复 target 的旧 token（若 target 就是旧 active，也恢复旧 token）。
      if (credentialsMutated) {
        try {
          if (oldToken == null || oldToken.isEmpty) {
            await credentials.deleteToken(profile.id);
          } else {
            await credentials.writeToken(profile.id, oldToken);
          }
        } catch (_) {}
      }
      // 2) 恢复 Keystore active（旧 active 的 token 必须仍可读；否则 deactivate）。
      var activeRestored = false;
      try {
        if (oldActive.isNotEmpty &&
            await credentials.readToken(oldActive) != null) {
          await credentials.activate(oldActive);
          final status = await credentials.status();
          activeRestored =
              status.activeProfileId == oldActive && status.hasToken;
        } else {
          await credentials.deactivate();
          activeRestored = true;
        }
      } catch (_) {
        activeRestored = false;
      }
      // 3) 恢复 descriptor 与 Dart 内存/持久状态。
      try {
        if (oldDescriptor != null) {
          await prefs.setString(_kNativeDescriptor, oldDescriptor);
        } else {
          await prefs.remove(_kNativeDescriptor);
        }
      } catch (_) {}
      profiles
        ..clear()
        ..addAll(oldProfiles);
      activeProfileId = oldActive;
      generation = oldGeneration;
      ProfileNamespace.setScope(oldScope);
      try {
        await _saveProfiles();
      } catch (_) {}
      if (!activeRestored) {
        // 无法恢复一致状态：fail-closed，不允许继续用旧 Api 发请求。
        api.token = '';
        connectionStateError = '切换失败且无法恢复安全凭据，请重新输入口令';
        migrationState = 'switch-rollback-failed';
        throw const ConnectionSwitchException(
          'switch-rollback-failed',
          '切换失败且无法恢复安全凭据，请重新输入口令',
        );
      }
      connectionStateError = '切换失败，已保留原连接';
      // 未提交 Api 时旧 Api 保持不变；若 Api 已被替换（理论上 apply 不抛），
      // 用旧档案重新应用一次，保证“current A + token A”。
      if (applied) {
        final restored = profiles.where((p) => p.id == oldActive).firstOrNull;
        final restoredToken = oldActive.isEmpty
            ? null
            : await credentials.readToken(oldActive);
        if (restored == null || restoredToken == null) {
          api.token = '';
        } else {
          api.applyConnection(
            base: restored.primaryBase,
            connectionPath: restored.path,
            connectionToken: restoredToken,
            profile: restored.id,
            hostIdentity: restored.hostId,
            urls: restored.baseUrls,
          );
        }
      }
      rethrow;
    }
  }

  void _installCandidateGuards() {
    api.candidateAdmission = (candidate) {
      final current = active;
      if (current == null) return false;
      final normalized = Api.forProbe(candidate, '').baseUrl;
      return current.baseUrls.any(
        (value) => Api.forProbe(value, '').baseUrl == normalized,
      );
    };
    api.candidateVerifier = verifyCandidate;
    api.candidateCommitter = commitActiveBase;
  }

  /// 同 host 的已确认候选轮换：原子更新 active profile base + generation + descriptor，
  /// 再通知原生重建；失败回滚档案/descriptor/generation，不返回成功。
  Future<bool> commitActiveBase(String base) =>
      _serialized(() => _commitActiveBaseUnlocked(base));

  Future<bool> _commitActiveBaseUnlocked(String base) async {
    final current = active;
    if (current == null) return false;
    final normalized = Api.forProbe(base, '').baseUrl;
    final prefs = await _store;
    final oldDescriptor = prefs.getString(_kNativeDescriptor);
    final oldProfile = current;
    final oldGeneration = generation;
    final index = profiles.indexWhere((p) => p.id == current.id);
    final urls = <String>[
      normalized,
      for (final value in current.baseUrls)
        if (Api.forProbe(value, '').baseUrl != normalized) value,
    ];
    final updated = current.copyWith(baseUrls: urls);
    try {
      if (index >= 0) profiles[index] = updated;
      generation = generation + 1;
      await _writeNativeDescriptor(updated, updated.hostId, generation);
      await activeBaseGate?.call();
      await _saveProfiles();
      await credentials.refreshNative();
      return true;
    } catch (_) {
      if (index >= 0) profiles[index] = oldProfile;
      generation = oldGeneration;
      try {
        if (oldDescriptor != null) {
          await prefs.setString(_kNativeDescriptor, oldDescriptor);
        } else {
          await prefs.remove(_kNativeDescriptor);
        }
        await _saveProfiles();
      } catch (_) {}
      return false;
    }
  }

  /// 自动轮换候选：必须是档案已确认地址 + 传输策略允许 + hostId 与绑定身份一致。
  Future<bool> verifyCandidate(String candidate) async {
    final current = active;
    if (current == null) return false;
    final normalized = Api.forProbe(candidate, '').baseUrl;
    if (!current.baseUrls.any((value) => Api.forProbe(value, '').baseUrl == normalized)) {
      return false;
    }
    try {
      validateEndpoint(candidate, insecureConfirmed: current.insecureConfirmed);
    } catch (_) {
      return false;
    }
    if (current.hostId.isEmpty) return false;
    final token = await credentials.readToken(current.id);
    if (token == null || token.isEmpty) return false;
    try {
      final probe = Api.forProbe(
        '$normalized${current.path == '/' ? '' : current.path}',
        token,
        client: probeClient,
      );
      final bootstrap = await probe.getJson(
        '/api/bootstrap',
        timeout: const Duration(seconds: 6),
      );
      final plugin = bootstrap['plugin'];
      final hostId = plugin is Map
          ? (plugin['hostId']?.toString().trim() ?? '')
          : (bootstrap['hostId']?.toString().trim() ?? '');
      return hostId.isNotEmpty && hostId == current.hostId;
    } catch (_) {
      return false;
    }
  }

  Future<void> _migrateScopedPrefs(String oldScope, String newScope) async {
    if (oldScope == newScope) return;
    final prefs = await _store;
    final moves = <String, String>{};
    for (final key in prefs.getKeys().toList(growable: false)) {
      for (final sep in const ['.', '@']) {
        final marker = '$sep$oldScope';
        if (!key.endsWith(marker)) continue;
        final migrated =
            '${key.substring(0, key.length - marker.length)}$sep$newScope';
        if (prefs.get(migrated) != null) continue;
        final value = prefs.get(key);
        if (value == null) continue;
        if (value is String) {
          await prefs.setString(migrated, value);
        } else if (value is bool) {
          await prefs.setBool(migrated, value);
        } else if (value is int) {
          await prefs.setInt(migrated, value);
        } else if (value is double) {
          await prefs.setDouble(migrated, value);
        } else if (value is List<String>) {
          await prefs.setStringList(migrated, value);
        } else {
          continue;
        }
        // 复制并回读成功后才删除旧 key。
        if (prefs.get(migrated) == value) moves[key] = migrated;
      }
    }
    for (final oldKey in moves.keys) {
      await prefs.remove(oldKey);
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
    bool switchNow = false,
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
      final created = await addProfile(
        displayName: _legacyName(normalized),
        baseUrl: normalized,
        token: token,
        path: path,
        tlsPolicy: secure ? ProfileTlsPolicy.https : ProfileTlsPolicy.httpPrivate,
        insecureConfirmed: !secure && allowInsecure,
        switchNow: false,
      );
      final staged = await stageSwitch(
        created.id,
        allowInsecure: allowInsecure,
        tokenOverride: token,
      );
      await commitSwitch(staged);
      return;
    }
    final updated = current.copyWith(
      baseUrls: [normalized],
      path: path,
      tlsPolicy: secure ? ProfileTlsPolicy.https : ProfileTlsPolicy.httpPrivate,
      insecureConfirmed: !secure && allowInsecure,
    );
    // 先按新 token 探测，失败时旧档案/Api/token 完全不动；临时副本必须 finally 还原。
    final index = profiles.indexWhere((p) => p.id == current.id);
    final StagedConnectionSwitch staged;
    try {
      if (index >= 0) profiles[index] = updated;
      staged = await stageSwitch(
        current.id,
        allowInsecure: allowInsecure,
        tokenOverride: token,
      );
    } finally {
      if (index >= 0) profiles[index] = current;
    }
    // token/profile 的持久化与回滚统一交给 commitSwitch，失败不覆盖旧 token。
    await commitSwitch(staged);
  }

  /// 地址候选切换（非档案切换）后同步 active 档案，避免重启回到旧地址。
  Future<void> updateActiveBase(String base) async {
    await commitActiveBase(base);
  }

  /// 编辑现有档案 endpoint/token：临时副本探测/提交，失败保留旧档案/旧 token/旧缓存身份。
  Future<void> editProfile(
    ConnectionProfile oldProfile, {
    required String baseUrl,
    String? token,
    String? displayName,
    bool allowInsecure = false,
  }) async {
    final normalized = Api.forProbe(baseUrl, '').baseUrl;
    final path = Api.forProbe(baseUrl, '').path;
    final secure = normalized.startsWith('https://');
    final tokenValue = (token == null || token.isEmpty)
        ? await credentials.readToken(oldProfile.id)
        : token;
    if (tokenValue == null || tokenValue.isEmpty) {
      throw const ConnectionSwitchException('credential-missing', '该连接的口令不可读，请重新输入');
    }
    final updated = oldProfile.copyWith(
      displayName: (displayName ?? '').trim().isEmpty
          ? oldProfile.displayName
          : displayName!.trim(),
      baseUrls: [normalized],
      path: path,
      tlsPolicy: secure ? ProfileTlsPolicy.https : ProfileTlsPolicy.httpPrivate,
      insecureConfirmed: !secure && allowInsecure,
    );
    final index = profiles.indexWhere((p) => p.id == oldProfile.id);
    final StagedConnectionSwitch staged;
    try {
      if (index >= 0) profiles[index] = updated;
      staged = await stageSwitch(
        oldProfile.id,
        allowInsecure: allowInsecure,
        tokenOverride: tokenValue,
      );
    } finally {
      if (index >= 0) profiles[index] = oldProfile;
    }
    await commitSwitch(staged);
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
