// issue #106：设置 → 通用 →「电脑端设置（只读）」全屏只读页。
//
// **安全契约（不可妥协）**：
//   - 只渲染服务端返回的白名单项；没有"显示全部"、没有白名单编辑、不猜 schema；
//   - 服务端没返回的项就不渲染，**不补默认值、不把 undefined 渲染成「关闭」**；
//   - secret 只显示「已设置/未设置」，永不显示值/长度/前缀（也不进复制）；
//   - 搜索只匹配标题/命名空间/键路径，**绝不搜值**（值不参与匹配，也不写日志）；
//   - 本页**没有任何写入控件**：无开关/输入框/保存/重置；点行只展开，不弹编辑。
//
// 失败即关：`supported:false`、命名空间 `complete:false`、白名单为空 → 不显示任何
// 原始值，只给"设置不可用"+ 重试。旧宿主 → 整页降级说明。
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../host_settings.dart';
import '../l10n.dart';
import '../store.dart';
import '../theme.dart';
import '../toast.dart';

/// 只读查看器（默认走真实 API；测试可注入 fake loader）。
class HostSettingsScreen extends StatefulWidget {
  final AppStore store;
  final Future<HostSettingsView> Function()? loader;

  const HostSettingsScreen({super.key, required this.store, this.loader});

  @override
  State<HostSettingsScreen> createState() => _HostSettingsScreenState();
}

class _HostSettingsScreenState extends State<HostSettingsScreen> {
  HostSettingsView? _view;
  String? _error;
  bool _loading = true;
  bool _refreshing = false;

  final _searchController = TextEditingController();
  String _search = '';
  HostSettingFilter _filter = HostSettingFilter.all;

  /// 展开的命名空间（默认展开第一个有字段的命名空间；保持到页面关闭）。
  final Set<String> _expanded = {};
  bool _initialExpandDone = false;

  /// 展开详情的字段（key = `ns\u0000keyPath`）。
  final Set<String> _expandedFields = {};

  Future<HostSettingsView> _load() =>
      (widget.loader ?? widget.store.api.hostSettings)();

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    if (!mounted) return;
    setState(() {
      if (_view == null) {
        _loading = true;
      } else {
        _refreshing = true;
      }
      _error = null;
    });
    try {
      final next = await _load();
      if (!mounted) return;
      setState(() {
        _view = next;
        _loading = false;
        _refreshing = false;
        if (!_initialExpandDone) {
          _initialExpandDone = true;
          final first = next.visibleNamespaces;
          if (first.isNotEmpty) _expanded.add(first.first.ns);
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _refreshing = false;
        // 保留已加载数据并标"可能过期"（设计稿 §2.6）。
        _error = e.toString();
      });
    }
  }

  void _clearSearch() {
    _searchController.clear();
    setState(() => _search = '');
  }

