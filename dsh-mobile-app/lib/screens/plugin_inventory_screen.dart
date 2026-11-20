// issue #145：设置 → 插件管理（只读）。
//
// 只展示当前连接宿主返回的清单/版本/来源/启停/健康/兼容；不提供安装/升级/卸载/启停/重启。
// 旧宿主/缺能力整页降级；加载/空/失败/刷新失败都有独立形态。
import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../l10n.dart';
import '../plugin_inventory.dart';
import '../store.dart';
import '../theme.dart';
import 'sheets.dart';

/// #146：安装/升级动作依赖（默认走真实 API；测试可注入 fake）。
class PluginInventoryActions {
  final Future<PluginVersionCheck> Function(String name) checkVersions;
  final Future<PluginOperation> Function(String name) install;
  final Future<PluginOperation> Function(String name, String version) upgrade;
  final Future<PluginOperation> Function(String opId) poll;
  final Future<String> Function(String opId) cancel;

  const PluginInventoryActions({
    required this.checkVersions,
    required this.install,
    required this.upgrade,
    required this.poll,
    required this.cancel,
  });

  factory PluginInventoryActions.fromApi(Api api) => PluginInventoryActions(
    checkVersions: api.pluginVersions,
    install: api.pluginInstall,
    upgrade: api.pluginUpgrade,
    poll: api.pluginOperation,
    cancel: api.pluginCancelOperation,
  );
}

String pluginOperationErrorText(String code) {
  final key = code.trim();
  return switch (key) {
    'plugin-manager-unavailable' => L10n.t(
      '当前电脑端不支持该操作',
      'This desktop does not support the operation',
    ),
    'plugin-not-installed' => L10n.t('插件未安装', 'Plugin is not installed'),
    'not-installable' => L10n.t(
      '该插件不在电脑端配置渠道的可安装清单中',
      'This plugin is not installable from the configured source',
    ),
    'plugin-not-updatable' => L10n.t(
      '当前插件不支持手机端升级',
      'This plugin cannot be updated from the phone',
    ),
    'git-update-desktop-required' => L10n.t(
      'Git 来源的升级请在电脑端进行',
      'Update this Git-sourced plugin on the desktop',
    ),
    'plugin-operation-in-progress' => L10n.t(
      '该插件已有操作进行中，请等待完成',
      'An operation is already running for this plugin',
    ),
    'plugin-operation-not-found' => L10n.t(
      '操作记录不存在或已过期，请刷新清单',
      'The operation is gone or expired; refresh the list',
    ),
    'invalid-plugin-name' ||
    'invalid-plugin-version' => L10n.t('插件参数无效', 'Invalid plugin parameters'),
    'plugin-versions-unavailable' => L10n.t(
      '无法检查更新，请检查网络或电脑端状态',
      'Could not check for updates; check the network or desktop',
    ),
    'plugin-inventory-unavailable' => L10n.t(
      '读取插件清单失败',
      'Could not read the plugin list',
    ),
    'plugin-install-failed' ||
    'plugin-update-failed' => L10n.t('操作失败', 'Operation failed'),
    _ => key.isEmpty ? L10n.t('操作失败', 'Operation failed') : key,
  };
}

class PluginInventoryScreen extends StatefulWidget {
  final AppStore store;
  final Future<PluginInventory> Function()? loader;
  final PluginInventoryActions? actions;
  final Future<void> Function()? refreshAll;

  const PluginInventoryScreen({
    super.key,
    required this.store,
    this.loader,
    this.actions,
    this.refreshAll,
  });

  @override
  State<PluginInventoryScreen> createState() => _PluginInventoryScreenState();
}

class _PluginInventoryScreenState extends State<PluginInventoryScreen> {
  PluginInventory? _inventory;
  String? _error;
  bool _loading = true;
  PluginOperation? _operation;
  Timer? _operationTimer;
  String? _actionError;
  bool _cancelPending = false;

  PluginInventoryActions get _actions =>
      widget.actions ?? PluginInventoryActions.fromApi(widget.store.api);

  Future<PluginInventory> _load() =>
      (widget.loader ?? widget.store.api.pluginInventory)();

  @override
  void dispose() {
    _operationTimer?.cancel();
    super.dispose();
  }

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

