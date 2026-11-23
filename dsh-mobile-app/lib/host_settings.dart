// issue #106：DSH 设置只读查看器的 App 侧模型。
//
// **安全契约（不可妥协）**：本文件**不保存白名单副本、不拼路径、不猜 schema**。
// 服务端（宿主 `lib/host-settings-whitelist.js`）只返回固定白名单投影过的项；
// 响应里没有的项在 App 侧就是不可见：
//   - 不补默认值、不对未知字段做兜底展示、不显示原始 JSON；
//   - `kind == "secret"` 只渲染「已设置/未设置」，永不带值/长度/前缀；
//   - 解析失败的项**丢弃**而不是"猜一个值"（fail-closed）。
//
// 本文件只做形状解析与展示文案，不发起请求（请求在 `api.dart`）。
import 'l10n.dart';

/// 字段来源（只给语义标签，宿主不给原始路径）。
enum HostSettingSource {
  /// user 层含该路径 → 用户覆盖。
  user,

  /// base 层有值且与 schema 默认不同 → 组合默认（宿主配置基线）。
  base,

  /// schema 默认。
  schema,

  /// 旧宿主缺 base/user 层 → 来源未知（不猜）。
  unknown,
}

HostSettingSource _sourceOf(Object? raw) => switch (raw) {
  'user' => HostSettingSource.user,
  'base' => HostSettingSource.base,
  'default' => HostSettingSource.schema,
  _ => HostSettingSource.unknown,
};

String sourceLabel(HostSettingSource source) => switch (source) {
  HostSettingSource.user => L10n.t('用户覆盖', 'Overridden'),
  HostSettingSource.base => L10n.t('组合默认', 'Composed'),
  HostSettingSource.schema => L10n.t('默认值', 'Default'),
  HostSettingSource.unknown => L10n.t('未知', 'Unknown'),
};

/// 一个白名单字段。
///
/// 只承载宿主明确返回的事实：`valueText` / `defaultText` 都是**宿主算好的字符串**，
/// App 不做格式化推断（避免把 `undefined` 渲染成「关闭」之类的猜测）。
class HostSettingField {
  final String ns;

  /// 服务端白名单里的键路径（如 `providers.opencode-go.displayName`）。
  ///
  /// 仅用于展示与本地搜索，**不用于请求**（App 从不按路径取数）。
  final String keyPath;
  final String title;
  final String titleEn;
  final String groupId;

  /// `value` 普通值；`secret` 只给设置状态。
  final String kind;

  /// secret 槽位是否已设置（`kind == 'secret'` 时有效；永不展示值/长度/前缀）。
  final bool secretSet;

  final String valueText;

  /// `string` / `number` / `boolean`（宿主擦除后的标量类型；未知为空串）。
  final String valueKind;
  final bool? boolValue;
  final num? numberValue;
  final String? defaultText;
  final bool hasDefault;
  final HostSettingSource source;

  /// 三层是否命中（`null` = 该层信息不可得，不当作 false）。
  final bool? userLayer;
  final bool? baseLayer;
  final bool schemaLayer;

  const HostSettingField({
    required this.ns,
    required this.keyPath,
    required this.title,
    this.titleEn = '',
    this.groupId = '',
    this.kind = 'value',
    this.secretSet = false,
    this.valueText = '',
    this.valueKind = '',
    this.boolValue,
    this.numberValue,
    this.defaultText,
    this.hasDefault = false,
    this.source = HostSettingSource.unknown,
    this.userLayer,
    this.baseLayer,
    this.schemaLayer = false,
  });

  /// 解析单个字段；**形状不合法返回 null**（调用方丢弃，不猜一半）。
  static HostSettingField? fromJson(Object? json) {
    if (json is! Map) return null;
    final ns = (json['ns'] as String?)?.trim() ?? '';
    final keyPath = (json['keyPath'] as String?)?.trim() ?? '';
    final title = (json['title'] as String?)?.trim() ?? '';
    // 没有 ns / 路径 / 标题的行无法安全展示（也无从搜索），直接丢弃。
    if (ns.isEmpty || keyPath.isEmpty || title.isEmpty) return null;
    final kind = (json['kind'] as String?)?.trim() ?? '';
    // 只认识两种 kind；未知 kind 丢弃（fail-closed，不当作普通值渲染）。
    if (kind != 'value' && kind != 'secret') return null;
    final layers = json['layers'];
    bool? layerOf(Object? map, String key) {
      if (map is! Map) return null;
      final value = map[key];
      return value is bool ? value : null;
    }

    final rawKind = (json['valueKind'] as String?)?.trim() ?? '';
    final valueKind = kind == 'secret' ? '' : rawKind;
    return HostSettingField(
      ns: ns,
      keyPath: keyPath,
      title: title,
      titleEn: (json['titleEn'] as String?)?.trim() ?? '',
      groupId: (json['groupId'] as String?)?.trim() ?? '',
      kind: kind,
      secretSet: json['secretSet'] == true,
      valueText: kind == 'secret' ? '' : (json['valueText'] as String? ?? ''),
      valueKind: valueKind,
      boolValue: kind == 'secret' ? null : json['boolValue'] as bool?,
      numberValue: kind == 'secret' ? null : json['numberValue'] as num?,
      defaultText: kind == 'secret' ? null : json['defaultText'] as String?,
      hasDefault: kind == 'secret' ? false : json['hasDefault'] == true,
      source: kind == 'secret'
          ? HostSettingSource.unknown
          : _sourceOf(json['source']),
      userLayer: layerOf(layers, 'user'),
      baseLayer: layerOf(layers, 'base'),
      schemaLayer: layerOf(layers, 'schema') == true,
    );
  }