  @override
  Widget build(BuildContext context) {
    final view = _view;
    return Scaffold(
      appBar: AppBar(
        // 320 + 1.5x/2.0x 或英文长标题下，"标题 + 只读徽标"必须能收缩，
        // 不靠横向溢出（设计稿 §2.7：不使用横向滚动、不裁按钮）。
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(
              child: Text(
                L10n.t('DSH 设置', 'DSH settings'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
              ),
            ),
            const SizedBox(width: 8),
            Flexible(child: _ReadOnlyBadge()),
          ],
        ),
        actions: [
          if (_refreshing)
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 16),
              child: SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            )
          else
            IconButton(
              key: const ValueKey('host-settings-refresh'),
              tooltip: L10n.t('刷新', 'Refresh'),
              icon: const Icon(Icons.refresh),
              onPressed: _refresh,
            ),
        ],
      ),
      body: _buildBody(view),
    );
  }

  Widget _buildBody(HostSettingsView? view) {
    if (_loading && view == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (view == null) {
      return _staleErrorCard(
        detail: _error,
        onRetry: _refresh,
      );
    }
    // 旧宿主 / 无能力 / 白名单为空：整页降级，不伪造设置项。
    if (!view.supported) {
      return _UnsupportedBody(
        title: view.reasonText(),
        hint: L10n.t(
          '请在电脑端 DSH 设置中查看或修改。',
          'View or change these settings in DSH on the computer.',
        ),
        onRetry: _refresh,
      );
    }
    final visible = view.visibleNamespaces;
    if (!view.hasAnyField && view.failedNamespaces.isEmpty) {
      return _UnsupportedBody(
        title: L10n.t(
          '当前电脑没有白名单内的可显示设置',
          'No allow-listed settings to show on this computer',
        ),
        hint: L10n.t(
          '设置项由服务端固定白名单决定；未返回的项不会显示。',
          'Settings are limited by a fixed server-side allow-list; unlisted items are not shown.',
        ),
        onRetry: _refresh,
      );
    }

    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        key: const PageStorageKey<String>('host-settings-page'),
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: [
          _NoticeCard(view: view, stale: _error != null),
          const SizedBox(height: 12),
          _SearchBox(
            controller: _searchController,
            onChanged: (value) => setState(() => _search = value.trim()),
          ),
          const SizedBox(height: 10),
          _FilterChips(
            selected: _filter,
            onSelected: (filter) => setState(() => _filter = filter),
          ),
          const SizedBox(height: 12),
          ..._buildNamespaceCards(view, visible),
          const SizedBox(height: 4),
          _FooterNote(),
        ],
      ),
    );
  }

  List<Widget> _buildNamespaceCards(
    HostSettingsView view,
    List<HostSettingNamespace> visible,
  ) {
    final cards = <Widget>[];
    // 命名空间失败：卡片内错误行 + 重试，其它命名空间不受影响（设计稿 §2.6）。
    for (final broken in view.failedNamespaces) {
      cards.add(
        _NamespaceCard(
          key: ValueKey('host-settings-ns-${broken.ns}'),
          title: broken.displayTitle,
          ns: broken.ns,
          fieldCount: 0,
          expanded: false,
          onToggle: null,
          errorText: L10n.t('设置不可用', 'Settings unavailable'),
          onRetry: _refresh,
        ),
      );
      cards.add(const SizedBox(height: 10));
    }

    var matched = 0;
    for (final namespace in visible) {
      final fields = namespace.filtered(_filter, _search);
      if (fields.isEmpty) continue;
      matched += 1;
      final expanded = _search.isNotEmpty || _expanded.contains(namespace.ns);
      cards.add(
        _NamespaceCard(
          key: ValueKey('host-settings-ns-${namespace.ns}'),
          title: namespace.displayTitle,
          ns: namespace.ns,
          fieldCount: fields.length,
          expanded: expanded,
          onToggle: _search.isNotEmpty
              ? null
              : () => setState(() {
                  if (_expanded.contains(namespace.ns)) {
                    _expanded.remove(namespace.ns);
                  } else {
                    _expanded.add(namespace.ns);
                  }
                }),
          children: [
            for (var i = 0; i < fields.length; i++) ...[
              if (i > 0) _Divider(),
              _FieldRow(
                key: ValueKey(
                  'host-settings-field-${namespace.ns}-${fields[i].keyPath}',
                ),
                field: fields[i],
                expanded: _expandedFields.contains(
                  '${namespace.ns}\u0000${fields[i].keyPath}',
                ),
                onToggle: () => setState(() {
                  final id = '${namespace.ns}\u0000${fields[i].keyPath}';
                  if (_expandedFields.contains(id)) {
                    _expandedFields.remove(id);
                  } else {
                    _expandedFields.add(id);
                  }
                }),
              ),
            ],
          ],
        ),
      );
      cards.add(const SizedBox(height: 10));
    }

    if (matched == 0) {
      cards.add(
        _EmptySearch(
          hasQuery: _search.isNotEmpty,
          onClear: _clearSearch,
          onResetFilter: () => setState(() => _filter = HostSettingFilter.all),
        ),
      );
    }
    return cards;
  }

  Widget _staleErrorCard({required String? detail, required Future<void> Function() onRetry}) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.error_outline, size: 32, color: DshColors.danger(context)),
            const SizedBox(height: 12),
            Text(
              L10n.t('读取电脑端设置失败', 'Failed to read computer settings'),
              style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 6),
            Text(
              // 只给错误类型，不回显服务端原文（可能夹带路径）。
              L10n.t('请检查连接后重试', 'Check the connection and try again'),
              style: TextStyle(fontSize: 12, color: DshColors.ink3(context)),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 16),
            OutlinedButton(
              key: const ValueKey('host-settings-retry'),
              onPressed: () => unawaited(onRetry()),
              child: Text(L10n.t('重试', 'Retry')),
            ),
          ],
        ),
      ),
    );
  }
}

