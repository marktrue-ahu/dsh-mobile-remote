// issue #145：设置 → 插件管理（只读）。
//
// 只展示当前连接宿主返回的清单/版本/来源/启停/健康/兼容；不提供安装/升级/卸载/启停/重启。
// 旧宿主/缺能力整页降级；加载/空/失败/刷新失败都有独立形态。
import 'package:flutter/material.dart';

import '../l10n.dart';
import '../plugin_inventory.dart';
import '../store.dart';
import '../theme.dart';
import 'sheets.dart';

class PluginInventoryScreen extends StatefulWidget {
  final AppStore store;
  final Future<PluginInventory> Function()? loader;

  const PluginInventoryScreen({super.key, required this.store, this.loader});

  @override
  State<PluginInventoryScreen> createState() => _PluginInventoryScreenState();
}

class _PluginInventoryScreenState extends State<PluginInventoryScreen> {
  PluginInventory? _inventory;
  String? _error;
  bool _loading = true;

  Future<PluginInventory> _load() =>
      (widget.loader ?? widget.store.api.pluginInventory)();

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    final hadData = _inventory != null;
    setState(() {
      _loading = true;
      if (!hadData) _error = null;
    });
    try {
      final inventory = await _load();
      if (!mounted) return;
      setState(() {
        _inventory = inventory;
        _error = null;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = L10n.t(
          '读取失败，请检查连接后重试',
          'Could not read. Check the connection and retry.',
        );
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(
          L10n.t('插件管理', 'Plugins'),
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
        actions: [
          IconButton(
            tooltip: L10n.t('刷新插件清单', 'Refresh plugins'),
            icon: _loading
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.refresh),
            onPressed: _loading ? null : _refresh,
          ),
        ],
      ),
      body: SafeArea(
        child: AnimatedBuilder(
          animation: widget.store,
          builder: (context, _) => _buildBody(context),
        ),
      ),
    );
  }

  Widget _buildBody(BuildContext context) {
    final inventory = _inventory;
    if (_loading && inventory == null) return const _CenterLoading();
    if (inventory == null) {
      return _FailureState(
        message: _error ?? L10n.t('读取失败', 'Failed to load'),
        onRetry: _refresh,
      );
    }
    if (!inventory.supported) {
      return _UnsupportedState(onRetry: _refresh);
    }
    return _buildList(context, inventory);
  }

  Widget _buildList(BuildContext context, PluginInventory inventory) {
    final plugins = inventory.plugins;
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
        children: [
          _HostContextCard(store: widget.store, host: inventory.host),
          if (_error != null)
            _InlineNotice(
              icon: Icons.warning_amber_outlined,
              text: L10n.t(
                '$_error，下面可能不是最新清单',
                '$_error The list below may be stale.',
              ),
              actionLabel: L10n.t('重试', 'Retry'),
              onAction: _refresh,
            ),
          const SizedBox(height: 16),
          _SectionTitle(
            title: L10n.t('已安装插件', 'Installed plugins'),
            count: plugins.length,
          ),
          if (plugins.isEmpty)
            _EmptyState(onRetry: _refresh)
          else ...[
            for (final plugin in plugins) _PluginRow(plugin: plugin),
          ],
          const SizedBox(height: 18),
          Text(
            L10n.t(
              '仅显示当前电脑上的插件。当前版本只读，不提供安装、升级、卸载、启停或重启操作。',
              'Only plugins on this computer are shown. This version is read-only: install, update, remove, enable/disable and restart are not available.',
            ),
            style: TextStyle(
              fontSize: 11.5,
              height: 1.45,
              color: DshColors.ink3(context),
            ),
          ),
        ],
      ),
    );
  }
}

class _CenterLoading extends StatelessWidget {
  const _CenterLoading();
  @override
  Widget build(BuildContext context) => const Center(
    child: SizedBox(
      width: 24,
      height: 24,
      child: CircularProgressIndicator(strokeWidth: 2),
    ),
  );
}

