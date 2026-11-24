// issue #153：安装源选择页（三选一 + 手动 URL 仅本次生效 + 校验失败明确归因）。
//
// 边界（与宿主契约一致）：
//   - App 不能新增/删除电脑端 npm registry；这里只是“本次用哪个源解析”。
//   - 手动 URL 只影响本次安装，不写入电脑端配置、不记住。
//   - spec 仍由宿主清单决定：手动 URL **不能安装任意包**。
//   - 校验失败明确归因，绝不静默换源。
import 'dart:async';

import 'package:flutter/material.dart';

import '../l10n.dart';
import '../plugin_install_source.dart';
import '../plugin_inventory.dart';
import '../store.dart';
import '../theme.dart';
import 'plugin_inventory_screen.dart' show pluginOperationErrorText;
import 'plugin_management_widgets.dart';

/// 用户选择的安装源（`host` = 宿主默认/配置渠道；`manual` = 本次手动 URL）。
sealed class PluginRegistryChoice {
  const PluginRegistryChoice();

  /// 传给宿主 `registry` 参数；`null` 表示“用宿主自己的解析顺序”。
  String? get registry;

  String get label;

  static const host = PluginRegistryChoiceHost();
}

class PluginRegistryChoiceHost extends PluginRegistryChoice {
  const PluginRegistryChoiceHost();
  @override
  String? get registry => null;
  @override
  String get label => L10n.t('宿主配置渠道', 'Configured by the desktop');
}

class PluginRegistryChoiceKnown extends PluginRegistryChoice {
  final PluginRegistry entry;
  const PluginRegistryChoiceKnown(this.entry);
  @override
  String? get registry => entry.url;
  @override
  String get label => entry.displayLabel;
}

class PluginRegistryChoiceManual extends PluginRegistryChoice {
  final String url;
  const PluginRegistryChoiceManual(this.url);
  @override
  String? get registry => url;
  @override
  String get label => url;
}

/// 手动 URL 的客户端预校验。
///
/// 实现已下沉到 [pluginManualUrlError]（`lib/plugin_install_source.dart`），
/// 供 P1 的选源页与 P2 的手动 spec 安装页共用**同一份**判据；
/// 这里保留旧名字，既有调用方与测试无需改动。
String pluginRegistryUrlError(String raw) => pluginManualUrlError(raw);

/// 展示「将执行的安装」摘要（让用户看清 App 传了什么、宿主负责什么）。
class PluginInstallSummaryCard extends StatelessWidget {
  final String packageSpec;
  final String packageName;
  final String version;
  final PluginCategory? category;
  final String registryLabel;
  final bool restartHint;

  const PluginInstallSummaryCard({
    super.key,
    required this.packageSpec,
    required this.packageName,
    this.version = '',
    this.category,
    this.registryLabel = '',
    this.restartHint = false,
  });

  Widget _row(BuildContext context, String label, String value) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 44,
          child: Text(
            label,
            style: TextStyle(fontSize: 11.5, color: DshColors.ink3(context)),
          ),
        ),
        const SizedBox(width: 8),
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
    final target = category == null
        ? packageName
        : '$packageName · ${category!.displayLabel}';
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 6),
      decoration: BoxDecoration(
        color: DshColors.surface(context),
        borderRadius: BorderRadius.circular(DshTheme.radiusMd),
        border: Border.all(color: DshColors.line(context)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            L10n.t('将执行的安装', 'What will run'),
            style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 8),
          _row(context, L10n.t('包', 'Package'), packageSpec),
          _row(context, L10n.t('目标', 'Target'), target),
          if (registryLabel.isNotEmpty)
            _row(context, L10n.t('来源', 'Source'), registryLabel),
          _row(
            context,
            L10n.t('解析', 'Resolve'),
            L10n.t(
              '由电脑端宿主解析，App 不传任意 tarball / 本地路径',
              'The desktop host resolves it; the app sends no tarball or local path',
            ),
          ),
          _row(
            context,
            L10n.t('生效', 'Apply'),
            restartHint
                ? L10n.t('安装后需重启宿主', 'The host restarts after installation')
                : L10n.t('安装后按宿主事务生效', 'Applied by the host transaction'),
          ),
        ],
      ),
    );
  }
}