// ── 组件 ───────────────────────────────────────────────────────────────────

class _ReadOnlyBadge extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: DshColors.brandSoft(context),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        L10n.t('只读', 'Read-only'),
        style: TextStyle(
          fontSize: 10.5,
          fontWeight: FontWeight.w600,
          color: DshColors.brand(context),
        ),
      ),
    );
  }
}

class _NoticeCard extends StatelessWidget {
  final HostSettingsView view;
  final bool stale;

  const _NoticeCard({required this.view, this.stale = false});

  @override
  Widget build(BuildContext context) {
    final brand = DshColors.brand(context);
    final ink3 = DshColors.ink3(context);
    final host = <String>[
      if (view.dshVersion.isNotEmpty) 'DSH ${view.dshVersion}',
      if (stale) L10n.t('离线，可能过期', 'Offline, may be stale'),
    ];
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: DshColors.brandSoft(context),
        borderRadius: BorderRadius.circular(DshTheme.radiusMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 大字号/窄屏下"只读标题 + 固定白名单"会挤爆一行：标题优先，
          // 右侧标签可省略（信息不丢失，底部说明同样交代白名单语义）。
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.lock_outline, size: 15, color: brand),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  L10n.t('本版只读', 'Read-only in this version'),
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: brand,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Flexible(
                child: Text(
                  L10n.t('固定白名单', 'Fixed allow-list'),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.end,
                  style: TextStyle(fontSize: 11, color: ink3),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            L10n.t(
              '只显示电脑端允许查看的设置；修改请在电脑端 DSH 设置中完成。',
              'Only settings the computer allows are shown; change them in DSH on the computer.',
            ),
            style: TextStyle(fontSize: 11.5, color: ink3, height: 1.35),
          ),
          if (host.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              host.join(' · '),
              key: const ValueKey('host-settings-host-line'),
              style: TextStyle(fontSize: 11, color: ink3),
            ),
          ],
        ],
      ),
    );
  }
}

class _SearchBox extends StatelessWidget {
  final TextEditingController controller;
  final ValueChanged<String> onChanged;

  const _SearchBox({required this.controller, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 44,
      child: TextField(
        key: const ValueKey('host-settings-search'),
        controller: controller,
        onChanged: onChanged,
        textInputAction: TextInputAction.search,
        decoration: InputDecoration(
          isDense: true,
          prefixIcon: Icon(
            Icons.search,
            size: 18,
            color: DshColors.ink3(context),
          ),
          // 只匹配标题/命名空间/键路径；不搜值（值不进入匹配，避免敏感值参与检索）。
          hintText: L10n.t(
            '搜索白名单设置项',
            'Search allow-listed settings',
          ),
          hintStyle: TextStyle(fontSize: 13, color: DshColors.ink3(context)),
          filled: true,
          fillColor: DshColors.surface(context),
          contentPadding: const EdgeInsets.symmetric(vertical: 10),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: BorderSide(color: DshColors.line(context)),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: BorderSide(color: DshColors.line(context)),
          ),
        ),
      ),
    );
  }
}

class _FilterChips extends StatelessWidget {
  final HostSettingFilter selected;
  final ValueChanged<HostSettingFilter> onSelected;

