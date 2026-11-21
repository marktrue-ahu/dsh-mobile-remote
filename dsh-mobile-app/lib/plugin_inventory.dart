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

  const PluginInventory({
    this.supported = false,
    this.complete = false,
    this.degraded = false,
    this.reason = '',
    this.host = const PluginInventoryHost(),
    this.plugins = const [],
  });

  factory PluginInventory.fromJson(Object? json) {
    if (json is! Map) return const PluginInventory();
    final plugins = <PluginInfo>[];
    for (final row in (json['plugins'] as List? ?? const [])) {
      plugins.add(PluginInfo.fromJson(row));
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
    );
  }

  factory PluginInventory.unsupported(String reason) =>
      PluginInventory(supported: false, reason: reason);

  bool get isPartial => degraded || (supported && !complete);

  int get runningCount =>
      plugins.where((p) => p.enabled && p.health.isOk).length;
  int get attentionCount => plugins.where((p) => p.needsAttention).length;
}
