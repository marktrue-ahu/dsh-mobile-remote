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

/// #153：插件分类（内置 / 实验性 / 自定义 / 未分类）。
///
/// **事实来自宿主**（`plugins[].category`），App 只渲染，不重算：
/// 分类谓词与 `EXPERIMENTAL_BUNDLES` 静态表都在插件宿主侧（`lib/experimental-bundles.js`），
/// 因为 App 拿不到当前 DSH 版本，重算必然与宿主漂移。
class PluginCategory {
  /// `builtin` / `experimental` / `custom` / `unclassified`。
  final String kind;
  final String label;

  /// 稳定原因码：`host-facts-missing` / `independent-entry`；正常分类为空串。
  final String reason;
  const PluginCategory({
    this.kind = 'unclassified',
    this.label = '',
    this.reason = '',
  });

  factory PluginCategory.fromJson(Object? json) {
    if (json is! Map) return const PluginCategory();
    final kind = (json['kind'] as String?)?.trim() ?? '';
    return PluginCategory(
      kind: kind.isEmpty ? 'unclassified' : kind,
      label: (json['label'] as String?)?.trim() ?? '',
      reason: (json['reason'] as String?)?.trim() ?? '',
    );
  }

  bool get isBuiltin => kind == 'builtin';
  bool get isExperimental => kind == 'experimental';
  bool get isCustom => kind == 'custom';
  bool get isUnclassified => kind == 'unclassified';

  /// 分类展示名一律本地化；宿主 `label` 只是中文兜底。
  String get displayLabel => switch (kind) {
    'builtin' => L10n.t('内置', 'Built-in'),
    'experimental' => L10n.t('实验性', 'Experimental'),
    'custom' => L10n.t('自定义', 'Custom'),
    _ => L10n.t('已安装（未分类）', 'Installed (unclassified)'),
  };

  /// 降级原因的可读说明；正常分类为空串。
  String get reasonText => switch (reason) {
    'host-facts-missing' => L10n.t(
      '当前电脑端未提供分类字段',
      'This desktop does not report classification',
    ),
    'independent-entry' => L10n.t(
      '这是配置条目，不是 bundle',
      'This is a configured entry, not a bundle',
    ),
    _ => '',
  };
}

/// #153：宿主根级分类表对账（`classification`）。
///
/// `matched === false` 表示静态表未覆盖当前 DSH 版本：页面显示提示，但**仍按分类展示**
/// （用户已裁决），不把行挪 Tab、不重算。
class PluginClassification {
  final String tableVersion;
  final String targetDsh;
  final String dshVersion;
  final bool matched;
  final String source;
  const PluginClassification({
    this.tableVersion = '',
    this.targetDsh = '',
    this.dshVersion = '',
    this.matched = false,
    this.source = '',
  });

  factory PluginClassification.fromJson(Object? json) {
    if (json is! Map) return const PluginClassification();
    return PluginClassification(
      tableVersion: (json['tableVersion'] as String?)?.trim() ?? '',
      targetDsh: (json['targetDsh'] as String?)?.trim() ?? '',
      dshVersion: (json['dshVersion'] as String?)?.trim() ?? '',
      matched: json['matched'] == true,
      source: (json['source'] as String?)?.trim() ?? '',
    );
  }

  /// 宿主是否下发了这张表对账（旧宿主没有该字段 → false，走扁平降级）。
  bool get present => tableVersion.isNotEmpty || targetDsh.isNotEmpty;
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
  final bool canUninstall;
  final bool canToggle;
  final String toggleReasonCode;