  const _FilterChips({required this.selected, required this.onSelected});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 36,
      child: ListView(
        scrollDirection: Axis.horizontal,
        children: [
          for (final filter in HostSettingFilter.values)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: _Chip(
                key: ValueKey('host-settings-filter-${filter.name}'),
                label: hostSettingFilterLabel(filter),
                selected: selected == filter,
                onTap: () => onSelected(filter),
              ),
            ),
        ],
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;

  const _Chip({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final brand = DshColors.brand(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(18),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14),
        alignment: Alignment.center,
        constraints: const BoxConstraints(minWidth: 44, minHeight: 36),
        decoration: BoxDecoration(
          color: selected
              ? DshColors.brandSoft(context)
              : DshColors.surface(context),
          borderRadius: BorderRadius.circular(18),
          border: Border.all(
            color: selected ? DshColors.brandSoft(context) : DshColors.line(context),
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w600,
            color: selected ? brand : DshColors.ink2(context),
          ),
        ),
      ),
    );
  }
}

class _NamespaceCard extends StatelessWidget {
  final String title;
  final String ns;
  final int fieldCount;
  final bool expanded;
  final VoidCallback? onToggle;
  final String? errorText;
  final Future<void> Function()? onRetry;
  final List<Widget>? children;

  const _NamespaceCard({
    super.key,
    required this.title,
    required this.ns,
    required this.fieldCount,
    required this.expanded,
    required this.onToggle,
    this.errorText,
    this.onRetry,
    this.children,
  });

  @override
  Widget build(BuildContext context) {
    final ink3 = DshColors.ink3(context);
    final header = Padding(
      padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
      child: Row(
        children: [
          Icon(Icons.tune, size: 17, color: ink3),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                if (errorText == null)
                  Padding(
                    padding: const EdgeInsets.only(top: 1),
                    child: Text(
                      // 命名空间 id 用 mono 副行；白名单字段数只统计服务端返回项。
                      '$ns · ${L10n.t('$fieldCount 项', '$fieldCount items')}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 11,
                        color: ink3,
                        fontFamily: 'monospace',
                      ),
                    ),
                  ),
              ],
            ),
          ),
          if (onToggle != null)
            Icon(
              expanded ? Icons.expand_less : Icons.expand_more,
              size: 18,
              color: ink3,
            ),
        ],
      ),
    );

    return Container(
      decoration: BoxDecoration(
        color: DshColors.surface(context),
        borderRadius: BorderRadius.circular(DshTheme.radiusMd),
        boxShadow: Theme.of(context).brightness == Brightness.dark
            ? DshTheme.shadowDark
            : DshTheme.shadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (onToggle == null)
            header
          else
            InkWell(onTap: onToggle, child: header),
          if (errorText != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 12),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      errorText!,
                      style: TextStyle(
                        fontSize: 11.5,
                        color: DshColors.danger(context),
                      ),
                    ),
                  ),
                  if (onRetry != null)
                    TextButton(
                      onPressed: () => unawaited(onRetry!()),
                      child: Text(L10n.t('重试', 'Retry')),
                    ),
                ],
              ),
            ),
          if (errorText == null && expanded && children != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: children!,
              ),
            ),
        ],
      ),
    );
  }
}

class _FieldRow extends StatelessWidget {
  final HostSettingField field;
  final bool expanded;
  final VoidCallback onToggle;

  const _FieldRow({
    super.key,
    required this.field,
    required this.expanded,
    required this.onToggle,
  });