  Future<bool> _confirm({
    required String title,
    required String body,
    required String confirmLabel,
  }) async {
    final result = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(title, style: const TextStyle(fontSize: 16)),
        content: Text(body, style: const TextStyle(fontSize: 13, height: 1.5)),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(L10n.t('取消', 'Cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(confirmLabel),
          ),
        ],
      ),
    );
    return result == true;
  }

  Future<void> _startInstall(PluginInstallable item) async {
    final version = item.version.isEmpty ? '' : ' v${item.version}';
    final ok = await _confirm(
      title: L10n.t(
        '安装「${item.displayName}」？',
        'Install “${item.displayName}”?',
      ),
      body: L10n.t(
        '${item.source.displayLabel}${version.isEmpty ? '' : ' · 版本$version'}\n'
            '仅从电脑端已配置的渠道安装；失败会自动回滚，不会留下半安装。',
        '${item.source.displayLabel}${version.isEmpty ? '' : ' · version$version'}\n'
            'Installation uses only the configured desktop source; a failure rolls back automatically.',
      ),
      confirmLabel: L10n.t('安装', 'Install'),
    );
    if (!ok) return;
    await _runAction(() => _actions.install(item.name));
  }

  Future<void> _startUpgrade(
    PluginInfo plugin,
    PluginVersionInfo version,
  ) async {
    final ok = await _confirm(
      title: L10n.t(
        '升级「${plugin.displayName}」',
        'Update “${plugin.displayName}”',
      ),
      body: L10n.t(
        '将从 ${plugin.version.isEmpty ? '未知版本' : 'v${plugin.version}'} 升级到 v${version.version}，期间插件可能短暂停止。\n'
            '安装失败会自动恢复旧版本；完成后可能需要重启电脑端。',
        'Update from ${plugin.version.isEmpty ? 'unknown' : 'v${plugin.version}'} to v${version.version}; the plugin may briefly stop.\n'
            'A failure restores the previous version automatically; a desktop restart may be required.',
      ),
      confirmLabel: L10n.t('升级', 'Update'),
    );
    if (!ok) return;
    await _runAction(() => _actions.upgrade(plugin.name, version.version));
  }

  Future<void> _runAction(Future<PluginOperation> Function() action) async {
    setState(() => _actionError = null);
    try {
      final operation = await action();
      if (!mounted) return;
      _watchOperation(operation);
    } catch (e) {
      if (!mounted) return;
      final code = e is ApiException ? (e.code ?? '') : '';
      setState(() => _actionError = pluginOperationErrorText(code));
    }
  }

  void _watchOperation(PluginOperation operation) {
    _operationTimer?.cancel();
    setState(() {
      _operation = operation;
      _cancelPending = false;
    });
    if (!operation.running) {
      _handleTerminalOperation(operation);
      return;
    }
    _operationTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      unawaited(_pollOperation());
    });
  }

  Future<void> _pollOperation() async {
    final current = _operation;
    if (current == null || !current.running) return;
    try {
      final operation = await _actions.poll(current.opId);
      if (!mounted) return;
      setState(() => _operation = operation);
      if (!operation.running) _handleTerminalOperation(operation);
    } catch (_) {
      // 轮询失败不伪造结果：保持进行中，下一 tick 重试。
    }
  }

  void _handleTerminalOperation(PluginOperation operation) {
    _operationTimer?.cancel();
    // 安装/升级成功或回滚后都重拉清单：版本/健康/能力以宿主为准。
    unawaited(_refresh());
    unawaited((widget.refreshAll ?? widget.store.refreshAll)());
  }

  Future<void> _cancelOperation() async {
    final operation = _operation;
    if (operation == null || !operation.running || _cancelPending) return;
    setState(() => _cancelPending = true);
    try {
      await _actions.cancel(operation.opId);
    } catch (e) {
      if (!mounted) return;
      final code = e is ApiException ? (e.code ?? '') : '';
      setState(() => _actionError = pluginOperationErrorText(code));
    } finally {
      if (mounted) setState(() => _cancelPending = false);
    }
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
    if (!inventory.supported && inventory.plugins.isEmpty) {
      return _UnsupportedState(
        onRetry: _refresh,
        error: _error,
        loading: _loading,
      );
    }
    return _buildList(context, inventory);
  }

  Widget _buildList(BuildContext context, PluginInventory inventory) {
    final plugins = inventory.plugins;
    final partial = inventory.isPartial;
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
        children: [
          _HostContextCard(store: widget.store, host: inventory.host),
          if (_operation != null && _operation!.running)
            _OperationBanner(
              operation: _operation!,
              cancelPending: _cancelPending,
              onCancel: _cancelOperation,
            ),
          if (_operation != null && !_operation!.running)
            _OperationResultBanner(
              operation: _operation!,
              onDismiss: () => setState(() => _operation = null),
            ),
          if (_actionError != null)
            _InlineNotice(
              icon: Icons.error_outline,
              text: _actionError!,
              actionLabel: L10n.t('关闭', 'Dismiss'),
              onAction: () => setState(() => _actionError = null),
            ),
          if (partial)
            _InlineNotice(
              icon: Icons.info_outline,
              text: L10n.t(
                '清单不完整：宿主运行态或独立插件列表不可用，以下可能缺少条目。',
                'Incomplete list: the host runtime or standalone plugins are unavailable; some entries may be missing.',
              ),
              actionLabel: L10n.t('重试', 'Retry'),
              onAction: _refresh,
            ),
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
            for (final plugin in plugins)
              _PluginRow(
                plugin: plugin,
                actions: _actions,
                onUpgrade: _startUpgrade,
              ),
          ],
          if (inventory.installable.isNotEmpty) ...[
            const SizedBox(height: 18),
            _SectionTitle(
              title: L10n.t('可安装（配置渠道）', 'Available (configured source)'),
              count: inventory.installable.length,
            ),
            for (final item in inventory.installable)
              _InstallableRow(item: item, onInstall: () => _startInstall(item)),
          ],
          const SizedBox(height: 18),
          Text(
            L10n.t(
              '仅显示当前电脑上的插件。安装/升级只使用电脑端已配置的渠道；失败会自动回滚；不提供卸载、启停或重启。',
              'Only plugins on this computer are shown. Install/update use only configured desktop sources and roll back on failure; remove, enable/disable and restart are not available.',
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

String _pluginStepLabel(String key) => switch (key) {
  'prepare' => L10n.t('准备', 'Prepare'),
  'install' => L10n.t('安装', 'Install'),
  'enable' => L10n.t('启用', 'Enable'),
  'check' => L10n.t('检查版本', 'Check version'),
  'remove' => L10n.t('停止并移除旧版本', 'Stop and remove old version'),
  'restore' => L10n.t('恢复旧版本', 'Restore old version'),
  _ => key,
};

class _OperationBanner extends StatelessWidget {
  final PluginOperation operation;
  final bool cancelPending;
  final VoidCallback onCancel;
  const _OperationBanner({
    required this.operation,
    required this.cancelPending,
    required this.onCancel,
  });

  @override
  Widget build(BuildContext context) {
    final updating = operation.action == 'update';
    return Container(
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.fromLTRB(12, 10, 10, 10),
      decoration: BoxDecoration(
        color: DshColors.brandSoft(context),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: DshColors.line(context)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  updating
                      ? L10n.t(
                          '正在升级 ${operation.name}…',
                          'Updating ${operation.name}…',
                        )
                      : L10n.t(
                          '正在安装 ${operation.name}…',
                          'Installing ${operation.name}…',
                        ),
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              TextButton(
                onPressed: cancelPending ? null : onCancel,
                child: Text(L10n.t('取消', 'Cancel')),
              ),
            ],
          ),
          Wrap(
            spacing: 6,
            runSpacing: 4,
            children: [
              for (final step in operation.steps)
                _OperationStepChip(step: step),
            ],
          ),
        ],
      ),
    );
  }
}