class _HostContextCard extends StatelessWidget {
  final AppStore store;
  final PluginInventoryHost host;
  const _HostContextCard({required this.store, required this.host});

  String get _address {
    final uri = Uri.tryParse(store.api.baseUrl);
    if (uri == null || uri.host.isEmpty) return store.api.baseUrl;
    final port = uri.hasPort ? ':${uri.port}' : '';
    return '${uri.host}$port';
  }

  @override
  Widget build(BuildContext context) {
    final connected = store.connState == 'connected';
    final stateText = connected
        ? L10n.t('已连接', 'Connected')
        : store.connState == 'connecting'
        ? L10n.t('重连中', 'Reconnecting')
        : L10n.t('离线', 'Offline');
    final stateColor = connected
        ? DshColors.ok(context)
        : DshColors.ink3(context);
    final hostId = host.id.isNotEmpty ? host.shortId : store.api.hostIdentity;
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: DshColors.surface(context),
        borderRadius: BorderRadius.circular(DshTheme.radiusMd),
        border: Border.all(color: DshColors.line(context)),
      ),
      child: Row(
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: DshColors.brandSoft(context),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(
              Icons.computer_outlined,
              size: 20,
              color: DshColors.brand(context),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  L10n.t('当前电脑', 'This computer'),
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  hostId.isEmpty ? _address : '$_address · $hostId',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 11.5,
                    fontFamily: 'monospace',
                    color: DshColors.ink3(context),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(
                  color: stateColor,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 5),
              Text(
                stateText,
                style: TextStyle(
                  fontSize: 11.5,
                  fontWeight: FontWeight.w600,
                  color: stateColor,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  final String title;
  final int count;
  const _SectionTitle({required this.title, required this.count});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        children: [
          Text(
            title,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: DshColors.ink2(context),
            ),
          ),
          const SizedBox(width: 6),
          Text(
            '$count',
            style: TextStyle(fontSize: 11.5, color: DshColors.ink3(context)),
          ),
        ],
      ),
    );
  }
}

class _PluginRow extends StatelessWidget {
  final PluginInfo plugin;
  const _PluginRow({required this.plugin});

  String get _versionLabel => plugin.version.isEmpty
      ? L10n.t('版本未知', 'Version unknown')
      : 'v${plugin.version}';

  String _statusLabel() {
    if (!plugin.compatibility.ok) return L10n.t('不兼容', 'Incompatible');
    return plugin.health.label;
  }

  Color _statusColor(BuildContext context) {
    final ink3 = DshColors.ink3(context);
    if (!plugin.compatibility.ok || plugin.health.isFailed) {
      return DshColors.danger(context);
    }
    if (plugin.health.isOk) return DshColors.ok(context);
    return ink3;
  }

  String? _reasonLine() {
    if (!plugin.compatibility.ok) {
      final req = plugin.compatibility.requirements;
      return req.isEmpty
          ? L10n.t('与当前 DSH 版本不兼容', 'Incompatible with this DSH version')
          : L10n.t(
              '与当前 DSH 版本不兼容（$req）',
              'Incompatible with this DSH version ($req)',
            );
    }
    if (plugin.health.isFailed) return plugin.health.reasonText;
    return null;
  }