  @override
  Widget build(BuildContext context) {
    final ink = DshColors.ink(context);
    final ink2 = DshColors.ink2(context);
    final ink3 = DshColors.ink3(context);
    return Semantics(
      button: true,
      label: field.isSecret
          ? '${field.displayTitle}，${L10n.t('敏感字段', 'secret field')}，${field.secretSet ? L10n.t('已设置', 'set') : L10n.t('未设置', 'not set')}'
          : '${field.displayTitle}，${field.valueText}，${sourceLabel(field.source)}',
      child: InkWell(
        onTap: onToggle,
        child: ConstrainedBox(
          // 命中区 ≥ 56（设计稿 §2.4）；320/1.5x/2.0x 下换行而不是横向溢出。
          constraints: const BoxConstraints(minHeight: 56),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Row(
                        children: [
                          Flexible(
                            child: Text(
                              field.displayTitle,
                              style: TextStyle(
                                fontSize: 13.5,
                                fontWeight: FontWeight.w600,
                                color: ink,
                              ),
                            ),
                          ),
                          if (field.isSecret) ...[
                            const SizedBox(width: 4),
                            Icon(Icons.lock_outline, size: 12, color: ink3),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    _SourceTag(source: field.source),
                  ],
                ),
                const SizedBox(height: 3),
                if (field.isSecret)
                  Row(
                    children: [
                      Icon(
                        field.secretSet ? Icons.check_circle : Icons.remove_circle_outline,
                        size: 13,
                        color: field.secretSet
                            ? DshColors.ok(context)
                            : ink3,
                      ),
                      const SizedBox(width: 5),
                      Text(
                        field.secretSet
                            ? L10n.t('已设置', 'Set')
                            : L10n.t('未设置', 'Not set'),
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                          color: ink2,
                        ),
                      ),
                    ],
                  )
                else
                  Text(
                    field.valueText.isEmpty
                        ? L10n.t('（空）', '(empty)')
                        : field.valueText,
                    maxLines: expanded ? 6 : 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 13, color: ink),
                  ),
                if (!field.isSecret && field.hasDefault)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      '${L10n.t('默认', 'Default')}: ${field.defaultText}',
                      maxLines: expanded ? 4 : 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 11.5, color: ink3),
                    ),
                  ),
                if (field.isSecret)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      L10n.t('敏感字段：不显示值', 'Secret field: value hidden'),
                      style: TextStyle(fontSize: 11.5, color: ink3),
                    ),
                  ),
                if (expanded) _FieldDetail(field: field),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _FieldDetail extends StatelessWidget {
  final HostSettingField field;

  const _FieldDetail({required this.field});

  @override
  Widget build(BuildContext context) {
    final ink3 = DshColors.ink3(context);
    final line = DshColors.line(context);
    Widget lineOf(String label, String value, {bool mono = false}) => Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 72,
            child: Text(
              label,
              style: TextStyle(fontSize: 11, color: ink3),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              value,
              style: TextStyle(
                fontSize: 11.5,
                color: DshColors.ink2(context),
                fontFamily: mono ? 'monospace' : null,
              ),
            ),
          ),
        ],
      ),
    );

    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.fromLTRB(10, 6, 10, 10),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: line)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 键路径用 mono；来源层级只给"哪一层命中"，不给原始文件路径。
          lineOf(L10n.t('键路径', 'Key path'), field.keyPath, mono: true),
          if (!field.isSecret) ...[
            lineOf(
              L10n.t('当前值', 'Value'),
              field.valueText.isEmpty ? L10n.t('（空）', '(empty)') : field.valueText,
            ),
            lineOf(
              L10n.t('默认值', 'Default'),
              field.hasDefault
                  ? (field.defaultText ?? '')
                  : L10n.t('（无）', '(none)'),
            ),
            lineOf(
              L10n.t('来源层级', 'Layers'),
              _layerText(field),
            ),
            if (field.valueText.isNotEmpty)
              Align(
                alignment: Alignment.centerRight,
                child: TextButton.icon(
                  key: ValueKey('host-settings-copy-${field.keyPath}'),
                  icon: const Icon(Icons.copy, size: 14),
                  label: Text(L10n.t('复制值', 'Copy value')),
                  onPressed: () async {
                    await Clipboard.setData(ClipboardData(text: field.valueText));
                    if (context.mounted) {
                      showToast(
                        context,
                        L10n.t('已复制（非敏感值）', 'Copied (non-secret value)'),
                      );
                    }
                  },
                ),
              ),
          ] else
            lineOf(
              L10n.t('来源层级', 'Layers'),
              L10n.t('敏感字段不参与来源判定', 'Secrets carry no source layers'),
            ),
        ],
      ),
    );
  }

  /// 层级只显示"有/无/不可知"，不给用户覆盖层的原始来源路径。
  static String _layerText(HostSettingField field) {
    String mark(bool? hit) => hit == null
        ? L10n.t('不可知', 'n/a')
        : hit
        ? L10n.t('有', 'yes')
        : L10n.t('无', 'no');
    return '${L10n.t('用户', 'user')}: ${mark(field.userLayer)} · '
        '${L10n.t('组合', 'base')}: ${mark(field.baseLayer)} · '
        '${L10n.t('schema', 'schema')}: ${mark(field.schemaLayer)}';
  }
}