class _OperationStepChip extends StatelessWidget {
  final PluginOperationStep step;
  const _OperationStepChip({required this.step});

  @override
  Widget build(BuildContext context) {
    final color = switch (step.state) {
      'done' => DshColors.ok(context),
      'running' => DshColors.brand(context),
      'failed' => DshColors.danger(context),
      _ => DshColors.ink3(context),
    };
    final icon = switch (step.state) {
      'done' => Icons.check_circle_outline,
      'running' => Icons.radio_button_checked,
      'failed' => Icons.error_outline,
      'skipped' => Icons.remove_circle_outline,
      _ => Icons.circle_outlined,
    };
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 12, color: color),
        const SizedBox(width: 3),
        Text(
          _pluginStepLabel(step.key),
          style: TextStyle(fontSize: 11, color: color),
        ),
      ],
    );
  }
}

class _OperationResultBanner extends StatelessWidget {
  final PluginOperation operation;
  final VoidCallback onDismiss;
  const _OperationResultBanner({
    required this.operation,
    required this.onDismiss,
  });

  String _message() {
    if (operation.wasCancelled) {
      return L10n.t('已取消，未留下半安装', 'Cancelled; no partial installation remains');
    }
    if (operation.succeeded) {
      final version = operation.version.isEmpty ? '' : ' v${operation.version}';
      final base = operation.action == 'update'
          ? L10n.t('升级完成$version', 'Updated$version')
          : L10n.t('安装完成$version', 'Installed$version');
      return operation.restartRequired
          ? L10n.t(
              '$base，需要重启电脑端宿主后生效（请在电脑端重启 DSH）',
              '$base; restart the desktop DSH host to apply it',
            )
          : base;
    }
    if (operation.outcomeUnknown) {
      return L10n.t(
        '操作失败，结果未知；请刷新清单核对，必要时在电脑端检查',
        'Operation failed with an unknown outcome; refresh and verify on the desktop',
      );
    }
    if (operation.rollbackFailed) {
      return L10n.t(
        '升级失败，自动恢复旧版本也失败；请在电脑端检查插件状态',
        'Update failed and restoring the previous version also failed; check on the desktop',
      );
    }
    if (operation.rolledBack) {
      return operation.action == 'update'
          ? L10n.t(
              '升级失败，已自动恢复到 ${operation.fromVersion.isEmpty ? '旧版本' : 'v${operation.fromVersion}'}',
              'Update failed; restored ${operation.fromVersion.isEmpty ? 'the previous version' : 'v${operation.fromVersion}'}',
            )
          : L10n.t(
              '安装失败，已自动回滚，未留下半安装',
              'Install failed; rolled back with no partial installation',
            );
    }
    if (operation.unchanged) {
      return L10n.t(
        '升级失败，旧版本未变更',
        'Update failed; the previous version is unchanged',
      );
    }
    return L10n.t(
      '操作失败${operation.errorCode.isEmpty ? '' : '（${operation.errorCode}）'}',
      'Operation failed${operation.errorCode.isEmpty ? '' : ' (${operation.errorCode})'}',
    );
  }