  /// 敏感字段（只显示 set 状态）。
  bool get isSecret => kind == 'secret';

  /// 标题（无英文时回落中文；宿主不给就只用 title，不猜）。
  String get displayTitle => L10n.lang == 'en' && titleEn.isNotEmpty
      ? titleEn
      : title;

  /// 用户覆盖（用于「已覆盖」筛选）。
  bool get isOverridden => source == HostSettingSource.user;

  /// 有默认差异（用于「有默认差异」筛选）：用户覆盖或组合默认都算差异。
  bool get hasDefaultDelta =>
      source == HostSettingSource.user || source == HostSettingSource.base;

  /// 搜索只匹配**标题 / 命名空间 / 键路径**，**绝不搜值**（避免敏感值参与匹配与日志）。
  bool matches(String query, {String namespaceTitle = ''}) {
    if (query.isEmpty) return true;
    final needle = query.toLowerCase();
    return displayTitle.toLowerCase().contains(needle) ||
        title.toLowerCase().contains(needle) ||
        ns.toLowerCase().contains(needle) ||
        keyPath.toLowerCase().contains(needle) ||
        namespaceTitle.toLowerCase().contains(needle);
  }
}

/// 一个命名空间卡片。
class HostSettingNamespace {
  final String ns;
  final String title;
  final String titleEn;
  final String groupId;
  final int? revision;
  final bool complete;

  /// 失败原因（稳定代号，不含原文）；`complete == true` 时为空。
  final String reason;
  final List<HostSettingField> fields;

  const HostSettingNamespace({
    required this.ns,
    required this.title,
    this.titleEn = '',
    this.groupId = '',
    this.revision,
    this.complete = true,
    this.reason = '',
    this.fields = const [],
  });

  static HostSettingNamespace? fromJson(Object? json) {
    if (json is! Map) return null;
    final ns = (json['ns'] as String?)?.trim() ?? '';
    if (ns.isEmpty) return null;
    final fields = <HostSettingField>[];
    for (final raw in json['fields'] as List? ?? const []) {
      final field = HostSettingField.fromJson(raw);
      if (field != null) fields.add(field);
    }
    return HostSettingNamespace(
      ns: ns,
      title: (json['title'] as String?)?.trim() ?? ns,
      titleEn: (json['titleEn'] as String?)?.trim() ?? '',
      groupId: (json['groupId'] as String?)?.trim() ?? '',
      revision: (json['revision'] as num?)?.toInt(),
      complete: json['complete'] == true,
      reason: (json['reason'] as String?)?.trim() ?? '',
      // fail-closed：命名空间失败时**不保留任何字段**（即使宿主误带）。
      fields: json['complete'] == true ? fields : const [],
    );
  }

  bool get hasFields => fields.isNotEmpty;

  String get displayTitle => L10n.lang == 'en' && titleEn.isNotEmpty
      ? titleEn
      : title;

  /// 该命名空间下按搜索/筛选后的字段。
  List<HostSettingField> filtered(HostSettingFilter filter, String query) {
    return fields.where((field) {
      if (filter == HostSettingFilter.overridden && !field.isOverridden) {
        return false;
      }
      if (filter == HostSettingFilter.delta && !field.hasDefaultDelta) {
        return false;
      }
      return field.matches(query, namespaceTitle: displayTitle);
    }).toList();
  }
}

/// 过滤 chips（全部 / 已覆盖 / 有默认差异）。
enum HostSettingFilter { all, overridden, delta }

String hostSettingFilterLabel(HostSettingFilter filter) => switch (filter) {
  HostSettingFilter.all => L10n.t('全部', 'All'),
  HostSettingFilter.overridden => L10n.t('已覆盖', 'Overridden'),
  HostSettingFilter.delta => L10n.t('有默认差异', 'Differs'),
};

/// 视觉分组（宿主冻结的标题；App 不自造分组名）。
class HostSettingGroup {
  final String id;
  final String title;
  final String titleEn;

  const HostSettingGroup({
    required this.id,
    required this.title,
    this.titleEn = '',
  });