/// 安装源选择页（作为全屏路由打开，安装中显示步骤/回滚/取消）。
class PluginInstallSourceScreen extends StatefulWidget {
  final String packageName;
  final String displayName;
  final String packageSpec;
  final String version;
  final PluginCategory? category;
  final bool restartHint;
  final Future<PluginRegistryList> Function()? loadRegistries;
  final Future<PluginOperation> Function(String registry) onInstall;
  final Future<PluginOperation> Function(String opId)? poll;
  final Future<String> Function(String opId)? cancel;

  /// issue #175 P1：本机偏好（记住上次选择的源）。`null` = 不记忆
  /// （测试/独立用法；此时行为与 #153 完全一致，每次从「宿主默认源」开始）。
  final AppStore? store;

  const PluginInstallSourceScreen({
    super.key,
    required this.packageName,
    required this.displayName,
    required this.packageSpec,
    this.version = '',
    this.category,
    this.restartHint = false,
    this.loadRegistries,
    required this.onInstall,
    this.poll,
    this.cancel,
    this.store,
  });

  @override
  State<PluginInstallSourceScreen> createState() =>
      _PluginInstallSourceScreenState();
}

class _PluginInstallSourceScreenState extends State<PluginInstallSourceScreen> {
  PluginRegistryList? _registries;
  bool _loadingRegistries = false;
  String _selectedRegistryKey = 'host';
  final _urlController = TextEditingController();
  String? _urlError;
  String? _submitError;
  PluginOperation? _operation;
  bool _cancelPending = false;

  /// issue #175 P1/P2：选源「记住上次选择」的共享实现。
  /// P2 的手动 spec 安装页用同一份逻辑，避免两处语义漂移。
  late final PluginInstallSourceMemory _memory = PluginInstallSourceMemory();

  /// issue #175 P1：手动 URL 是否「记住此地址」（默认不记）。
  bool _rememberManualUrl = false;

  @override
  void initState() {
    super.initState();
    _restoreSelection();
    _loadRegistries();
  }

  /// issue #175 P1：用上次记住的选择作初始值（**失效则回退 `'host'`**）。
  ///
  /// 偏好存在 App 本地（`AppStore.pluginInstallSource` / `pluginManualRegistryUrl`），
  /// 不写电脑端配置。此时 registry 列表可能还没读回来，因此这里只做**字面**恢复，
  /// 有效性校验在 `_loadRegistries` 完成后进行。
  void _restoreSelection() {
    final store = widget.store;
    if (store != null) _memory.restore(store);
    _selectedRegistryKey = _memory.selectedKey;
    if (_memory.manualUrl.isNotEmpty) {
      _urlController.text = _memory.manualUrl;
      _rememberManualUrl = true;
    }
  }

  /// 记住当前选择（**切换时立即保存**，不等点安装；取消安装也不该丢）。
  Future<void> _rememberSelection(String key) async {
    _memory.selectedKey = key;
    await _memory.remember(widget.store, key);
  }

  /// 把手动 URL 的**勾选状态 + 输入内容**镜像到本机偏好。
  Future<void> _syncManualMemory() async {
    _memory.manualUrl = _urlController.text;
    await _memory.syncManualMemory(widget.store, _rememberManualUrl);
  }

  void _setRememberManual(bool remember) {
    setState(() => _rememberManualUrl = remember);
    unawaited(_syncManualMemory());
  }

  @override
  void dispose() {
    _urlController.dispose();
    super.dispose();
  }

