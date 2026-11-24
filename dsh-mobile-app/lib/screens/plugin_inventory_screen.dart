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
import 'plugin_install_source_screen.dart';
import 'plugin_management_widgets.dart';
import 'plugin_spec_install_screen.dart';
import 'plugin_update_scan.dart';
import 'sheets.dart';

/// #146：安装/升级动作依赖（默认走真实 API；测试可注入 fake）。
///
/// #153 的 `registry` 透传**不改动既有三个函数签名**，而是新增一组可选 `*At` 钩子：
/// 既有 fake（`Function(String)` / `Function(String, String)`）无需改动仍可赋值，
/// 而需要验证源透传的调用方注入 `*At`。只影响本次解析的源，不持久化。
class PluginInventoryActions {
  final Future<PluginVersionCheck> Function(String name) checkVersions;
  final Future<PluginOperation> Function(String name) install;
  final Future<PluginOperation> Function(String name, String version) upgrade;
  final Future<PluginOperation> Function(String name) uninstall;
  final Future<PluginOperation> Function(String name, bool enabled) toggle;
  final Future<String> Function() restartHost;
  final Future<PluginOperation> Function(String opId) poll;
  final Future<String> Function(String opId) cancel;

  /// #153：带安装源的版本检查（`registry == null` 表示沿用宿主自己的解析顺序）。
  final Future<PluginVersionCheck> Function(String name, String? registry)?
  checkVersionsAt;

  /// #153：带安装源的安装（`registry == null` 表示沿用宿主自己的解析顺序）。
  final Future<PluginOperation> Function(String name, String? registry)?
  installAt;

  /// #153：带安装源的升级（避免“检查到的版本装不上”）。
  final Future<PluginOperation> Function(
    String name,
    String version,
    String? registry,
  )?
  upgradeAt;

  /// #153：宿主只读安装源投影（旧宿主无该端点 → supported:false）。
  /// 未注入时安装走原有确认框（没有源可选，多一跳没有信息增益）。
  final Future<PluginRegistryList> Function()? registries;

  /// issue #175 P2：任意 spec 的安装前预校验（`null` = 当前宿主/注入方不支持，
  /// 插件页不显示「手动安装」入口，而不是给一个点了会失败的按钮）。
  final Future<PluginSpecInspection> Function(String spec, String? registry)?
  inspectSpec;

  /// issue #175 P2：按任意 spec 安装（`null` = 不支持手动安装）。
  final Future<PluginOperation> Function(String spec, String? registry)?
  installBySpec;

  const PluginInventoryActions({
    required this.checkVersions,
    required this.install,
    required this.upgrade,
    required this.uninstall,
    required this.toggle,
    required this.restartHost,
    required this.poll,
    required this.cancel,
    this.checkVersionsAt,
    this.installAt,
    this.upgradeAt,
    this.registries,
    this.inspectSpec,
    this.installBySpec,
  });

  factory PluginInventoryActions.fromApi(Api api) => PluginInventoryActions(
    checkVersions: api.pluginVersions,
    install: api.pluginInstall,
    upgrade: api.pluginUpgrade,
    uninstall: api.pluginUninstall,
    toggle: api.pluginToggle,
    restartHost: api.pluginRestartHost,
    poll: api.pluginOperation,
    cancel: api.pluginCancelOperation,
    checkVersionsAt: (name, registry) =>
        api.pluginVersions(name, registry: registry),
    installAt: (name, registry) => api.pluginInstall(name, registry: registry),
    upgradeAt: (name, version, registry) =>
        api.pluginUpgrade(name, version, registry: registry),
    registries: api.pluginRegistries,
    inspectSpec: (spec, registry) =>
        api.pluginInspectSpec(spec, registry: registry),
    installBySpec: (spec, registry) =>
        api.pluginInstallBySpec(spec, registry: registry),
  );

  /// issue #175 P2：宿主/注入方是否支持「手动安装任意 spec」。
  bool get supportsManualInstall =>
      inspectSpec != null && installBySpec != null;

  /// 检查更新（有 `*At` 钩子时带源，否则退回无源版本）。
  Future<PluginVersionCheck> checkVersionsWith(
    String name, {
    String? registry,
  }) {
    final at = checkVersionsAt;
    if (at != null && (registry == null || registry.isEmpty)) {
      return at(name, null);
    }
    if (at != null) return at(name, registry);
    return checkVersions(name);
  }

  /// 安装（有 `*At` 钩子时带源，否则退回无源版本）。
  Future<PluginOperation> installWith(String name, {String? registry}) {
    final at = installAt;
    if (at != null) {
      return at(name, registry == null || registry.isEmpty ? null : registry);
    }
    return install(name);
  }