  @override
  Widget build(BuildContext context) {
    final ok = operation.succeeded;
    final color = ok
        ? (operation.restartRequired
              ? DshColors.warn(context)
              : DshColors.ok(context))
        : DshColors.danger(context);
    return Container(
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.fromLTRB(12, 8, 4, 8),
      decoration: BoxDecoration(
        color: DshColors.surface(context),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withValues(alpha: 0.5)),
      ),
      child: Row(
        children: [
          Icon(
            ok
                ? (operation.restartRequired
                      ? Icons.info_outline
                      : Icons.check_circle_outline)
                : Icons.error_outline,
            size: 17,
            color: color,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              _message(),
              style: TextStyle(
                fontSize: 12,
                height: 1.4,
                color: DshColors.ink2(context),
              ),
            ),
          ),
          IconButton(
            tooltip: L10n.t('关闭', 'Dismiss'),
            icon: const Icon(Icons.close, size: 16),
            onPressed: onDismiss,
          ),
        ],
      ),
    );
  }
}

class _InstallableRow extends StatelessWidget {
  final PluginInstallable item;
  final VoidCallback onInstall;
  const _InstallableRow({required this.item, required this.onInstall});

  @override
  Widget build(BuildContext context) {
    final version = item.version.isEmpty ? '' : 'v${item.version}';
    return Semantics(
      container: true,
      label: '${item.displayName}${version.isEmpty ? '' : '，$version'}，可安装',
      child: ExcludeSemantics(
        child: Container(
          constraints: const BoxConstraints(minHeight: 60),
          padding: const EdgeInsets.symmetric(vertical: 8),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: DshColors.line(context))),
          ),
          child: Row(
            children: [
              Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(
                  color: DshColors.brandSoft(context),
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Icon(
                  Icons.download_outlined,
                  size: 18,
                  color: DshColors.brand(context),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      item.displayName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '${item.name}${version.isEmpty ? '' : ' · $version'} · ${item.source.displayLabel}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 11.5,
                        color: DshColors.ink3(context),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 6),
              TextButton(
                onPressed: onInstall,
                style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
                child: Text(L10n.t('安装', 'Install')),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PluginDetailSheet extends StatefulWidget {
  final PluginInfo plugin;
  final PluginInventoryActions actions;
  final Future<void> Function(PluginInfo plugin, PluginVersionInfo version)
  onUpgrade;
  const _PluginDetailSheet({
    required this.plugin,
    required this.actions,
    required this.onUpgrade,
  });

  @override
  State<_PluginDetailSheet> createState() => _PluginDetailSheetState();
}

class _PluginDetailSheetState extends State<_PluginDetailSheet> {
  bool _checking = false;
  PluginVersionCheck? _check;
  String? _error;

  Future<void> _checkUpdates() async {
    setState(() {
      _checking = true;
      _error = null;
    });
    try {
      final result = await widget.actions.checkVersions(widget.plugin.name);
      if (!mounted) return;
      setState(() => _check = result);
    } catch (e) {
      if (!mounted) return;
      final code = e is ApiException ? (e.code ?? '') : '';
      setState(() => _error = pluginOperationErrorText(code));
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  Widget _fact(BuildContext context, String label, String value) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 76,
          child: Text(
            label,
            style: TextStyle(fontSize: 11.5, color: DshColors.ink3(context)),
          ),
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

  @override
  Widget build(BuildContext context) {
    final plugin = widget.plugin;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (plugin.version.isNotEmpty)
          _fact(context, L10n.t('版本', 'Version'), plugin.version),
        _fact(context, L10n.t('包名', 'Package'), plugin.packageName),
        _fact(context, L10n.t('来源', 'Source'), plugin.source.displayLabel),
        _fact(
          context,
          L10n.t('启用状态', 'Enablement'),
          plugin.enabled ? L10n.t('已启用', 'Enabled') : L10n.t('已停用', 'Disabled'),
        ),
        _fact(
          context,
          L10n.t('健康', 'Health'),
          plugin.health.reasonText.isEmpty
              ? plugin.health.label
              : '${plugin.health.label} · ${plugin.health.reasonText}',
        ),
        _fact(
          context,
          L10n.t('兼容性', 'Compatibility'),
          plugin.compatibility.ok
              ? L10n.t('兼容', 'Compatible')
              : plugin.compatibility.isIncompatible
              ? L10n.t(
                  '不兼容${plugin.compatibility.requirements.isEmpty ? '' : '（${plugin.compatibility.requirements}）'}',
                  'Incompatible${plugin.compatibility.requirements.isEmpty ? '' : ' (${plugin.compatibility.requirements})'}',
                )
              : L10n.t('未知（宿主未提供判定）', 'Unknown (not reported by the host)'),
        ),
        if (plugin.current)
          _fact(
            context,
            L10n.t('当前连接', 'Current connection'),
            L10n.t('是', 'Yes'),
          ),
        const Divider(height: 18),
        if (plugin.updateKind == 'git')
          Text(
            L10n.t(
              'Git 来源的插件请在电脑端升级。',
              'Update this Git-sourced plugin on the desktop.',
            ),
            style: TextStyle(fontSize: 12, color: DshColors.ink2(context)),
          )
        else if (!plugin.canUpdate)
          Text(
            L10n.t(
              '当前插件不支持手机端升级（内置或非配置渠道）。',
              'This plugin cannot be updated from the phone (built-in or not from a configured source).',
            ),
            style: TextStyle(fontSize: 12, color: DshColors.ink2(context)),
          )
        else ...[
          if (_check == null)
            OutlinedButton.icon(
              onPressed: _checking ? null : _checkUpdates,
              icon: _checking
                  ? const SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.system_update_alt, size: 17),
              label: Text(
                _checking
                    ? L10n.t('检查中…', 'Checking…')
                    : L10n.t('检查更新', 'Check for updates'),
              ),
            )
          else if (_check!.status == 'refused')
            Text(
              L10n.t(
                '无法检查更新：${_check!.problem}${_check!.reason.isEmpty ? '' : '（${_check!.reason}）'}',
                'Could not check for updates: ${_check!.problem}${_check!.reason.isEmpty ? '' : ' (${_check!.reason})'}',
              ),
              style: TextStyle(fontSize: 12, color: DshColors.warn(context)),
            )
          else if (_check!.usableVersions.isEmpty)
            Text(
              L10n.t('已是最新版本', 'Already up to date'),
              style: TextStyle(fontSize: 12, color: DshColors.ink2(context)),
            )
          else ...[
            for (final version in _check!.versions.take(6))
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        'v${version.version}${version.prerelease ? L10n.t('（预发布）', ' (prerelease)') : ''}',
                        style: const TextStyle(fontSize: 12.5),
                      ),
                    ),
                    if (!version.usable)
                      Expanded(
                        child: Text(
                          version.incompatibleRequirements.isEmpty
                              ? L10n.t('不可用', 'Unavailable')
                              : L10n.t(
                                  '不兼容（${version.incompatibleRequirements}）',
                                  'Incompatible (${version.incompatibleRequirements})',
                                ),
                          style: TextStyle(
                            fontSize: 11,
                            color: DshColors.danger(context),
                          ),
                        ),
                      )
                    else
                      TextButton(
                        onPressed: () {
                          Navigator.of(context).pop();
                          unawaited(widget.onUpgrade(plugin, version));
                        },
                        child: Text(L10n.t('升级', 'Update')),
                      ),
                  ],
                ),
              ),
            TextButton(
              onPressed: _checking ? null : _checkUpdates,
              child: Text(L10n.t('重新检查', 'Check again')),
            ),
          ],
          if (_error != null)
            Text(
              _error!,
              style: TextStyle(fontSize: 12, color: DshColors.danger(context)),
            ),
        ],
        const SizedBox(height: 8),
        Text(
          L10n.t(
            '仅使用电脑端已配置的渠道；失败由宿主自动回滚；不提供卸载/启停/重启。',
            'Only configured desktop sources are used; the host rolls back failures; remove, enable/disable and restart are not available.',
          ),
          style: TextStyle(
            fontSize: 11.5,
            height: 1.4,
            color: DshColors.ink3(context),
          ),
        ),
      ],
    );
  }
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
  final PluginInventoryActions actions;
  final Future<void> Function(PluginInfo plugin, PluginVersionInfo version)
  onUpgrade;
  const _PluginRow({
    required this.plugin,
    required this.actions,
    required this.onUpgrade,
  });