  Future<void> _loadRegistries() async {
    final loader = widget.loadRegistries;
    if (loader == null) return;
    setState(() => _loadingRegistries = true);
    try {
      final list = await loader();
      if (!mounted) return;
      setState(() {
        _registries = list;
        _loadingRegistries = false;
        // issue #175 P1：存的值仍在宿主列表里才继续用它；否则回退「宿主默认源」。
        // 不崩、也不显示幽灵选项（列表里没有的 URL 根本不渲染）。
        _selectedRegistryKey = _validatedSelection(list);
      });
    } catch (_) {
      if (!mounted) return;
      // 读取失败不阻断安装：退回“宿主默认源”一项。
      setState(() {
        _loadingRegistries = false;
        // 列表读不到就无法校验存值，回退默认源比继续用一个无法证实的值安全。
        if (_selectedRegistryKey != 'manual') _selectedRegistryKey = 'host';
      });
    }
  }

  /// 校验存下的选择在当前宿主列表里仍然有效；无效则回退 `'host'`。
  ///
  /// 判定本身在 [PluginInstallSourceMemory.validate]（P1/P2 共用同一实现）；
  /// 这里只把当前 UI 状态同步进去。
  String _validatedSelection(PluginRegistryList list) {
    _memory
      ..selectedKey = _selectedRegistryKey
      ..manualUrl = _urlController.text;
    return _memory.validate(list);
  }

  bool get _installing => _operation != null && _operation!.running;

  PluginRegistryChoice get _choice {
    if (_selectedRegistryKey == 'manual') {
      return PluginRegistryChoiceManual(_urlController.text.trim());
    }
    if (_selectedRegistryKey == 'host') return PluginRegistryChoice.host;
    final list = _registries;
    if (list != null) {
      for (final entry in list.registries) {
        if (entry.url == _selectedRegistryKey) {
          return PluginRegistryChoiceKnown(entry);
        }
      }
    }
    return PluginRegistryChoice.host;
  }

  Future<void> _submit() async {
    final choice = _choice;
    if (choice is PluginRegistryChoiceManual) {
      final error = pluginRegistryUrlError(choice.url);
      if (error.isNotEmpty) {
        setState(() => _urlError = error);
        return;
      }
    }
    setState(() {
      _urlError = null;
      _submitError = null;
    });
    try {
      final operation = await widget.onInstall(choice.registry ?? '');
      if (!mounted) return;
      setState(() => _operation = operation);
      if (operation.running) _startPolling(operation.opId);
    } catch (e) {
      if (!mounted) return;
      final code = ApiExceptionLike.codeOf(e);
      setState(
        () => _submitError = code.isEmpty
            ? L10n.t('安装失败，请重试', 'Installation failed; retry')
            : pluginOperationErrorText(code),
      );
    }
  }

  void _startPolling(String opId) {
    final poll = widget.poll;
    if (poll == null) return;
    Future<void> tick() async {
      if (!mounted) return;
      final current = _operation;
      if (current == null || !current.running) return;
      try {
        final next = await poll(opId);
        if (!mounted) return;
        setState(() => _operation = next);
        if (next.running) {
          Future.delayed(const Duration(seconds: 1), tick);
        }
      } catch (_) {
        // 轮询失败不伪造结果：保持进行中，下一 tick 重试。
        if (mounted && (_operation?.running ?? false)) {
          Future.delayed(const Duration(seconds: 1), tick);
        }
      }
    }

    Future.delayed(const Duration(seconds: 1), tick);
  }

