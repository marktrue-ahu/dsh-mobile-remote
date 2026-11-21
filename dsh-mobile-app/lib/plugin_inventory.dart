// issue #145：当前宿主插件清单/健康（只读）。事实全部来自宿主 `/api/plugin-inventory`；
// App 不自行推断“已启用/健康/兼容”。旧宿主没有该端点时由 Api 层映射为 unsupported。
import 'l10n.dart';

/// 宿主插件来源（界面只显示 label，不拼接 registry 凭据/路径）。
class PluginSource {
  final String kind;
  final String label;
  const PluginSource({this.kind = 'unknown', this.label = ''});

  factory PluginSource.fromJson(Object? json) {
    if (json is! Map) return const PluginSource();
    return PluginSource(
      kind: (json['kind'] as String?)?.trim() ?? 'unknown',
      label: (json['label'] as String?)?.trim() ?? '',
    );
  }

  String get displayLabel {
    // 已知 kind 一律本地化：后端 label 是中文兜底，不能在 English 模式直接透传。
    return switch (kind) {
      'builtin' => L10n.t('内置', 'Built-in'),
      'local' => L10n.t('本地', 'Local'),
      'git' => 'Git',
      'registry' => L10n.t('配置渠道', 'Configured source'),
      'entry' => L10n.t('配置条目', 'Configured entry'),
      _ => label.isNotEmpty ? label : L10n.t('未知', 'Unknown'),
    };
  }
}

class PluginHealth {
  final String state;
  final String reasonCode;
  const PluginHealth({this.state = 'unknown', this.reasonCode = ''});

  factory PluginHealth.fromJson(Object? json) {
    if (json is! Map) return const PluginHealth();
    return PluginHealth(
      state: (json['state'] as String?)?.trim() ?? 'unknown',
      reasonCode: (json['reasonCode'] as String?)?.trim() ?? '',
    );
  }

  bool get isOk => state == 'ok';
  bool get isFailed => state == 'failed';
  bool get isDisabled => state == 'disabled';
  bool get isStarting => state == 'starting';
  bool get isUnknown => state == 'unknown';

  String get label => switch (state) {
    'ok' => L10n.t('运行中', 'Running'),
    'disabled' => L10n.t('已停用', 'Disabled'),
    'failed' => L10n.t('异常', 'Error'),
    'starting' => L10n.t('启动中', 'Starting'),
    _ => L10n.t('未知', 'Unknown'),
  };

  /// 宿主稳定原因码 → 可读文案；不展示宿主 diagnostic 原文（可能含路径/凭据）。
  String get reasonText {
    switch (reasonCode) {
      case 'management-required':
        return L10n.t('插件管理所需，不能停用或卸载', 'Required for plugin management');
      case 'incompatible-version':
        return L10n.t('与当前 DSH 版本不兼容', 'Incompatible with this DSH version');
      case 'runtime-start-failed':
        return L10n.t('运行期启动失败', 'Failed to start');
      case 'runtime-starting':
        return L10n.t('宿主正在启动该插件', 'The host is starting this plugin');
      case 'runtime-unknown':
        return L10n.t('宿主未提供运行态', 'The host did not report runtime state');
      case 'unsupported-platform':
        return L10n.t('当前平台不支持', 'Unsupported platform');
      case 'operation-error':
        return L10n.t('宿主报告操作异常', 'Host reported an error');
      default:
        return reasonCode.isEmpty
            ? ''
            : L10n.t('宿主报告异常（$reasonCode）', 'Host error ($reasonCode)');
    }
  }
}

class PluginCompatibility {
  /// `ok` / `incompatible` / `unknown`（宿主未给出可判定的兼容事实）。
  final String state;
  final String requirements;
  const PluginCompatibility({this.state = 'unknown', this.requirements = ''});

  factory PluginCompatibility.fromJson(Object? json) {
    if (json is! Map) return const PluginCompatibility();
    final raw = json['state'];
    final state = raw is String && raw.isNotEmpty
        ? raw
        : json['ok'] == true
        ? 'ok'
        : json['ok'] == false
        ? 'incompatible'
        : 'unknown';
    return PluginCompatibility(
      state: state,
      requirements: (json['requirements'] as String?)?.trim() ?? '',
    );
  }

  bool get ok => state == 'ok';
  bool get isIncompatible => state == 'incompatible';
  bool get isUnknown => state == 'unknown';
}

class PluginInfo {
  final String id;
  final String name;
  final Object? title;
  final String packageName;
  final String version;
  final PluginSource source;
  final bool enabled;
  final bool current;
  final PluginHealth health;
  final PluginCompatibility compatibility;
  final String updateKind;
  final bool canUpdate;

  const PluginInfo({
    required this.id,
    required this.name,
    this.title,
    required this.packageName,
    required this.version,
    this.source = const PluginSource(),
    this.enabled = false,
    this.current = false,
    this.health = const PluginHealth(),
    this.compatibility = const PluginCompatibility(),
    this.updateKind = '',
    this.canUpdate = false,
  });

