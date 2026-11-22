// GitLab #152 / ADR 0036：连接档案模型。
//
// profileId 是本地稳定主键；hostId 是连接成功后绑定的宿主身份；
// instanceId 只表示宿主本次运行，不参与身份判定。token 永不进入本模型/JSON。
import 'dart:math';

enum ProfileTlsPolicy { https, httpPrivate }

ProfileTlsPolicy tlsPolicyOf(Object? raw, {required bool insecure}) {
  if (raw == 'http-private' || insecure) return ProfileTlsPolicy.httpPrivate;
  return ProfileTlsPolicy.https;
}

class ConnectionProfile {
  ConnectionProfile({
    required this.id,
    required this.displayName,
    required this.baseUrls,
    this.path = '/m',
    this.hostId = '',
    this.lastSeen = 0,
    this.lastAppVersion = '',
    this.lastPluginVersion = '',
    this.tlsPolicy = ProfileTlsPolicy.https,
    this.insecureConfirmed = false,
  });

  final String id;
  String displayName;

  /// 同一档案的地址候选（LAN/Tailscale）；绝不跨档案合并。
  List<String> baseUrls;
  String path;
  String hostId;
  int lastSeen;
  String lastAppVersion;
  String lastPluginVersion;
  ProfileTlsPolicy tlsPolicy;

  /// 私网 HTTP 风险已由用户显式确认。false 时切换必须重新确认。
  bool insecureConfirmed;

  String get primaryBase => baseUrls.isEmpty ? '' : baseUrls.first;

  ConnectionProfile copyWith({
    String? displayName,
    List<String>? baseUrls,
    String? path,
    String? hostId,
    int? lastSeen,
    String? lastAppVersion,
    String? lastPluginVersion,
    ProfileTlsPolicy? tlsPolicy,
    bool? insecureConfirmed,
  }) => ConnectionProfile(
    id: id,
    displayName: displayName ?? this.displayName,
    baseUrls: baseUrls ?? List.of(this.baseUrls),
    path: path ?? this.path,
    hostId: hostId ?? this.hostId,
    lastSeen: lastSeen ?? this.lastSeen,
    lastAppVersion: lastAppVersion ?? this.lastAppVersion,
    lastPluginVersion: lastPluginVersion ?? this.lastPluginVersion,
    tlsPolicy: tlsPolicy ?? this.tlsPolicy,
    insecureConfirmed: insecureConfirmed ?? this.insecureConfirmed,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'displayName': displayName,
    'baseUrls': baseUrls,
    'path': path,
    'hostId': hostId,
    'lastSeen': lastSeen,
    'lastAppVersion': lastAppVersion,
    'lastPluginVersion': lastPluginVersion,
    'tlsPolicy': tlsPolicy.name,
    'insecureConfirmed': insecureConfirmed,
  };

  static ConnectionProfile? fromJson(Object? value) {
    if (value is! Map) return null;
    final id = value['id'];
    final name = value['displayName'];
    final urls = value['baseUrls'];
    if (id is! String || id.isEmpty || name is! String || urls is! List) {
      return null;
    }
    final bases = urls
        .whereType<String>()
        .map((u) => u.trim())
        .where((u) => u.isNotEmpty)
        .toList();
    if (bases.isEmpty) return null;
    return ConnectionProfile(
      id: id,
      displayName: name.trim().isEmpty ? id : name.trim(),
      baseUrls: bases,
      path: value['path'] is String && (value['path'] as String).isNotEmpty
          ? value['path'] as String
          : '/m',
      hostId: value['hostId'] is String ? (value['hostId'] as String).trim() : '',
      lastSeen: value['lastSeen'] is int ? value['lastSeen'] as int : 0,
      lastAppVersion: value['lastAppVersion'] is String
          ? value['lastAppVersion'] as String
          : '',
      lastPluginVersion: value['lastPluginVersion'] is String
          ? value['lastPluginVersion'] as String
          : '',
      tlsPolicy: tlsPolicyOf(
        value['tlsPolicy'],
        insecure: value['insecureConfirmed'] == true,
      ),
      insecureConfirmed: value['insecureConfirmed'] == true,
    );
  }

  static String newId() {
    final r = Random.secure();
    final bytes = List<int>.generate(16, (_) => r.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
        '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
  }
}

/// 单活动切换的暂存结果：只读探测成功后才可能提交。
class StagedConnectionSwitch {
  const StagedConnectionSwitch({
    required this.profile,
    required this.token,
    required this.hostId,
    required this.instanceId,
    required this.generation,
    required this.bootstrap,
  });

  final ConnectionProfile profile;
  final String token;
  final String hostId;
  final String instanceId;
  final int generation;
  final Map<String, dynamic> bootstrap;
}

class ConnectionSwitchException implements Exception {
  const ConnectionSwitchException(this.code, this.message);
  final String code;
  final String message;

  @override
  String toString() => message;
}