  Future<void> _cancelOperation() async {
    final operation = _operation;
    final cancel = widget.cancel;
    if (operation == null || !operation.running || _cancelPending) return;
    if (cancel == null) return;
    setState(() => _cancelPending = true);
    try {
      await cancel(operation.opId);
    } catch (_) {
      // 取消失败不改变已显示的状态；用户可以继续等待或关闭页面。
    } finally {
      if (mounted) setState(() => _cancelPending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(
          L10n.t('安装「${widget.displayName}」', 'Install “${widget.displayName}”'),
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
          children: [
            _packageCard(context),
            if (_operation != null) ...[
              const SizedBox(height: 12),
              _operationCard(context),
            ],
            const SizedBox(height: 16),
            Text(
              L10n.t('安装来源', 'Install source'),
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: DshColors.ink3(context),
              ),
            ),
            const SizedBox(height: 8),
            ..._registryOptions(context),
            const SizedBox(height: 16),
            PluginInstallSummaryCard(
              packageSpec: widget.packageSpec,
              packageName: widget.packageName,
              version: widget.version,
              category: widget.category,
              registryLabel: _choice.registry == null ? '' : _choice.label,
              restartHint: widget.restartHint,
            ),
            if (_submitError != null) ...[
              const SizedBox(height: 10),
              _error(context, _submitError!),
            ],
            const SizedBox(height: 10),
            Text(
              L10n.t(
                'App 不能新增或删除电脑端的 npm registry —— DSH 只提供只读 registries()。'
                    '来源校验失败会明确报错，不会静默换到别的源。',
                'The app cannot add or remove desktop npm registries — DSH only exposes a read-only '
                    'registries(). A source that fails validation is reported, never silently replaced.',
              ),
              style: TextStyle(
                fontSize: 11,
                height: 1.45,
                color: DshColors.ink3(context),
              ),
            ),
            const SizedBox(height: 14),
            FilledButton(
              key: const ValueKey('install-source-submit'),
              onPressed: _installing
                  ? null
                  : () {
                      if (_choice is PluginRegistryChoiceManual &&
                          pluginRegistryUrlError(_urlController.text.trim())
                              .isNotEmpty) {
                        setState(() => _urlError = '');
                        unawaited(_submit());
                        return;
                      }
                      unawaited(_submit());
                    },
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(48),
              ),
              child: Text(
                _installing
                    ? L10n.t('安装中…', 'Installing…')
                    : _urlError != null
                    ? L10n.t('修正来源后继续', 'Fix the source and continue')
                    : L10n.t('开始安装', 'Start installation'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _packageCard(BuildContext context) {
    final version = widget.version.isEmpty ? '' : 'v${widget.version}';
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
            width: 38,
            height: 38,
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
                Text(
                  widget.displayName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 14.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  '${widget.packageName}${version.isEmpty ? '' : ' · $version'}',
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
          if (widget.category != null) ...[
            const SizedBox(width: 8),
            PluginCategoryTag(category: widget.category!),
          ],
        ],
      ),
    );
  }

  List<Widget> _registryOptions(BuildContext context) {
    final list = _registries;
    final entries = list?.registries ?? const <PluginRegistry>[];
    final options = <Widget>[
      _option(
        context,
        key: 'host',
        title: L10n.t('宿主配置渠道', 'Configured by the desktop'),
        subtitle: entries.isNotEmpty
            ? '${entries.first.displayLabel} · ${L10n.t('首选', 'preferred')}'
            : L10n.t(
                '使用电脑端当前的解析顺序；不修改电脑端配置',
                'Use the desktop resolution order; nothing is changed',
              ),
        selected: _selectedRegistryKey == 'host',
      ),
      // 其余已知源（宿主回退镜像等）逐项列出；只读，不可增删。
      for (final entry in entries.skip(1))
        _option(
          context,
          key: entry.url,
          title: entry.roleLabel,
          subtitle: entry.displayLabel,
          selected: _selectedRegistryKey == entry.url,
        ),
      _option(
        context,
        key: 'manual',
        title: L10n.t('手动 http(s) URL', 'Manual http(s) URL'),
        subtitle: L10n.t(
          '仅本次安装生效；不写入电脑端配置，默认不记住',
          'Applies to this installation only; never written to the desktop, not remembered by default',
        ),
        selected: _selectedRegistryKey == 'manual',
      ),
    ];
    return [
      ...options,
      if (_selectedRegistryKey == 'manual') _manualUrlField(context),
      if (_loadingRegistries)
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text(
            L10n.t('正在读取电脑端安装源…', 'Reading desktop registries…'),
            style: TextStyle(
              fontSize: 11.5,
              color: DshColors.ink3(context),
            ),
          ),
        )
      else if (list != null && !list.supported)
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text(
            L10n.t(
              '当前电脑端不提供安装源信息；仍可用宿主默认源安装。',
              'This desktop does not report install sources; installation still uses its default source.',
            ),
            style: TextStyle(
              fontSize: 11.5,
              color: DshColors.ink3(context),
            ),
          ),
        ),
    ];
  }

  Widget _option(
    BuildContext context, {
    required String key,
    required String title,
    required String subtitle,
    required bool selected,
  }) {
    final brand = DshColors.brand(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Semantics(
        selected: selected,
        inMutuallyExclusiveGroup: true,
        button: true,
        label: title,
        child: InkWell(
          key: ValueKey('install-source-$key'),
          borderRadius: BorderRadius.circular(12),
          onTap: _installing
              ? null
              : () {
                  setState(() {
                    _selectedRegistryKey = key;
                    _submitError = null;
                  });
                  // issue #175 P1：**切换即保存**（不等点安装；取消安装也不该丢）。
                  unawaited(_rememberSelection(key));
                },
          child: Container(
            constraints: const BoxConstraints(minHeight: 64),
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
            decoration: BoxDecoration(
              color: selected ? DshColors.brandSoft(context) : DshColors.surface(context),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(
                color: selected ? brand.withValues(alpha: 0.5) : DshColors.line(context),
              ),
            ),
            child: Row(
              children: [
                Icon(
                  selected
                      ? Icons.radio_button_checked
                      : Icons.radio_button_unchecked,
                  size: 20,
                  color: selected ? brand : DshColors.ink3(context),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 13.5,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        subtitle,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 11.5,
                          height: 1.35,
                          color: DshColors.ink3(context),
                        ),
                      ),
                    ],
                  ),
                ),
                if (selected) ...[
                  const SizedBox(width: 6),
                  Text(
                    L10n.t('本次', 'This time'),
                    style: TextStyle(
                      fontSize: 10.5,
                      fontWeight: FontWeight.w600,
                      color: brand,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _manualUrlField(BuildContext context) {
    final store = widget.store;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            key: const ValueKey('install-source-url'),
            controller: _urlController,
            enabled: !_installing,
            keyboardType: TextInputType.url,
            autocorrect: false,
            decoration: InputDecoration(
              hintText: 'https://npm.example.com/',
              errorText: _urlError,
              prefixIcon: const Icon(Icons.link, size: 18),
              suffixIcon: _urlController.text.isEmpty
                  ? null
                  : IconButton(
                      tooltip: L10n.t('清空', 'Clear'),
                      icon: const Icon(Icons.close, size: 16),
                      onPressed: () => setState(() {
                        _urlController.clear();
                        _urlError = null;
                      }),
                    ),
            ),
            onChanged: (_) => setState(() {
              _urlError = null;
              // 勾选状态下地址改了：把记忆同步成新地址（清空/非法 ⇒ 清掉记忆，
              // 不留下一个下次会冒出来的旧地址）。
              if (_rememberManualUrl) unawaited(_syncManualMemory());
            }),
          ),
          // issue #175 P1：手动 URL **默认不记住**（可能是内网地址，长期留存不合适）。
          // 只有用户显式勾选才存到本机，并在文案里说清存到哪。
          if (store != null)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: InkWell(
                key: const ValueKey('install-source-remember'),
                borderRadius: BorderRadius.circular(8),
                onTap: _installing
                    ? null
                    : () => _setRememberManual(!_rememberManualUrl),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 4,
                    vertical: 6,
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SizedBox(
                        width: 20,
                        height: 20,
                        child: Checkbox(
                          value: _rememberManualUrl,
                          materialTapTargetSize:
                              MaterialTapTargetSize.shrinkWrap,
                          visualDensity: VisualDensity.compact,
                          onChanged: _installing
                              ? null
                              : (value) => _setRememberManual(value == true),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              L10n.t('记住此地址', 'Remember this address'),
                              style: const TextStyle(
                                fontSize: 12,
                                height: 1.3,
                              ),
                            ),
                            const SizedBox(height: 1),
                            Text(
                              L10n.t(
                                '地址会保存在本机（不写入电脑端配置）',
                                'Saved on this phone only, not on the desktop',
                              ),
                              style: TextStyle(
                                fontSize: 10.5,
                                height: 1.3,
                                color: DshColors.ink3(context),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _error(BuildContext context, String text) => Container(
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color: DshColors.surface(context),
      borderRadius: BorderRadius.circular(10),
      border: Border.all(color: DshColors.danger(context).withValues(alpha: 0.5)),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(Icons.error_outline, size: 16, color: DshColors.danger(context)),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            text,
            style: TextStyle(
              fontSize: 12,
              height: 1.4,
              color: DshColors.ink2(context),
            ),
          ),
        ),
      ],
    ),
  );

  Widget _operationCard(BuildContext context) {
    final operation = _operation!;
    final running = operation.running;
    final message = running
        ? L10n.t('正在安装…', 'Installing…')
        : operation.succeeded
        ? (operation.restartRequired
              ? L10n.t(
                  '安装完成，需重启电脑端宿主后生效',
                  'Installed; restart the desktop host to apply it',
                )
              : L10n.t('安装完成', 'Installed'))
        : operation.wasCancelled
        ? L10n.t('已取消，未留下半安装', 'Cancelled; no partial installation remains')
        : operation.rolledBack
        ? L10n.t('安装失败，已自动回滚', 'Installation failed; rolled back')
        : L10n.t('安装失败', 'Installation failed');
    final tone = running
        ? DshColors.brand(context)
        : operation.succeeded
        ? DshColors.ok(context)
        : DshColors.danger(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
      decoration: BoxDecoration(
        color: DshColors.surface(context),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: tone.withValues(alpha: 0.5)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              if (running)
                const SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              else
                Icon(
                  operation.succeeded
                      ? Icons.check_circle_outline
                      : Icons.error_outline,
                  size: 16,
                  color: tone,
                ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  message,
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              if (running && widget.cancel != null)
                TextButton(
                  onPressed: _cancelPending ? null : _cancelOperation,
                  child: Text(L10n.t('取消', 'Cancel')),
                ),
            ],
          ),
          if (operation.steps.isNotEmpty)
            Wrap(
              spacing: 8,
              runSpacing: 4,
              children: [
                for (final step in operation.steps)
                  Text(
                    '${pluginStepLabel(step.key)}·${pluginStepStateLabel(step.state)}',
                    style: TextStyle(
                      fontSize: 11,
                      color: switch (step.state) {
                        'done' => DshColors.ok(context),
                        'running' => DshColors.brand(context),
                        'failed' => DshColors.danger(context),
                        _ => DshColors.ink3(context),
                      },
                    ),
                  ),
              ],
            ),
          if (operation.answeredRegistry.isNotEmpty)
            Text(
              L10n.t(
                '来源：${operation.answeredRegistry}',
                'Source: ${operation.answeredRegistry}',
              ),
              style: TextStyle(
                fontSize: 11,
                color: DshColors.ink3(context),
              ),
            ),
        ],
      ),
    );
  }
}

/// 结果文案不需要知道具体异常类型：能取到稳定 code 就够（`ApiException.code`）。
abstract final class ApiExceptionLike {
  static String codeOf(Object error) {
    try {
      final code = (error as dynamic).code;
      if (code is String) return code.trim();
    } catch (_) {
      // 不是 ApiException：当作未知失败。
    }
    return '';
  }
}