  /// 升级（有 `*At` 钩子时带源，否则退回无源版本）。
  Future<PluginOperation> upgradeWith(
    String name,
    String version, {
    String? registry,
  }) {
    final at = upgradeAt;
    if (at != null) {
      return at(name, version, registry == null || registry.isEmpty ? null : registry);
    }
    return upgrade(name, version);
  }
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
    // #153：安装源校验失败——明确归因，不静默换源。
    'registry-invalid' => L10n.t(
      '安装源地址无效：只接受 http(s) 地址，不接受凭据、查询参数、片段或本地路径',
      'Invalid registry URL: only http(s) addresses are accepted, without credentials, query or fragment',
    ),
    'plugin-inventory-unavailable' => L10n.t(
      '读取插件清单失败',
      'Could not read the plugin list',
    ),
    'management-required' => L10n.t(
      '插件管理所需，不能停用或卸载',
      'Required for plugin management; cannot be disabled or removed',
    ),
    'not-removable' || 'plugin-not-removable' => L10n.t(
      '当前插件不可卸载',
      'This plugin cannot be removed',
    ),
    'unaddressable' => L10n.t(
      '当前插件无法通过配置管理',
      'This plugin cannot be managed here',
    ),
    'stop-profile' => L10n.t(
      '需要先停止 profile',
      'The profile must be stopped first',
    ),
    'bundle-in-use' => L10n.t('插件正在使用中', 'The plugin is in use'),
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
  bool _restartPending = false;
  String? _restartError;

  /// #153：当前 Tab（`builtin`/`experimental`/`custom`；扁平降级时不使用）。
  String _tab = pluginCategoryOrder.first;

  /// 搜索只作用当前 Tab（本地过滤，不打服务端搜索）。
  final _searchController = TextEditingController();
  String _search = '';

  /// 默认不展示 HIDDEN 项（无插件页的 bundle）。
  bool _showHidden = false;

  PluginUpdateScanController? _scanner;
  PluginUpdateScan _scan = const PluginUpdateScan();

  PluginInventoryActions get _actions =>
      widget.actions ?? PluginInventoryActions.fromApi(widget.store.api);

  Future<PluginInventory> _load() =>
      (widget.loader ?? widget.store.api.pluginInventory)();