  String get _versionLabel => plugin.version.isEmpty
      ? L10n.t('版本未知', 'Version unknown')
      : 'v${plugin.version}';

  String _statusLabel() {
    if (plugin.compatibility.isIncompatible) {
      return L10n.t('不兼容', 'Incompatible');
    }
    return plugin.health.label;
  }

  Color _statusColor(BuildContext context) {
    final ink3 = DshColors.ink3(context);
    if (plugin.compatibility.isIncompatible || plugin.health.isFailed) {
      return DshColors.danger(context);
    }
    if (plugin.health.isOk) return DshColors.ok(context);
    if (plugin.health.isStarting) return DshColors.warn(context);
    return ink3;
  }

  String? _reasonLine() {
    if (plugin.compatibility.isIncompatible) {
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
    showSheet(context, plugin.displayName, [
      _PluginDetailSheet(
        plugin: plugin,
        actions: actions,
        onUpgrade: onUpgrade,
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
  final String? error;
  final bool loading;
  const _UnsupportedState({
    required this.onRetry,
    this.error,
    this.loading = false,
  });
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
          if (error != null) ...[
            const SizedBox(height: 8),
            Text(
              L10n.t('重新检测失败：$error', 'Check failed: $error'),
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12, color: DshColors.danger(context)),
            ),
          ],
          const SizedBox(height: 10),
          OutlinedButton(
            onPressed: loading ? null : onRetry,
            child: loading
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text(L10n.t('重新检测', 'Check again')),
          ),
        ],
      ),
    ),
  );
}