  void _openDetail(BuildContext context) {
    final ink3 = DshColors.ink3(context);
    Widget fact(String label, String value) => Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 76,
            child: Text(label, style: TextStyle(fontSize: 11.5, color: ink3)),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(fontSize: 12.5, height: 1.4),
            ),
          ),
        ],
      ),
    );
    showSheet(context, plugin.displayName, [
      if (plugin.version.isNotEmpty)
        fact(L10n.t('版本', 'Version'), plugin.version),
      fact(L10n.t('包名', 'Package'), plugin.packageName),
      fact(L10n.t('来源', 'Source'), plugin.source.displayLabel),
      fact(
        L10n.t('启用状态', 'Enablement'),
        plugin.enabled ? L10n.t('已启用', 'Enabled') : L10n.t('已停用', 'Disabled'),
      ),
      fact(
        L10n.t('健康', 'Health'),
        plugin.health.reasonText.isEmpty
            ? plugin.health.label
            : '${plugin.health.label} · ${plugin.health.reasonText}',
      ),
      fact(
        L10n.t('兼容性', 'Compatibility'),
        plugin.compatibility.ok
            ? L10n.t('兼容', 'Compatible')
            : L10n.t(
                '不兼容${plugin.compatibility.requirements.isEmpty ? '' : '（${plugin.compatibility.requirements}）'}',
                'Incompatible${plugin.compatibility.requirements.isEmpty ? '' : ' (${plugin.compatibility.requirements})'}',
              ),
      ),
      if (plugin.current)
        fact(L10n.t('当前连接', 'Current connection'), L10n.t('是', 'Yes')),
      Container(
        margin: const EdgeInsets.only(top: 6),
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: DshColors.brandSoft(context),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Text(
          L10n.t(
            '只读视图：当前版本不提供安装、升级、卸载、启停或重启操作。',
            'Read-only: install, update, remove, enable/disable and restart are not available in this version.',
          ),
          style: TextStyle(
            fontSize: 11.5,
            height: 1.4,
            color: DshColors.ink2(context),
          ),
        ),
      ),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final compact =
        MediaQuery.sizeOf(context).width <= 340 ||
        MediaQuery.textScalerOf(context).scale(14) >= 1.4;
    final statusColor = _statusColor(context);
    final statusLabel = _statusLabel();
    final reason = _reasonLine();
    final name = plugin.displayName;
    final versionLabel = _versionLabel;
    final sourceLabel = plugin.source.displayLabel;
    final semantics =
        '$name，$versionLabel，$statusLabel${plugin.current ? '，当前连接' : ''}';

    final rightStatus = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 7,
          height: 7,
          decoration: BoxDecoration(color: statusColor, shape: BoxShape.circle),
        ),
        const SizedBox(width: 5),
        Text(
          statusLabel,
          style: TextStyle(
            fontSize: 11.5,
            fontWeight: FontWeight.w600,
            color: statusColor,
          ),
        ),
      ],
    );

    return Semantics(
      container: true,
      button: true,
      label: semantics,
      child: ExcludeSemantics(
        child: InkWell(
          onTap: () => _openDetail(context),
          child: Container(
            constraints: const BoxConstraints(minHeight: 64),
            padding: const EdgeInsets.symmetric(vertical: 10),
            decoration: BoxDecoration(
              border: Border(
                bottom: BorderSide(color: DshColors.line(context)),
              ),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: DshColors.brandSoft(context),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Icon(
                    Icons.extension_outlined,
                    size: 20,
                    color: DshColors.brand(context),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                          if (!compact) ...[
                            const SizedBox(width: 6),
                            Text(
                              versionLabel,
                              style: TextStyle(
                                fontSize: 11.5,
                                fontFamily: 'monospace',
                                color: DshColors.ink2(context),
                              ),
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: 2),
                      Text(
                        compact
                            ? '$versionLabel · $sourceLabel'
                            : '${plugin.packageName} · $sourceLabel',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 11.5,
                          color: DshColors.ink3(context),
                        ),
                      ),
                      if (reason != null) ...[
                        const SizedBox(height: 3),
                        Text(
                          reason,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 11.5,
                            color:
                                plugin.compatibility.ok &&
                                    plugin.health.isFailed
                                ? DshColors.danger(context)
                                : DshColors.ink2(context),
                          ),
                        ),
                      ],
                      if (compact) ...[
                        const SizedBox(height: 5),
                        Wrap(
                          spacing: 8,
                          runSpacing: 3,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            rightStatus,
                            if (plugin.current) const _CurrentTag(),
                          ],
                        ),
                      ],
                    ],
                  ),
                ),
                if (!compact) ...[
                  const SizedBox(width: 8),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      rightStatus,
                      if (plugin.current) ...[
                        const SizedBox(height: 4),
                        const _CurrentTag(),
                      ],
                    ],
                  ),
                  const SizedBox(width: 4),
                  Icon(
                    Icons.chevron_right,
                    size: 18,
                    color: DshColors.ink3(context),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _CurrentTag extends StatelessWidget {
  const _CurrentTag();
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
    decoration: BoxDecoration(
      color: DshColors.brandSoft(context),
      borderRadius: BorderRadius.circular(6),
    ),
    child: Text(
      L10n.t('当前连接', 'Current'),
      style: TextStyle(
        fontSize: 11,
        fontWeight: FontWeight.w600,
        color: DshColors.brand(context),
      ),
    ),
  );
}