  @override
  void dispose() {
    _operationTimer?.cancel();
    _scanner?.cancel();
    _searchController.dispose();
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
    // issue #174：原判定用 `scale(14)`（缩放后的**像素值**，正常倍率下恒为 14）去比
    // 倍率 1.4，条件恒真 → 「宽屏保留文字按钮」的分支永远不会渲染，于是两个动作
    // 都是同等权重的纯图标。这里改成按**倍率**判断：390 正常字号才真的走宽屏分支。
    final compact =
        MediaQuery.sizeOf(context).width <= 340 ||
        MediaQuery.textScalerOf(context).scale(1) >= 1.4;
    final canScan = _inventory?.supported == true && !_scan.running;
    return Scaffold(
      appBar: AppBar(
        title: Text(
          L10n.t('插件', 'Plugins'),
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
        actions: [
          // issue #175 P2：手动安装任意 spec（包名 / Git / 电脑绝对路径 / tarball）。
          // 只在注入方支持时出现——旧宿主不支持时不给一个点了会失败的入口。
          if (_actions.supportsManualInstall)
            IconButton(
              key: const ValueKey('plugin-manual-install'),
              tooltip: L10n.t('手动安装（包名/地址/路径）', 'Install manually (name/URL/path)'),
              icon: const Icon(Icons.add_circle_outline, size: 20),
              onPressed: _loading ? null : _openManualInstall,
            ),
          // issue #174：两者原来的 `Icons.sync` / `Icons.refresh` 都是圆形循环箭头，
          // 形状几乎一样、权重也相同，分不出「查更新」和「刷清单」。
          // 现在：「检查全部更新」= `system_update_alt`（与详情页「检查更新」同图标）
          // 且带 tonal 底色（主要动作）；「刷新清单」= 纯图标 `refresh`（次要动作）。
          if (compact)
            IconButton.filledTonal(
              key: const ValueKey('plugin-check-all'),
              tooltip: L10n.t('检查全部更新', 'Check all for updates'),
              icon: _scan.running
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.system_update_alt, size: 20),
              onPressed: canScan ? _startScan : null,
            )
          else
            FilledButton.tonalIcon(
              key: const ValueKey('plugin-check-all'),
              onPressed: canScan ? _startScan : null,
              icon: _scan.running
                  ? const SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.system_update_alt, size: 16),
              label: Text(L10n.t('检查全部更新', 'Check updates')),
            ),
          IconButton(
            key: const ValueKey('plugin-refresh'),
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

  /// issue #175 P2：打开手动安装页（任意 spec）。安装成功后刷新清单与能力。
  ///
  /// 安装源选择、进度/取消/回滚都由该页承担；这里只负责在返回后对齐状态。
  Future<void> _openManualInstall() async {
    final actions = _actions;
    final inspect = actions.inspectSpec;
    final installBySpec = actions.installBySpec;
    if (inspect == null || installBySpec == null) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => PluginSpecInstallScreen(
          store: widget.store,
          inspect: (spec, {registry}) => inspect(spec, registry),
          onInstall: (spec, {registry}) => installBySpec(spec, registry),
          loadRegistries: actions.registries,
          poll: actions.poll,
          cancel: actions.cancel,
        ),
      ),
    );
    if (!mounted) return;
    // 与 #146/#153 一致：安装可能已改宿主状态，返回后对齐清单与能力。
    await _refresh();
    unawaited((widget.refreshAll ?? widget.store.refreshAll)());
  }

  /// 开始「检查全部更新」：只查 `canUpdate` 的行，Git 来源跳过、不创建任何宿主事务。
  void _startScan() {
    final inventory = _inventory;
    if (inventory == null) return;
    _scanner?.cancel();
    final controller = PluginUpdateScanController(
      checkVersions: _actions.checkVersionsWith,
      onUpdate: (scan) {
        if (!mounted) return;
        setState(() => _scan = scan);
      },
    );
    _scanner = controller;
    unawaited(controller.start(inventory));
  }

  void _cancelScan() {
    _scanner?.cancel();
    if (mounted) setState(() => _scan = _scanner?.scan ?? _scan.copyWith(running: false));
  }

  /// 单项重试：只在完成后的 banner 里点失败行触发；不创建宿主事务。
  void _rescanOne(String name) {
    final inventory = _inventory;
    final plugin = inventory?.plugins.where((p) => p.name == name).firstOrNull;
    if (plugin == null) return;
    unawaited(() async {
      PluginUpdateCheckResult result;
      try {
        final check = await _actions.checkVersionsWith(plugin.name);
        result = pluginScanResultOf(plugin, check);
      } catch (e) {
        final code = e is ApiException ? (e.code ?? '') : '';
        result = PluginUpdateCheckResult(
          name: plugin.name,
          state: 'failed',
          installed: plugin.version,
          errorCode: code.isEmpty ? 'check-failed' : code,
        );
      }
      if (!mounted) return;
      setState(() {
        _scan = _scan.copyWith(
          results: Map.unmodifiable({..._scan.results, plugin.name: result}),
        );
      });
    }());
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

  /// #153：安装先进入**安装源选择页**（三选一 + 手动 URL），由该页完成校验、安装与
  /// 进度/回滚/取消展示。
  ///
  /// 降级：宿主/注入方没有安装源信息（`actions.registries == null`，例如旧宿主或
  /// 只注入安装能力的调用方）时，回到原有的确认对话框——此时页面上唯一可选项就是
  /// 「宿主默认源」，多一次跳转没有信息增益。
  Future<void> _startInstall(PluginInstallable item) async {
    if (_actions.registries == null) {
      await _startInstallWithDialog(item);
      return;
    }
    final spec = item.version.isEmpty
        ? item.packageName
        : '${item.packageName}@${item.version}';
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => PluginInstallSourceScreen(
          packageName: item.packageName,
          displayName: item.displayName,
          packageSpec: spec,
          version: item.version,
          category: item.hasCategory ? item.category : null,
          restartHint: true,
          loadRegistries: _actions.registries,
          onInstall: (registry) =>
              _actions.installWith(item.name, registry: registry),
          poll: _actions.poll,
          cancel: _actions.cancel,
          // issue #175 P1：记住上次选择的源（只存手机本地，不写电脑端配置）。
          store: widget.store,
        ),
      ),
    );
    if (!mounted) return;
    // 返回后用一次刷新对齐版本/健康/能力（安装可能已改宿主状态）。
    await _refresh();
    unawaited((widget.refreshAll ?? widget.store.refreshAll)());
  }

  /// 无安装源信息时的确认框安装路径（保留 #146 的语义与文案）。
  Future<void> _startInstallWithDialog(PluginInstallable item) async {
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

  Future<void> _startUninstall(PluginInfo plugin) async {
    final current = plugin.current;
    final ok = await _confirm(
      title: L10n.t(
        '卸载「${plugin.displayName}」？',
        'Remove “${plugin.displayName}”?',
      ),
      body: current
          ? L10n.t(
              '这是当前手机连接所依赖的插件：卸载后手机将无法再连接此电脑，除非重新安装。\n'
                  '卸载由宿主事务执行；若失败请刷新清单核对是否留下半卸载。',
              'This is the plugin this phone connects through: removing it disconnects the phone until it is installed again.\n'
                  'The host performs the removal; if it fails, refresh to check for a partial removal.',
            )
          : L10n.t(
              '卸载后该插件提供的功能会消失；宿主事务失败时请刷新清单核对。',
              'The plugin\'s features disappear after removal; if the host transaction fails, refresh to verify.',
            ),
      confirmLabel: L10n.t('卸载', 'Remove'),
    );
    if (!ok) return;
    await _runAction(() => _actions.uninstall(plugin.name));
  }

  Future<void> _startToggle(PluginInfo plugin, bool enabled) async {
    if (!plugin.canToggle) return;
    if (plugin.current) {
      final ok = await _confirm(
        title: enabled
            ? L10n.t('启用当前连接插件？', 'Enable the current-connection plugin?')
            : L10n.t('停用当前连接插件？', 'Disable the current-connection plugin?'),
        body: L10n.t(
          '该插件是当前手机连接所依赖的插件：停用后手机将断开，直到重新启用或重启电脑端。',
          'This plugin carries the current phone connection: disabling it disconnects the phone until it is enabled again or the desktop restarts.',
        ),
        confirmLabel: enabled
            ? L10n.t('启用', 'Enable')
            : L10n.t('停用', 'Disable'),
      );
      if (!ok) return;
    }
    await _runAction(() => _actions.toggle(plugin.name, enabled));
  }

  Future<void> _restartHost() async {
    final ok = await _confirm(
      title: L10n.t('重启电脑端宿主？', 'Restart the desktop host?'),
      body: L10n.t(
        '重启期间手机将断开连接；页面会自动重连并刷新插件状态。',
        'The phone disconnects during the restart; the page reconnects and refreshes plugin state afterwards.',
      ),
      confirmLabel: L10n.t('重启', 'Restart'),
    );
    if (!ok) return;
    setState(() {
      _restartPending = true;
      _restartError = null;
    });
    try {
      final mode = await _actions.restartHost();
      if (!mounted) return;
      setState(() => _restartPending = false);
      // 重启已受理：SSE/连接看门狗会处理重连；这里只给明确反馈，不轮询进程。
      setState(
        () => _actionError = mode.isEmpty
            ? null
            : L10n.t(
                '正在重启电脑端（$mode），等待自动重连…',
                'Restarting the desktop ($mode); waiting to reconnect…',
              ),
      );
    } catch (e) {
      if (!mounted) return;
      final code = e is ApiException ? (e.code ?? '') : '';
      setState(() {
        _restartPending = false;
        _restartError = pluginOperationErrorText(code);
      });
    }
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
    // issue #174：清单重拉只改清单里的 `version`，scan 里旧结果的 `latest` 还在，
    // 行渲染同时看两者 → 升级成功后仍显示「可更新 vX」。
    // 这里**只**让该插件的扫描结果失效（其他插件的结果继续有效，不必重扫）：
    //   - 成功：版本/可更新状态确实变了；
    //   - 结果未知（outcomeUnknown）：可能已改，不能继续声称「可更新」。
    // 失败且已回滚/未变更时版本未变，保留原结果（不制造无谓的「未扫描」态）。
    if (operation.succeeded || operation.outcomeUnknown) {
      _invalidateScanResult(operation.name);
    }
    // 安装/升级成功或回滚后都重拉清单：版本/健康/能力以宿主为准。
    unawaited(_refresh());
    unawaited((widget.refreshAll ?? widget.store.refreshAll)());
  }

  /// issue #174：让单个插件的批量检查结果失效（同时作废其在飞结果）。
  void _invalidateScanResult(String name) {
    if (name.isEmpty) return;
    _scanner?.invalidate([name]);
    final next = _scan.withoutResult(name);
    if (identical(next, _scan)) return;
    setState(() => _scan = next);
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
    final partial = inventory.isPartial;
    // 三 Tab 只在宿主**每一行**都给了 category 时启用；否则退回原来的单列表。
    final categorized = inventory.hasCategories;
    final selectedTab = _tab;
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
              canCancel:
                  _operation!.action == 'install' ||
                  _operation!.action == 'update',
            ),
          if (_operation != null && !_operation!.running)
            _OperationResultBanner(
              operation: _operation!,
              restartSupported:
                  inventory.host.restartSupported && !_restartPending,
              onRestart: _restartHost,
              restartError: _restartError,
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
          if (categorized) ...[
            if (inventory.classificationMismatch)
              PluginClassificationNotice(classification: inventory.classification),
            const SizedBox(height: 12),
            PluginCategoryTabs(
              selected: selectedTab,
              counts: {
                for (final kind in pluginCategoryOrder)
                  kind: _tabVisiblePlugins(inventory, kind).length +
                      _tabVisibleInstallable(inventory, kind).length,
              },
              onSelect: _selectTab,
            ),
            const SizedBox(height: 10),
            _searchField(context, selectedTab),
            if (selectedTab == 'experimental')
              PluginExperimentalNotice(
                tableVersion: inventory.classification.tableVersion,
              ),
            if (_scan.running || _scan.results.isNotEmpty)
              PluginUpdateScanBanner(scan: _scan, onCancel: _cancelScan),
            _hiddenToggle(context, inventory),
            ..._tabContent(context, inventory, selectedTab),
          ] else ...[
            if (inventory.supported)
              const PluginCategoryUnavailableNotice(),
            _searchField(context, ''),
            if (_scan.running || _scan.results.isNotEmpty)
              PluginUpdateScanBanner(scan: _scan, onCancel: _cancelScan),
            _hiddenToggle(context, inventory),
            ..._flatContent(context, inventory),
          ],
          const SizedBox(height: 18),
          Text(
            L10n.t(
              '仅显示当前电脑上的插件。安装/升级只使用电脑端已配置的渠道（可在安装时选择本次来源）；失败会自动回滚。',
              'Only plugins on this computer are shown. Install/update use configured desktop sources '
                  '(the source can be chosen per installation); a failure rolls back automatically.',
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

  /// 某 Tab 下（过滤搜索/HIDDEN 后）的已安装行。
  List<PluginInfo> _tabVisiblePlugins(PluginInventory inventory, String kind) {
    final query = _search.trim().toLowerCase();
    return inventory
        .pluginsFor(kind, showHidden: _showHidden)
        .where((p) => _matchesQuery(p, query))
        .toList();
  }

  List<PluginInstallable> _tabVisibleInstallable(
    PluginInventory inventory,
    String kind,
  ) {
    final query = _search.trim().toLowerCase();
    return inventory
        .installableFor(kind, showHidden: _showHidden)
        .where((i) => _matchesInstallableQuery(i, query))
        .toList();
  }

  /// 本地搜索：标题/描述/包名（与 ADR 0037 的已安装搜索口径一致）。
  bool _matchesQuery(PluginInfo plugin, String query) {
    if (query.isEmpty) return true;
    final title = plugin.displayName.toLowerCase();
    final package = plugin.packageName.toLowerCase();
    final name = plugin.name.toLowerCase();
    return title.contains(query) || package.contains(query) || name.contains(query);
  }

  bool _matchesInstallableQuery(PluginInstallable item, String query) {
    if (query.isEmpty) return true;
    return item.displayName.toLowerCase().contains(query) ||
        item.packageName.toLowerCase().contains(query) ||
        item.name.toLowerCase().contains(query);
  }

  void _selectTab(String kind) {
    setState(() {
      _tab = kind;
      _search = '';
      _searchController.clear();
    });
  }

  Widget _searchField(BuildContext context, String kind) {
    return TextField(
      key: const ValueKey('plugin-search'),
      controller: _searchController,
      onChanged: (value) => setState(() => _search = value),
      decoration: InputDecoration(
        isDense: true,
        hintText: kind.isEmpty
            ? L10n.t('搜索插件', 'Search plugins')
            : pluginSearchHint(kind),
        prefixIcon: const Icon(Icons.search, size: 18),
        suffixIcon: _search.isEmpty
            ? null
            : IconButton(
                tooltip: L10n.t('清除搜索', 'Clear search'),
                icon: const Icon(Icons.close, size: 16),
                onPressed: () => setState(() {
                  _search = '';
                  _searchController.clear();
                }),
              ),
      ),
    );
  }

  Widget _hiddenToggle(BuildContext context, PluginInventory inventory) {
    final hiddenCount = inventory.plugins.where((p) => p.hidden).length;
    if (hiddenCount == 0) return const SizedBox.shrink();
    return Align(
      alignment: Alignment.centerLeft,
      child: PluginHiddenToggle(
        value: _showHidden,
        hiddenCount: hiddenCount,
        onChanged: (value) => setState(() => _showHidden = value),
      ),
    );
  }

  List<Widget> _tabContent(
    BuildContext context,
    PluginInventory inventory,
    String kind,
  ) {
    final plugins = _tabVisiblePlugins(inventory, kind);
    final installable = _tabVisibleInstallable(inventory, kind);
    final searching = _search.trim().isNotEmpty;
    final widgets = <Widget>[const SizedBox(height: 4)];
    if (plugins.isEmpty && installable.isEmpty) {
      widgets.add(
        _tabEmptyState(
          context,
          searching
              ? L10n.t('没有匹配的插件', 'No matching plugins')
              : pluginTabEmptyText(kind),
          searching: searching,
        ),
      );
      return widgets;
    }
    if (plugins.isEmpty) {
      if (!searching) {
        widgets.add(_tabEmptyState(context, pluginTabEmptyText(kind)));
      }
    } else {
      widgets.add(
        _SectionTitle(
          title: L10n.t('已安装', 'Installed'),
          count: plugins.length,
        ),
      );
      for (final plugin in plugins) {
        widgets.add(
          _PluginRow(
            plugin: plugin,
            actions: _actions,
            onUpgrade: _startUpgrade,
            onToggle: _startToggle,
            onUninstall: _startUninstall,
            scanResult: _scan.results[plugin.name],
            onRetryScan: _rescanOne,
          ),
        );
      }
    }
    if (installable.isNotEmpty) {
      widgets.add(const SizedBox(height: 18));
      widgets.add(
        _SectionTitle(
          title: L10n.t('可安装', 'Available'),
          count: installable.length,
        ),
      );
      for (final item in installable) {
        widgets.add(
          _InstallableRow(item: item, onInstall: () => _startInstall(item)),
        );
      }
    } else if (!searching && plugins.isNotEmpty) {
      widgets.add(const SizedBox(height: 10));
      widgets.add(
        Text(
          pluginTabNoInstallableText(kind),
          style: TextStyle(
            fontSize: 11.5,
            height: 1.4,
            color: DshColors.ink3(context),
          ),
        ),
      );
    }
    return widgets;
  }

  List<Widget> _flatContent(BuildContext context, PluginInventory inventory) {
    final query = _search.trim().toLowerCase();
    final plugins = inventory
        .visiblePlugins(showHidden: _showHidden)
        .where((p) => _matchesQuery(p, query))
        .toList();
    final installable = inventory.installable
        .where((i) => _showHidden || !i.hidden)
        .where((i) => _matchesInstallableQuery(i, query))
        .toList();
    final searching = query.isNotEmpty;
    final widgets = <Widget>[const SizedBox(height: 16)];
    if (plugins.isEmpty && installable.isEmpty && searching) {
      widgets.add(_tabEmptyState(context, L10n.t('没有匹配的插件', 'No matching plugins'), searching: true));
      return widgets;
    }
    widgets.add(
      _SectionTitle(
        title: inventory.hasCategories
            ? L10n.t('已安装插件', 'Installed plugins')
            : L10n.t('已安装（未分类）', 'Installed (unclassified)'),
        count: plugins.length,
      ),
    );
    if (plugins.isEmpty) {
      widgets.add(_EmptyState(onRetry: _refresh));
    } else {
      for (final plugin in plugins) {
        widgets.add(
          _PluginRow(
            plugin: plugin,
            actions: _actions,
            onUpgrade: _startUpgrade,
            onToggle: _startToggle,
            onUninstall: _startUninstall,
            scanResult: _scan.results[plugin.name],
            onRetryScan: _rescanOne,
          ),
        );
      }
    }
    if (installable.isNotEmpty) {
      widgets.add(const SizedBox(height: 18));
      widgets.add(
        _SectionTitle(
          title: L10n.t('可安装（配置渠道）', 'Available (configured source)'),
          count: installable.length,
        ),
      );
      for (final item in installable) {
        widgets.add(
          _InstallableRow(item: item, onInstall: () => _startInstall(item)),
        );
      }
    }
    return widgets;
  }

  Widget _tabEmptyState(
    BuildContext context,
    String text, {
    bool searching = false,
  }) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 26),
    child: Column(
      children: [
        Icon(
          searching ? Icons.search_off : Icons.extension_off_outlined,
          size: 26,
          color: DshColors.ink2(context),
        ),
        const SizedBox(height: 8),
        Text(
          text,
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 12.5, color: DshColors.ink3(context)),
        ),
        if (searching) ...[
          const SizedBox(height: 6),
          TextButton(
            onPressed: () => setState(() {
              _search = '';
              _searchController.clear();
            }),
            child: Text(L10n.t('清除搜索', 'Clear search')),
          ),
        ],
      ],
    ),
  );
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


class _OperationBanner extends StatelessWidget {
  final PluginOperation operation;
  final bool cancelPending;
  final VoidCallback onCancel;
  final bool canCancel;
  const _OperationBanner({
    required this.operation,
    required this.cancelPending,
    required this.onCancel,
    required this.canCancel,
  });

  @override
  Widget build(BuildContext context) {
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
                  switch (operation.action) {
                    'update' => L10n.t(
                      '正在升级 ${operation.name}…',
                      'Updating ${operation.name}…',
                    ),
                    'uninstall' => L10n.t(
                      '正在卸载 ${operation.name}…',
                      'Removing ${operation.name}…',
                    ),
                    'toggle' =>
                      operation.targetVersion == 'on'
                          ? L10n.t(
                              '正在启用 ${operation.name}…',
                              'Enabling ${operation.name}…',
                            )
                          : L10n.t(
                              '正在停用 ${operation.name}…',
                              'Disabling ${operation.name}…',
                            ),
                    _ => L10n.t(
                      '正在安装 ${operation.name}…',
                      'Installing ${operation.name}…',
                    ),
                  },
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              if (canCancel)
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
          pluginStepLabel(step.key),
          style: TextStyle(fontSize: 11, color: color),
        ),
      ],
    );
  }
}