  static HostSettingGroup? fromJson(Object? json) {
    if (json is! Map) return null;
    final id = (json['id'] as String?)?.trim() ?? '';
    final title = (json['title'] as String?)?.trim() ?? '';
    if (id.isEmpty || title.isEmpty) return null;
    return HostSettingGroup(
      id: id,
      title: title,
      titleEn: (json['titleEn'] as String?)?.trim() ?? '',
    );
  }

  String get displayTitle => L10n.lang == 'en' && titleEn.isNotEmpty
      ? titleEn
      : title;
}

/// `/m/api/host-settings` 的完整响应。
///
/// 降级契约：旧宿主没有该端点 → `Api.hostSettings()` 返回 [unsupported]；
/// 宿主有端点但没能力 → `supported:false` + `reason`（页面整页降级，不伪造设置项）。
class HostSettingsView {
  final bool supported;
  final bool complete;

  /// 稳定原因码（不含原文/路径）；页面据此显示"不可用/部分不可用"。
  final String reason;
  final int whitelistVersion;
  final String generatedAt;
  final String dshVersion;
  final String pluginVersion;
  final List<HostSettingGroup> groups;
  final List<HostSettingNamespace> namespaces;

  const HostSettingsView({
    this.supported = false,
    this.complete = false,
    this.reason = '',
    this.whitelistVersion = 0,
    this.generatedAt = '',
    this.dshVersion = '',
    this.pluginVersion = '',
    this.groups = const [],
    this.namespaces = const [],
  });

  factory HostSettingsView.unsupported(String reason) =>
      HostSettingsView(supported: false, complete: false, reason: reason);

  factory HostSettingsView.fromJson(Object? json) {
    if (json is! Map) return HostSettingsView.unsupported('bad-response');
    final host = json['host'];
    final groups = <HostSettingGroup>[];
    for (final raw in json['groups'] as List? ?? const []) {
      final group = HostSettingGroup.fromJson(raw);
      if (group != null) groups.add(group);
    }
    final namespaces = <HostSettingNamespace>[];
    for (final raw in json['namespaces'] as List? ?? const []) {
      final namespace = HostSettingNamespace.fromJson(raw);
      if (namespace != null) namespaces.add(namespace);
    }
    return HostSettingsView(
      supported: json['supported'] == true,
      complete: json['complete'] == true,
      reason: (json['reason'] as String?)?.trim() ?? '',
      whitelistVersion: (json['whitelistVersion'] as num?)?.toInt() ?? 0,
      generatedAt: (json['generatedAt'] as String?)?.trim() ?? '',
      dshVersion: host is Map
          ? (host['dshVersion'] as String?)?.trim() ?? ''
          : '',
      pluginVersion: host is Map
          ? (host['pluginVersion'] as String?)?.trim() ?? ''
          : '',
      groups: groups,
      namespaces: namespaces,
    );
  }

  /// 有可展示字段的命名空间（按宿主给的分组顺序，未分组者排在最后）。
  List<HostSettingNamespace> get visibleNamespaces {
    final ordered = <String>[];
    for (final group in groups) {
      for (final namespace in namespaces) {
        if (namespace.groupId == group.id && namespace.hasFields) {
          if (!ordered.contains(namespace.ns)) ordered.add(namespace.ns);
        }
      }
    }
    final rest = namespaces
        .where((n) => n.hasFields && !ordered.contains(n.ns))
        .map((n) => n.ns);
    ordered.addAll(rest);
    return [
      for (final ns in ordered) namespaces.firstWhere((n) => n.ns == ns),
    ];
  }

  /// 失败的命名空间（页面显示"设置不可用"+ 重试；不显示任何原始值）。
  List<HostSettingNamespace> get failedNamespaces =>
      namespaces.where((n) => !n.complete).toList();

  bool get hasAnyField => visibleNamespaces.isNotEmpty;

  /// 分组标题（该命名空间所属分组；未分组回落空串，UI 不伪造分组名）。
  String groupTitleOf(HostSettingNamespace namespace) {
    for (final group in groups) {
      if (group.id == namespace.groupId) return group.displayTitle;
    }
    return '';
  }

  /// 原因码 → 人类可读说明（**只用稳定代号映射，不回显原文**）。
  String reasonText() {
    return switch (reason) {
      '' => '',
      'endpoint-missing' => L10n.t(
        '当前电脑端不支持只读设置查看',
        'This computer does not support the read-only settings view',
      ),
      'settings-service-missing' => L10n.t(
        '当前电脑端没有设置服务',
        'No settings service on this computer',
      ),
      'settings-describe-unavailable' => L10n.t(
        '当前电脑端版本过旧，无法提供分层设置',
        'This computer is too old to provide layered settings',
      ),
      'whitelist-empty' => L10n.t(
        '当前电脑端没有允许查看的设置项',
        'This computer exposes no settings for viewing',
      ),
      'projection-failed' => L10n.t(
        '设置暂不可用',
        'Settings are unavailable',
      ),
      _ => L10n.t('设置暂不可用', 'Settings are unavailable'),
    };
  }
}