  factory PluginInfo.fromJson(Object? json) {
    if (json is! Map) {
      return const PluginInfo(id: '', name: '', packageName: '', version: '');
    }
    return PluginInfo(
      id: (json['id'] as String?)?.trim() ?? '',
      name: (json['name'] as String?)?.trim() ?? '',
      title: json['title'],
      packageName: (json['packageName'] as String?)?.trim() ?? '',
      version: (json['version'] as String?)?.trim() ?? '',
      source: PluginSource.fromJson(json['source']),
      enabled: json['enabled'] == true,
      current: json['current'] == true,
      health: PluginHealth.fromJson(json['health']),
      compatibility: PluginCompatibility.fromJson(json['compatibility']),
      updateKind: (json['updateKind'] as String?)?.trim() ?? '',
      canUpdate: (json['management'] as Map?)?['canUpdate'] == true,
    );
  }

  String get displayName {
    final t = title;
    if (t is String && t.trim().isNotEmpty) return t.trim();
    if (t is Map) {
      final lang = L10n.lang;
      final value = t[lang] ?? t['zh'] ?? t['en'];
      if (value is String && value.trim().isNotEmpty) return value.trim();
    }
    return name.isNotEmpty ? name : packageName;
  }

  bool get needsAttention => health.isFailed || compatibility.isIncompatible;
}

class PluginInventoryHost {
  final String id;
  final String pluginVersion;
  const PluginInventoryHost({this.id = '', this.pluginVersion = ''});

  factory PluginInventoryHost.fromJson(Object? json) {
    if (json is! Map) return const PluginInventoryHost();
    return PluginInventoryHost(
      id: (json['id'] as String?)?.trim() ?? '',
      pluginVersion: (json['pluginVersion'] as String?)?.trim() ?? '',
    );
  }

  String get shortId => id.length <= 12 ? id : id.substring(0, 12);
}

class PluginInventory {
  final bool supported;

  /// 宿主两侧（bundle 清单 + 运行期 plugin entries）都成功读取才为 true。
  final bool complete;

  /// 部分数据可用，但清单可能缺少独立 plugin entry（不能宣称完整）。
  final bool degraded;
  final String reason;
  final PluginInventoryHost host;
  final List<PluginInfo> plugins;
  final List<PluginInstallable> installable;

  const PluginInventory({
    this.supported = false,
    this.complete = false,
    this.degraded = false,
    this.reason = '',
    this.host = const PluginInventoryHost(),
    this.plugins = const [],
    this.installable = const [],
  });

  factory PluginInventory.fromJson(Object? json) {
    if (json is! Map) return const PluginInventory();
    final plugins = <PluginInfo>[];
    for (final row in (json['plugins'] as List? ?? const [])) {
      plugins.add(PluginInfo.fromJson(row));
    }
    final installable = <PluginInstallable>[];
    for (final row in (json['installable'] as List? ?? const [])) {
      installable.add(PluginInstallable.fromJson(row));
    }
    final supported = json['supported'] == true;
    return PluginInventory(
      supported: supported,
      complete: json.containsKey('complete')
          ? json['complete'] == true
          : supported,
      degraded: json['degraded'] == true,
      reason: (json['reason'] as String?)?.trim() ?? '',
      host: PluginInventoryHost.fromJson(json['host']),
      plugins: plugins,
      installable: installable,
    );
  }

  factory PluginInventory.unsupported(String reason) =>
      PluginInventory(supported: false, reason: reason);

  bool get isPartial => degraded || (supported && !complete);

  int get runningCount =>
      plugins.where((p) => p.enabled && p.health.isOk).length;
  int get attentionCount => plugins.where((p) => p.needsAttention).length;
}

/// #146：宿主配置渠道给出的可安装候选（App 只传 name，spec 由宿主清单决定）。
class PluginInstallable {
  final String id;
  final String name;
  final Object? title;
  final String packageName;
  final String version;
  final PluginSource source;
  final String description;

  const PluginInstallable({
    required this.id,
    required this.name,
    this.title,
    required this.packageName,
    required this.version,
    this.source = const PluginSource(kind: 'registry', label: '配置渠道'),
    this.description = '',
  });

  factory PluginInstallable.fromJson(Object? json) {
    if (json is! Map) {
      return const PluginInstallable(
        id: '',
        name: '',
        packageName: '',
        version: '',
      );
    }
    return PluginInstallable(
      id: (json['id'] as String?)?.trim() ?? '',
      name: (json['name'] as String?)?.trim() ?? '',
      title: json['title'],
      packageName: (json['packageName'] as String?)?.trim() ?? '',
      version: (json['version'] as String?)?.trim() ?? '',
      source: PluginSource.fromJson(json['source']),
      description: (json['description'] as String?)?.trim() ?? '',
    );
  }

  String get displayName {
    final t = title;
    if (t is String && t.trim().isNotEmpty) return t.trim();
    if (t is Map) {
      final value = t[L10n.lang] ?? t['zh'] ?? t['en'];
      if (value is String && value.trim().isNotEmpty) return value.trim();
    }
    return name;
  }
}