  /// #153：宿主下发的分类事实与 HIDDEN 标记。旧宿主缺字段时 `category` 为 unclassified、
  /// `hasCategory === false`，页面走扁平列表降级。
  final PluginCategory category;
  final bool hasCategory;
  final bool hidden;

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
    this.canUninstall = false,
    this.canToggle = false,
    this.toggleReasonCode = '',
    this.category = const PluginCategory(),
    this.hasCategory = false,
    this.hidden = false,
  });

  factory PluginInfo.fromJson(Object? json) {
    if (json is! Map) {
      return const PluginInfo(id: '', name: '', packageName: '', version: '');
    }
    final rawCategory = json['category'];
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
      canUninstall: (json['management'] as Map?)?['canUninstall'] == true,
      canToggle: (json['management'] as Map?)?['canToggle'] == true,
      toggleReasonCode:
          (json['management'] as Map?)?['toggleReasonCode']
              ?.toString()
              .trim() ??
          '',
      category: PluginCategory.fromJson(rawCategory),
      hasCategory: rawCategory is Map,
      hidden: json['hidden'] == true,
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
  final bool restartSupported;
  const PluginInventoryHost({
    this.id = '',
    this.pluginVersion = '',
    this.restartSupported = false,
  });

  factory PluginInventoryHost.fromJson(Object? json) {
    if (json is! Map) return const PluginInventoryHost();
    return PluginInventoryHost(
      id: (json['id'] as String?)?.trim() ?? '',
      pluginVersion: (json['pluginVersion'] as String?)?.trim() ?? '',
      restartSupported: json['restartSupported'] == true,
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

  /// #153：分类表对账（旧宿主缺字段 → `present == false`）。
  final PluginClassification classification;

  const PluginInventory({
    this.supported = false,
    this.complete = false,
    this.degraded = false,
    this.reason = '',
    this.host = const PluginInventoryHost(),
    this.plugins = const [],
    this.installable = const [],
    this.classification = const PluginClassification(),
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
      classification: PluginClassification.fromJson(json['classification']),
    );
  }

  factory PluginInventory.unsupported(String reason) =>
      PluginInventory(supported: false, reason: reason);

  bool get isPartial => degraded || (supported && !complete);

  /// #153：能否展示三 Tab。要求**每一行**都带 `category`（旧宿主/部分缺失 → 扁平降级）。
  ///
  /// 空清单不算“分类可用”（没有行可分类时三 Tab 无意义，仍走原列表，避免出现
  /// 三个空 Tab 让人以为清单丢了）。
  bool get hasCategories =>
      supported && plugins.isNotEmpty && plugins.every((p) => p.hasCategory);

  /// 需要提示“分类表与当前 DSH 版本不匹配”，但不改判分类。
  bool get classificationMismatch =>
      hasCategories && classification.present && !classification.matched;

  int get runningCount =>
      plugins.where((p) => p.enabled && p.health.isOk).length;
  int get attentionCount => plugins.where((p) => p.needsAttention).length;

  /// 默认（不外显隐藏项）的插件行。
  List<PluginInfo> visiblePlugins({required bool showHidden}) =>
      showHidden ? plugins : plugins.where((p) => !p.hidden).toList();

  /// 某分类下默认可见的已安装行。
  List<PluginInfo> pluginsFor(String kind, {required bool showHidden}) =>
      visiblePlugins(
        showHidden: showHidden,
      ).where((p) => p.category.kind == kind).toList();

  /// 某分类下的可安装候选。
  List<PluginInstallable> installableFor(
    String kind, {
    required bool showHidden,
  }) => installable
      .where((i) => showHidden || !i.hidden)
      .where((i) => i.category.kind == kind)
      .toList();
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

  /// #153：宿主下发的分类事实与 HIDDEN 标记（旧宿主缺字段 → 默认 unclassified）。
  final PluginCategory category;

  /// 宿主这一行是否真的下发了 `category`（缺失 → 走扁平降级，不猜分类）。
  final bool hasCategory;
  final bool hidden;

  const PluginInstallable({
    required this.id,
    required this.name,
    this.title,
    required this.packageName,
    required this.version,
    this.source = const PluginSource(kind: 'registry', label: '配置渠道'),
    this.description = '',
    this.category = const PluginCategory(),
    this.hasCategory = false,
    this.hidden = false,
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
      category: PluginCategory.fromJson(json['category']),
      hasCategory: json['category'] is Map,
      hidden: json['hidden'] == true,
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

/// #153：一次 registry 询问的归因（哪个源、遇到什么问题）。
class PluginRegistryAttempt {
  final String registry;
  final String problem;
  const PluginRegistryAttempt({this.registry = '', this.problem = ''});

  factory PluginRegistryAttempt.fromJson(Object? json) {
    if (json is! Map) return const PluginRegistryAttempt();
    return PluginRegistryAttempt(
      registry: (json['registry'] as String?)?.trim() ?? '',
      problem: (json['problem'] as String?)?.trim() ?? '',
    );
  }
}

/// #146：检查更新结果。
///
/// #153：新增逐项源归因（`requestedRegistry` / `answeredRegistry` / `attempts`）：
/// 页面能说明“这次问的是哪个源、是哪个源答的”，不静默换源。
class PluginVersionCheck {
  final String status; // listed | refused | unknown
  final String problem;
  final String reason;
  final String installedVersion;
  final List<PluginVersionInfo> versions;
  final String requestedRegistry;
  final String answeredRegistry;
  final List<PluginRegistryAttempt> attempts;

  const PluginVersionCheck({
    this.status = 'unknown',
    this.problem = '',
    this.reason = '',
    this.installedVersion = '',
    this.versions = const [],
    this.requestedRegistry = '',
    this.answeredRegistry = '',
    this.attempts = const [],
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
      requestedRegistry:
          (json['requestedRegistry'] as String?)?.trim() ?? '',
      answeredRegistry: (json['answeredRegistry'] as String?)?.trim() ?? '',
      attempts: (json['attempts'] as List? ?? const [])
          .map(PluginRegistryAttempt.fromJson)
          .toList(),
    );
  }

  bool get listed => status == 'listed';

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

  /// #153：本次操作问过的源与“是哪个源答的”（卸载/启停恒为空/null）。
  final List<String> registries;
  final int attemptIndex;
  final int attemptTotal;
  final String answeredRegistry;

  /// issue #175 P2：`name` = 从宿主配置渠道装（#153 路径）；
  /// `spec` = 用户手动指定的任意 spec。旧宿主无该字段 → 按 `name` 处理。
  final String installSource;

  /// issue #175 P2：pnpm 拦下的安装脚本包名（**只有名字**）。
  ///
  /// 非空意味着 `errorCode == "build-blocked"`：需要在**电脑端**授权后重装。
  /// 手机端刻意不提供批准入口（安装脚本可执行任意代码）。
  final List<String> pendingBuilds;

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
    this.registries = const [],
    this.attemptIndex = 0,
    this.attemptTotal = 0,
    this.answeredRegistry = '',
    this.installSource = 'name',
    this.pendingBuilds = const [],
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
      installSource: ((json['source'] as String?)?.trim().isNotEmpty ?? false)
          ? (json['source'] as String).trim()
          : 'name',
      pendingBuilds: (json['pendingBuilds'] as List? ?? const [])
          .map((value) => value?.toString().trim() ?? '')
          .where((value) => value.isNotEmpty)
          .toList(),
      registries: (json['registries'] as List? ?? const [])
          .map((value) => value?.toString().trim() ?? '')
          .where((value) => value.isNotEmpty)
          .toList(),
      attemptIndex:
          ((json['attempt'] as Map?)?['index'] as num?)?.toInt() ?? 0,
      attemptTotal:
          ((json['attempt'] as Map?)?['total'] as num?)?.toInt() ?? 0,
      answeredRegistry:
          (json['answeredRegistry'] as String?)?.trim() ?? '',
    );
  }

  bool get running => status == 'running';
  bool get succeeded => status == 'succeeded';
  bool get failed => status == 'failed';
  bool get wasCancelled => status == 'cancelled';
}

/// #153：一个安装源（宿主只读投影；App 不能增删）。
///
/// `url` 已由宿主规范化（末尾带 `/`）并剥离凭据；带凭据的条目会被宿主**整条丢弃**，
/// 所以这里出现的都只含 host + pathname。
class PluginRegistry {
  final String id;

  /// `registry`（宿主配置）或 `pnpm`（pnpm 自身配置解析出的源）。
  final String kind;
  final String url;
  final String display;

  /// `primary` / `fallback` / `resolved`。
  final String role;

  const PluginRegistry({
    this.id = '',
    this.kind = '',
    this.url = '',
    this.display = '',
    this.role = '',
  });

  factory PluginRegistry.fromJson(Object? json) {
    if (json is! Map) return const PluginRegistry();
    return PluginRegistry(
      id: (json['id'] as String?)?.trim() ?? '',
      kind: (json['kind'] as String?)?.trim() ?? '',
      url: (json['url'] as String?)?.trim() ?? '',
      display: (json['display'] as String?)?.trim() ?? '',
      role: (json['role'] as String?)?.trim() ?? '',
    );
  }

  String get displayLabel => display.isNotEmpty ? display : url;

  String get roleLabel => switch (role) {
    'primary' => L10n.t('宿主配置渠道', 'Configured by the desktop'),
    'fallback' => L10n.t('备选镜像', 'Fallback mirror'),
    'resolved' => L10n.t('pnpm 当前解析', 'Resolved by pnpm'),
    _ => role,
  };
}

/// #153：宿主会问哪些安装源（只读）。
class PluginRegistryList {
  final bool supported;
  final bool complete;
  final String reason;
  final List<PluginRegistry> registries;

  const PluginRegistryList({
    this.supported = false,
    this.complete = false,
    this.reason = '',
    this.registries = const [],
  });

  factory PluginRegistryList.fromJson(Object? json) {
    if (json is! Map) return const PluginRegistryList();
    return PluginRegistryList(
      supported: json['supported'] == true,
      complete: json['complete'] == true,
      reason: (json['reason'] as String?)?.trim() ?? '',
      registries: (json['registries'] as List? ?? const [])
          .map(PluginRegistry.fromJson)
          .toList(),
    );
  }

  factory PluginRegistryList.unsupported(String reason) =>
      PluginRegistryList(supported: false, reason: reason);

  /// 宿主提供了安装源列表。旧宿主无 `registries()` → false（App 仍可安装，只是不能选源）。
  bool get available => supported && registries.isNotEmpty;
}

/// #153：「检查全部更新」的一项结果。
///
/// 状态固定为 `available|current|failed|skipped`；`failed` 必须带 `errorCode`，
/// `skipped` 用 `reason` 说明为什么没发请求（例如 Git 来源需桌面端升级）。
class PluginUpdateCheckResult {
  final String name;
  final String state;
  final String latest;
  final String installed;
  final String errorCode;
  final String reason;
  final String answeredRegistry;

  const PluginUpdateCheckResult({
    required this.name,
    this.state = 'failed',
    this.latest = '',
    this.installed = '',
    this.errorCode = '',
    this.reason = '',
    this.answeredRegistry = '',
  });

  factory PluginUpdateCheckResult.fromJson(Object? json) {
    if (json is! Map) {
      return const PluginUpdateCheckResult(name: '', errorCode: 'check-failed');
    }
    final state = (json['state'] as String?)?.trim() ?? '';
    return PluginUpdateCheckResult(
      name: (json['name'] as String?)?.trim() ?? '',
      state: state.isEmpty ? 'failed' : state,
      latest: (json['latest'] as String?)?.trim() ?? '',
      installed: (json['installed'] as String?)?.trim() ?? '',
      errorCode: (json['errorCode'] as String?)?.trim() ?? '',
      reason: (json['reason'] as String?)?.trim() ?? '',
      answeredRegistry: (json['answeredRegistry'] as String?)?.trim() ?? '',
    );
  }

  bool get hasUpdate => state == 'available';
  bool get isCurrent => state == 'current';
  bool get isFailed => state == 'failed';
  bool get isSkipped => state == 'skipped';
}

/// #153：批量检查的进度与汇总（UI 只渲染这里的状态）。
class PluginUpdateScan {
  /// 逐项结果，按完成顺序；未完成的项不在这里。
  final Map<String, PluginUpdateCheckResult> results;

  /// 待检查的插件总数（`management.canUpdate === true` 且不是 Git 来源）。
  final int totalItemCount;

  /// 已派发数量（含在飞）。
  final int dispatched;
  final bool running;

  const PluginUpdateScan({
    this.results = const {},
    this.totalItemCount = 0,
    this.dispatched = 0,
    this.running = false,
  });

  int get completed => results.length;
  int get availableCount =>
      results.values.where((r) => r.hasUpdate).length;
  int get currentCount => results.values.where((r) => r.isCurrent).length;
  int get failedCount => results.values.where((r) => r.isFailed).length;
  int get skippedCount => results.values.where((r) => r.isSkipped).length;

  PluginUpdateScan copyWith({
    Map<String, PluginUpdateCheckResult>? results,
    int? totalItemCount,
    int? dispatched,
    bool? running,
  }) => PluginUpdateScan(
    results: results ?? this.results,
    totalItemCount: totalItemCount ?? this.totalItemCount,
    dispatched: dispatched ?? this.dispatched,
    running: running ?? this.running,
  );

  /// issue #174：让**单项**的扫描结果失效（其余项原样保留）。
  ///
  /// 升级/卸载/启停成功后版本或可更新状态已变，旧结果里的 `latest` 会让该行继续
  /// 显示「可更新 vX」；只丢这一项即可，其他插件不必重扫。
  PluginUpdateScan withoutResult(String name) => withoutResults([name]);

  /// issue #174：批量失效（保持其余项与其顺序）。
  PluginUpdateScan withoutResults(Iterable<String> names) {
    final drop = names.where((value) => value.isNotEmpty).toSet();
    if (drop.isEmpty) return this;
    final kept = <String, PluginUpdateCheckResult>{};
    for (final entry in results.entries) {
      if (!drop.contains(entry.key)) kept[entry.key] = entry.value;
    }
    if (kept.length == results.length) return this;
    return copyWith(results: Map.unmodifiable(kept));
  }
}

/// issue #175 P2：一次**任意 spec** 的安装前预校验结果。
///
/// 事实全部来自宿主 `pluginManager.inspect()`；App **不解析 spec**（不判形态、不拼路径），
/// 只渲染宿主给的 `kind`/`name`/`version` 与拒绝原因码。
///
/// `spec` 原文刻意**不放进模型**：它可能含 token 或内网/家目录路径，进入 UI 状态与
/// 日志即泄露。界面需要展示的是「宿主解析出了什么」，而不是用户输入的原文。
class PluginSpecInspection {
  /// 宿主是否**提供**预校验能力（旧宿主无 `inspect()` → false）。
  final bool supported;

  /// `accepted` / `refused`。
  final String status;

  /// `registry` / `git` / `path` / `tarball`；拒绝时可能为空。
  final String kind;

  final String name;
  final String version;
  final String description;

  /// 宿主该形态是否声明 `dsh.bundle`；`null` 表示预校验阶段还读不到（git/tarball）。
  final bool? bundle;

  /// 本次解析会先问的源（已由宿主规范化、剥离凭据）。
  final String registry;

  /// git / tarball 的拉取主机；registry/path 为空。
  final String host;

  /// 稳定拒绝码：`invalid-spec` / `already-installed` / `not-found` /
  /// `not-a-package` / `not-a-bundle` / `network` / `unknown`。
  final String problem;

  /// 宿主给的固定短句（已由宿主侧白名单收敛，不含路径/凭据）；可能为空。
  final String reason;

  const PluginSpecInspection({
    this.supported = false,
    this.status = 'refused',
    this.kind = '',
    this.name = '',
    this.version = '',
    this.description = '',
    this.bundle,
    this.registry = '',
    this.host = '',
    this.problem = '',
    this.reason = '',
  });

  factory PluginSpecInspection.fromJson(Object? json) {
    if (json is! Map) {
      return const PluginSpecInspection(problem: 'unknown');
    }
    final status = (json['status'] as String?)?.trim() ?? '';
    return PluginSpecInspection(
      supported: json['supported'] == true,
      status: status.isEmpty ? 'refused' : status,
      kind: (json['kind'] as String?)?.trim() ?? '',
      name: (json['name'] as String?)?.trim() ?? '',
      version: (json['version'] as String?)?.trim() ?? '',
      description: (json['description'] as String?)?.trim() ?? '',
      bundle: json['bundle'] is bool ? json['bundle'] as bool : null,
      registry: (json['registry'] as String?)?.trim() ?? '',
      host: (json['host'] as String?)?.trim() ?? '',
      problem: (json['problem'] as String?)?.trim() ?? '',
      reason: (json['reason'] as String?)?.trim() ?? '',
    );
  }

  /// 旧宿主没有预校验能力。App 据此说明「本机无法预校验」，而不是假装通过了。
  factory PluginSpecInspection.unsupported(String reason) =>
      PluginSpecInspection(supported: false, problem: reason);

  bool get accepted => status == 'accepted';
  bool get refused => !accepted;

  /// 形态的人话标签（`kind` 是宿主词汇，UI 统一在这里翻译）。
  String get kindLabel => switch (kind) {
    'registry' => L10n.t('npm 包', 'npm package'),
    'git' => L10n.t('Git 仓库', 'Git repository'),
    'path' => L10n.t('电脑上的本地目录', 'Local directory on the desktop'),
    'tarball' => L10n.t('tarball 包', 'Tarball'),
    _ => L10n.t('未识别', 'Unrecognized'),
  };

  /// 拒绝原因的人话文案。**必须**覆盖宿主全部稳定码，未知码给通用兜底（不臆测原因）。
  String get problemText => switch (problem) {
    'invalid-spec' => L10n.t(
      '无法识别的安装地址：请填写 npm 包名、GitHub/Git 地址、电脑上的绝对路径或 tarball 链接。'
          '本地路径必须是电脑上的绝对路径（如 /Users/name/plugin），不能是手机的。',
      'Unrecognized install address: use an npm package name, a Git URL, an absolute path '
          'on the desktop, or a tarball URL. A local path must be an absolute path on the '
          'desktop (e.g. /Users/name/plugin), not on the phone.',
    ),
    'already-installed' => L10n.t(
      '这个插件已经安装在电脑上了；要换版本请在插件详情里升级。',
      'This plugin is already installed on the desktop; update it from its details instead.',
    ),
    'not-found' => L10n.t(
      '在电脑端配置的安装源里找不到这个包。',
      'No such package in the sources configured on the desktop.',
    ),
    'not-a-package' => L10n.t(
      '这个地址不是可安装的包：本地路径必须存在且含 package.json，tarball 必须存在。',
      'This address is not an installable package: a local path must exist and contain '
          'package.json, and a tarball must exist.',
    ),
    'not-a-bundle' => L10n.t(
      '这个包没有声明 dsh.bundle，不是 DSH 插件。',
      'This package declares no dsh.bundle, so it is not a DSH plugin.',
    ),
    'network' => L10n.t(
      '电脑端访问安装源时网络失败，请检查电脑端的网络或安装源设置。',
      'The desktop could not reach the source; check its network or source settings.',
    ),
    _ => L10n.t(
      '无法完成预校验，请检查填写内容或电脑端状态后重试。',
      'Could not verify this address; check the input or the desktop and retry.',
    ),
  };

  /// 由宿主协议映射来源（`registry`/`git`/`path`/`tarball`），供 UI 展示。
  String get sourceLabel {
    if (host.isNotEmpty) return '$kindLabel · $host';
    if (registry.isNotEmpty) return kindLabel;
    return kindLabel;
  }
}

/// issue #175 P2：`inspect` 拒绝时宿主给的整体错误（HTTP 400 `invalid-spec` /
/// `spec-refused`），或安装提交阶段的错误。
class PluginSpecError {
  /// 稳定错误码：`invalid-spec` / `spec-refused` / `registry-invalid` / `bad-request`。
  final String code;

  /// 输入形态问题的类别（`too-long` / `control-char` / `empty` / `not-string`）。
  final String detail;

  /// `spec-refused` 时的宿主拒绝原因码。
  final String problem;

  final String reason;

  const PluginSpecError({
    this.code = '',
    this.detail = '',
    this.problem = '',
    this.reason = '',
  });

  factory PluginSpecError.fromJson(Object? json) {
    if (json is! Map) return const PluginSpecError();
    return PluginSpecError(
      code: (json['error'] as String?)?.trim() ?? '',
      detail: (json['detail'] as String?)?.trim() ?? '',
      problem: (json['problem'] as String?)?.trim() ?? '',
      reason: (json['reason'] as String?)?.trim() ?? '',
    );
  }

  /// 人话文案：优先后端给的 `problem`（语义更准），其次输入形态 `detail`，最后通用。
  String text() {
    if (problem.isNotEmpty) {
      return PluginSpecInspection(problem: problem).problemText;
    }
    return switch (detail) {
      'too-long' => L10n.t('安装地址太长（上限 2048 字符）。', 'The install address is too long (2048 characters max).'),
      'control-char' => L10n.t('安装地址含控制字符，请重新输入。', 'The install address contains control characters; retype it.'),
      'empty' => L10n.t('请填写安装地址。', 'Enter an install address.'),
      'not-string' => L10n.t('安装地址格式无效。', 'The install address is invalid.'),
      _ => switch (code) {
        'registry-invalid' => L10n.t(
          '安装源地址无效：只接受 http(s) 地址，不接受凭据、查询参数、片段或本地路径',
          'Invalid registry URL: only http(s) addresses are accepted, without credentials, query or fragment',
        ),
        'spec-refused' => L10n.t(
          '电脑端拒绝了这次安装。',
          'The desktop refused this installation.',
        ),
        _ => L10n.t('安装请求未能提交，请重试。', 'The install request could not be submitted; retry.'),
      },
    };
  }
}