class _OperationResultBanner extends StatelessWidget {
  final PluginOperation operation;
  final bool restartSupported;
  final VoidCallback onRestart;
  final String? restartError;
  final VoidCallback onDismiss;
  const _OperationResultBanner({
    required this.operation,
    required this.restartSupported,
    required this.onRestart,
    required this.restartError,
    required this.onDismiss,
  });

  String _message() {
    if (operation.wasCancelled) {
      return L10n.t('已取消，未留下半安装', 'Cancelled; no partial installation remains');
    }
    if (operation.succeeded) {
      final version = operation.version.isEmpty ? '' : ' v${operation.version}';
      final base = switch (operation.action) {
        'update' => L10n.t('升级完成$version', 'Updated$version'),
        'uninstall' => L10n.t(
          '已卸载 ${operation.name}',
          'Removed ${operation.name}',
        ),
        'toggle' =>
          operation.targetVersion == 'on'
              ? L10n.t('已启用 ${operation.name}', 'Enabled ${operation.name}')
              : L10n.t('已停用 ${operation.name}', 'Disabled ${operation.name}'),
        _ => L10n.t('安装完成$version', 'Installed$version'),
      };
      return operation.restartRequired
          ? L10n.t(
              '$base，需要重启电脑端宿主后生效（请在电脑端重启 DSH）',
              '$base; restart the desktop DSH host to apply it',
            )
          : base;
    }
    if (operation.outcomeUnknown) {
      return operation.action == 'uninstall'
          ? L10n.t(
              '卸载失败，是否留下半卸载未知；请刷新清单核对，必要时在电脑端检查',
              'Removal failed; a partial removal cannot be ruled out. Refresh and verify on the desktop.',
            )
          : L10n.t(
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
      return operation.action == 'toggle'
          ? L10n.t('启停失败，插件状态未变更', 'Toggle failed; plugin state is unchanged')
          : L10n.t(
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
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _message(),
                  style: TextStyle(
                    fontSize: 12,
                    height: 1.4,
                    color: DshColors.ink2(context),
                  ),
                ),
                if (operation.restartRequired && restartSupported)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: OutlinedButton(
                      onPressed: onRestart,
                      child: Text(L10n.t('重启电脑端', 'Restart desktop')),
                    ),
                  ),
                if (restartError != null)
                  Text(
                    restartError!,
                    style: TextStyle(
                      fontSize: 11.5,
                      color: DshColors.danger(context),
                    ),
                  ),
              ],
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

String pluginManagementReasonText(String code) {
  return switch (code.trim()) {
    '' || 'management-required' => L10n.t(
      '插件管理所需，不能停用或卸载',
      'Required for plugin management; cannot be disabled or removed',
    ),
    'not-removable' => L10n.t('当前插件不可卸载', 'This plugin cannot be removed'),
    'unaddressable' => L10n.t(
      '当前插件无法通过配置管理',
      'This plugin cannot be managed here',
    ),
    'entry-managed-desktop' => L10n.t(
      '独立配置条目请在电脑端管理',
      'Manage this standalone entry on the desktop',
    ),
    'permission' => L10n.t('没有写入权限', 'No write permission'),
    'stop-profile' => L10n.t(
      '需要先停止 profile',
      'The profile must be stopped first',
    ),
    'bundle-in-use' => L10n.t('插件正在使用中', 'The plugin is in use'),
    'stale-approval' => L10n.t('安装脚本授权已过期', 'Install approval has expired'),
    _ =>
      code.trim().isEmpty
          ? L10n.t('当前电脑端不支持该操作', 'This desktop does not support the operation')
          : code.trim(),
  };
}

class _PluginDetailSheet extends StatefulWidget {
  final PluginInfo plugin;
  final PluginInventoryActions actions;
  final Future<void> Function(PluginInfo plugin, PluginVersionInfo version)
  onUpgrade;
  final Future<void> Function(PluginInfo plugin, bool enabled) onToggle;
  final Future<void> Function(PluginInfo plugin) onUninstall;

  /// issue #174：列表侧「检查全部更新」已拿到的该插件结果（未扫描 → null）。
  /// 传进来后详情页直接显示升级入口，不必再点一次「检查更新」。
  final PluginUpdateCheckResult? scanResult;

  const _PluginDetailSheet({
    required this.plugin,
    required this.actions,
    required this.onUpgrade,
    required this.onToggle,
    required this.onUninstall,
    this.scanResult,
  });

  @override
  State<_PluginDetailSheet> createState() => _PluginDetailSheetState();
}

class _PluginDetailSheetState extends State<_PluginDetailSheet> {
  bool _checking = false;
  PluginVersionCheck? _check;

  /// 由列表结果回灌的初始检查（null = 该插件尚未被扫描过）。
  PluginVersionCheck? _scanSeeded;
  String? _error;

  @override
  void initState() {
    super.initState();
    _scanSeeded = pluginVersionCheckFromScan(widget.scanResult);
    _check = _scanSeeded;
  }

  /// 本次详情是否直接复用了列表侧结果（用于给用户一个来源提示）。
  bool get _reusedScan => _scanSeeded != null && identical(_check, _scanSeeded);

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
        Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    plugin.enabled
                        ? L10n.t('已启用', 'Enabled')
                        : L10n.t('已停用', 'Disabled'),
                    style: const TextStyle(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    plugin.canToggle
                        ? L10n.t(
                            '切换后由宿主事务生效',
                            'The host transaction applies the change',
                          )
                        : pluginManagementReasonText(plugin.toggleReasonCode),
                    style: TextStyle(
                      fontSize: 11.5,
                      color: plugin.canToggle
                          ? DshColors.ink3(context)
                          : DshColors.ink2(context),
                    ),
                  ),
                ],
              ),
            ),
            plugin.canToggle
                ? Semantics(
                    container: true,
                    toggled: plugin.enabled,
                    label: plugin.enabled
                        ? L10n.t(
                            '已启用 ${plugin.displayName}',
                            'Enabled ${plugin.displayName}',
                          )
                        : L10n.t(
                            '已停用 ${plugin.displayName}',
                            'Disabled ${plugin.displayName}',
                          ),
                    child: ExcludeSemantics(
                      child: DshSwitch(
                        value: plugin.enabled,
                        onChanged: (value) {
                          Navigator.of(context).pop();
                          unawaited(widget.onToggle(plugin, value));
                        },
                      ),
                    ),
                  )
                : Opacity(
                    opacity: 0.45,
                    child: IgnorePointer(
                      child: DshSwitch(
                        value: plugin.enabled,
                        onChanged: (_) {},
                      ),
                    ),
                  ),
          ],
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
            // issue #174：结果来自列表侧「检查全部更新」——直接给主按钮「升级到 vX」，
            // 不再列版本清单要求二次检查（列表只记一个 latest，本来也没有更多候选）。
            if (_reusedScan) ...[
              Align(
                alignment: Alignment.centerLeft,
                child: FilledButton.icon(
                  key: const ValueKey('plugin-detail-upgrade'),
                  onPressed: () {
                    final target = _check!.usableVersions.first;
                    Navigator.of(context).pop();
                    unawaited(widget.onUpgrade(plugin, target));
                  },
                  icon: const Icon(Icons.system_update_alt, size: 17),
                  label: Text(
                    L10n.t(
                      '升级到 v${_check!.usableVersions.first.version}',
                      'Update to v${_check!.usableVersions.first.version}',
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 2),
              Text(
                L10n.t(
                  '版本来自列表的「检查全部更新」，无需再次检查。',
                  'This version came from “Check all for updates”; no extra check needed.',
                ),
                style: TextStyle(fontSize: 11.5, color: DshColors.ink3(context)),
              ),
            ] else
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
            '仅使用电脑端已配置的渠道；失败由宿主事务处理；重启必须显式确认，绝不自动重启。',
            'Only configured desktop sources are used; the host handles failures; restarts require explicit confirmation and never happen automatically.',
          ),
          style: TextStyle(
            fontSize: 11.5,
            height: 1.4,
            color: DshColors.ink3(context),
          ),
        ),
        const SizedBox(height: 12),
        TextButton(
          onPressed: plugin.canUninstall
              ? () {
                  Navigator.of(context).pop();
                  unawaited(widget.onUninstall(plugin));
                }
              : null,
          style: TextButton.styleFrom(
            foregroundColor: DshColors.danger(context),
          ),
          child: Text(
            plugin.canUninstall
                ? L10n.t('卸载插件', 'Remove plugin')
                : L10n.t(
                    '不可卸载：${pluginManagementReasonText(plugin.toggleReasonCode)}',
                    'Cannot remove: ${pluginManagementReasonText(plugin.toggleReasonCode)}',
                  ),
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
  final Future<void> Function(PluginInfo plugin, bool enabled) onToggle;
  final Future<void> Function(PluginInfo plugin) onUninstall;

  /// #153：本行的「检查全部更新」结果（未检查 → null）。
  final PluginUpdateCheckResult? scanResult;
  final ValueChanged<String>? onRetryScan;

  const _PluginRow({
    required this.plugin,
    required this.actions,
    required this.onUpgrade,
    required this.onToggle,
    required this.onUninstall,
    this.scanResult,
    this.onRetryScan,
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
        onToggle: onToggle,
        onUninstall: onUninstall,
        // issue #174：把本行已知的扫描结果带进详情页，避免再检查一次。
        scanResult: scanResult,
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
    final categoryLabel = plugin.hasCategory
        ? plugin.category.displayLabel
        : '';
    final scanLabel = switch (scanResult?.state) {
      'available' => L10n.t('，可更新 v${scanResult!.latest}', '，v${scanResult!.latest} available'),
      'current' => L10n.t('，已是最新', '，up to date'),
      'skipped' => L10n.t('，跳过检查', '，check skipped'),
      'failed' => L10n.t('，检查失败', '，check failed'),
      _ => '',
    };
    final semantics =
        '$name，$versionLabel${categoryLabel.isEmpty ? '' : '，$categoryLabel'}，'
        '$statusLabel${plugin.current ? '，当前连接' : ''}$scanLabel';

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

    // #153：分类标签 + 检查结果标签（文字 + tone，不靠颜色区分）。
    final trailingTags = <Widget>[
      if (plugin.hasCategory) PluginCategoryTag(category: plugin.category),
      if (scanResult != null)
        PluginScanResultTag(
          result: scanResult!,
          compact: compact,
          onRetry: onRetryScan == null
              ? null
              : () => onRetryScan!.call(plugin.name),
        ),
    ];

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
                            ...trailingTags,
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
                      if (trailingTags.isNotEmpty) ...[
                        Wrap(
                          spacing: 4,
                          runSpacing: 2,
                          alignment: WrapAlignment.end,
                          children: trailingTags,
                        ),
                        const SizedBox(height: 4),
                      ],
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