/// #146：宿主返回的一个可升级版本。
class PluginVersionInfo {
  final String version;
  final bool prerelease;
  final String deprecated;
  final bool bundle;
  final String incompatibleRequirements;

  const PluginVersionInfo({
    required this.version,
    this.prerelease = false,
    this.deprecated = '',
    this.bundle = true,
    this.incompatibleRequirements = '',
  });

  factory PluginVersionInfo.fromJson(Object? json) {
    if (json is! Map) return const PluginVersionInfo(version: '');
    return PluginVersionInfo(
      version: (json['version'] as String?)?.trim() ?? '',
      prerelease: json['prerelease'] == true,
      deprecated: (json['deprecated'] as String?)?.trim() ?? '',
      bundle: json['bundle'] != false,
      incompatibleRequirements:
          (json['incompatible'] as Map?)?['requirements']?.toString().trim() ??
          '',
    );
  }

  bool get usable =>
      version.isNotEmpty && bundle && incompatibleRequirements.isEmpty;
}

/// #146：检查更新结果。
class PluginVersionCheck {
  final String status; // listed | refused | unknown
  final String problem;
  final String reason;
  final String installedVersion;
  final List<PluginVersionInfo> versions;

  const PluginVersionCheck({
    this.status = 'unknown',
    this.problem = '',
    this.reason = '',
    this.installedVersion = '',
    this.versions = const [],
  });

  factory PluginVersionCheck.fromJson(Object? json) {
    if (json is! Map) return const PluginVersionCheck();
    return PluginVersionCheck(
      status: (json['status'] as String?)?.trim() ?? 'unknown',
      problem: (json['problem'] as String?)?.trim() ?? '',
      reason: (json['reason'] as String?)?.trim() ?? '',
      installedVersion: (json['installedVersion'] as String?)?.trim() ?? '',
      versions: (json['versions'] as List? ?? const [])
          .map(PluginVersionInfo.fromJson)
          .toList(),
    );
  }

  List<PluginVersionInfo> get usableVersions =>
      versions.where((v) => v.usable).toList();
}

class PluginOperationStep {
  final String key;
  final String state;
  const PluginOperationStep({required this.key, required this.state});

  factory PluginOperationStep.fromJson(Object? json) {
    if (json is! Map)
      return const PluginOperationStep(key: '', state: 'pending');
    return PluginOperationStep(
      key: (json['key'] as String?)?.trim() ?? '',
      state: (json['state'] as String?)?.trim() ?? 'pending',
    );
  }
}

/// #146：宿主安装/升级操作快照（由后端轮询宿主事务得到）。
class PluginOperation {
  final String opId;
  final String action; // install | update
  final String name;
  final String targetVersion;
  final String status; // running | succeeded | failed | cancelled
  final String phase;
  final List<PluginOperationStep> steps;
  final String version;
  final String fromVersion;
  final bool restartRequired;
  final bool rolledBack;
  final bool rollbackFailed;
  final bool unchanged;
  final bool outcomeUnknown;
  final bool cancelled;
  final String errorCode;

  const PluginOperation({
    required this.opId,
    required this.action,
    required this.name,
    this.targetVersion = '',
    this.status = 'running',
    this.phase = '',
    this.steps = const [],
    this.version = '',
    this.fromVersion = '',
    this.restartRequired = false,
    this.rolledBack = false,
    this.rollbackFailed = false,
    this.unchanged = false,
    this.outcomeUnknown = false,
    this.cancelled = false,
    this.errorCode = '',
  });

  factory PluginOperation.fromJson(Object? json) {
    if (json is! Map) {
      return const PluginOperation(opId: '', action: '', name: '');
    }
    return PluginOperation(
      opId: (json['opId'] as String?)?.trim() ?? '',
      action: (json['action'] as String?)?.trim() ?? '',
      name: (json['name'] as String?)?.trim() ?? '',
      targetVersion: (json['targetVersion'] as String?)?.trim() ?? '',
      status: (json['status'] as String?)?.trim() ?? 'running',
      phase: (json['phase'] as String?)?.trim() ?? '',
      steps: (json['steps'] as List? ?? const [])
          .map(PluginOperationStep.fromJson)
          .toList(),
      version: (json['version'] as String?)?.trim() ?? '',
      fromVersion: (json['fromVersion'] as String?)?.trim() ?? '',
      restartRequired: json['restartRequired'] == true,
      rolledBack: json['rolledBack'] == true,
      rollbackFailed: json['rollbackFailed'] == true,
      unchanged: json['unchanged'] == true,
      outcomeUnknown: json['outcomeUnknown'] == true,
      cancelled: json['cancelled'] == true,
      errorCode: (json['errorCode'] as String?)?.trim() ?? '',
    );
  }

  bool get running => status == 'running';
  bool get succeeded => status == 'succeeded';
  bool get failed => status == 'failed';
  bool get wasCancelled => status == 'cancelled';
}