class _SourceTag extends StatelessWidget {
  final HostSettingSource source;

  const _SourceTag({required this.source});

  @override
  Widget build(BuildContext context) {
    final (fg, bg) = switch (source) {
      HostSettingSource.user => (
        DshColors.brand(context),
        DshColors.brandSoft(context),
      ),
      HostSettingSource.base => (
        DshColors.ink2(context),
        DshColors.line(context),
      ),
      _ => (DshColors.ink3(context), DshColors.line(context)),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        sourceLabel(source),
        style: TextStyle(
          fontSize: 10.5,
          fontWeight: FontWeight.w600,
          color: fg,
        ),
      ),
    );
  }
}

class _Divider extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(height: 1, color: DshColors.line(context));
  }
}

class _EmptySearch extends StatelessWidget {
  final bool hasQuery;
  final VoidCallback onClear;
  final VoidCallback onResetFilter;

  const _EmptySearch({
    required this.hasQuery,
    required this.onClear,
    required this.onResetFilter,
  });

  @override
  Widget build(BuildContext context) {
    final ink3 = DshColors.ink3(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 28),
      child: Column(
        children: [
          Text(
            hasQuery
                ? L10n.t('没有匹配的设置项', 'No matching settings')
                : L10n.t('当前筛选下没有设置项', 'No settings under this filter'),
            style: TextStyle(fontSize: 13, color: ink3),
          ),
          const SizedBox(height: 8),
          if (hasQuery)
            TextButton(
              key: const ValueKey('host-settings-clear-search'),
              onPressed: onClear,
              child: Text(L10n.t('清除搜索', 'Clear search')),
            )
          else
            TextButton(
              onPressed: onResetFilter,
              child: Text(L10n.t('显示全部', 'Show all')),
            ),
        ],
      ),
    );
  }
}

class _UnsupportedBody extends StatelessWidget {
  final String title;
  final String hint;
  final Future<void> Function() onRetry;

  const _UnsupportedBody({
    required this.title,
    required this.hint,
    required this.onRetry,
  });

  @override
  Widget build(BuildContext context) {
    final ink3 = DshColors.ink3(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.lock_outline, size: 32, color: ink3),
            const SizedBox(height: 12),
            Text(
              title,
              key: const ValueKey('host-settings-unsupported-title'),
              style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 6),
            Text(
              hint,
              style: TextStyle(fontSize: 12, color: ink3),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 16),
            OutlinedButton(
              key: const ValueKey('host-settings-retry'),
              onPressed: () => unawaited(onRetry()),
              child: Text(L10n.t('重试', 'Retry')),
            ),
          ],
        ),
      ),
    );
  }
}

class _FooterNote extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            Icons.verified_user_outlined,
            size: 14,
            color: DshColors.ok(context),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              L10n.t(
                '服务端按 namespace + 字段白名单 fail-closed；未返回项不显示。只读切片，不会修改电脑端配置。',
                'The computer enforces a fixed namespace + field allow-list; unlisted items are not shown. Read-only: nothing on the computer is modified.',
              ),
              style: TextStyle(
                fontSize: 11,
                color: DshColors.ink3(context),
                height: 1.4,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