class _InlineNotice extends StatelessWidget {
  final IconData icon;
  final String text;
  final String actionLabel;
  final VoidCallback onAction;
  const _InlineNotice({
    required this.icon,
    required this.text,
    required this.actionLabel,
    required this.onAction,
  });

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(top: 10),
    padding: const EdgeInsets.fromLTRB(12, 9, 8, 9),
    decoration: BoxDecoration(
      color: DshColors.brandSoft(context),
      borderRadius: BorderRadius.circular(10),
      border: Border.all(color: DshColors.line(context)),
    ),
    child: Row(
      children: [
        Icon(icon, size: 16, color: DshColors.warn(context)),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            text,
            style: TextStyle(
              fontSize: 12,
              height: 1.35,
              color: DshColors.ink2(context),
            ),
          ),
        ),
        TextButton(onPressed: onAction, child: Text(actionLabel)),
      ],
    ),
  );
}

class _EmptyState extends StatelessWidget {
  final VoidCallback onRetry;
  const _EmptyState({required this.onRetry});
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 36),
    child: Column(
      children: [
        Icon(
          Icons.extension_off_outlined,
          size: 30,
          color: DshColors.ink2(context),
        ),
        const SizedBox(height: 8),
        Text(
          L10n.t('未读取到插件', 'No plugins found'),
          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 4),
        Text(
          L10n.t(
            '连接正常但清单为空，通常是异常；可重试。',
            'The connection is fine but the list is empty; retry.',
          ),
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 12.5, color: DshColors.ink3(context)),
        ),
        const SizedBox(height: 8),
        TextButton(onPressed: onRetry, child: Text(L10n.t('重试', 'Retry'))),
      ],
    ),
  );
}

class _FailureState extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;
  const _FailureState({required this.message, required this.onRetry});
  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.error_outline, size: 30, color: DshColors.danger(context)),
          const SizedBox(height: 8),
          Text(
            L10n.t('无法读取插件清单', 'Could not load plugins'),
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 4),
          Text(
            message,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12.5, color: DshColors.ink3(context)),
          ),
          const SizedBox(height: 10),
          FilledButton(onPressed: onRetry, child: Text(L10n.t('重试', 'Retry'))),
        ],
      ),
    ),
  );
}

class _UnsupportedState extends StatelessWidget {
  final VoidCallback onRetry;
  const _UnsupportedState({required this.onRetry});
  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.extension_off_outlined,
            size: 30,
            color: DshColors.ink2(context),
          ),
          const SizedBox(height: 8),
          Text(
            L10n.t(
              '当前电脑端不支持手机端插件管理',
              'This desktop does not support mobile plugin management',
            ),
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 6),
          Text(
            L10n.t(
              '请在电脑端 DSH 设置 → 插件中管理。',
              'Manage plugins in DSH on the desktop: Settings → Plugins.',
            ),
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 12.5,
              height: 1.4,
              color: DshColors.ink3(context),
            ),
          ),
          const SizedBox(height: 10),
          OutlinedButton(
            onPressed: onRetry,
            child: Text(L10n.t('重新检测', 'Check again')),
          ),
        ],
      ),
    ),
  );
}
