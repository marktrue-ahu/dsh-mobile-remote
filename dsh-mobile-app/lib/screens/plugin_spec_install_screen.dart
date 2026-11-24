// issue #175 P2：手动安装（任意 spec：npm 包名 / Git 地址 / 电脑上的绝对路径 / tarball）。
//
// 硬边界（与 docs/04-security.md 同步）：
//   - **App 不解析 spec**：形态、路径合法性、git/tarball 判定全部交宿主
//     `parseInstallSpec()` / `pluginManager.inspect()`。这里只做「非空 + 长度上限」
//     的即时反馈，权威判定仍在宿主（不因为客户端通过就跳过服务端 400）。
//   - **不上传、不浏览电脑文件系统**：本地路径只能手输，UI 明示「填电脑上的路径」。
//   - **不回显原始 spec**：界面只展示宿主解析出的包名/版本/来源；错误只显示人话。
//   - **不做 build scripts 授权**：遇到 build-blocked 只给「去电脑端授权」+ 指引，
//     **没有**任何批准按钮。
//   - 安装源选择复用 #175 P1 的 `PluginInstallSourceMemory`（同一份「记住上次选择」）。
import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../l10n.dart';
import '../plugin_install_source.dart';
import '../plugin_inventory.dart';
import '../store.dart';
import '../theme.dart';
import 'plugin_inventory_screen.dart' show pluginOperationErrorText;
import 'plugin_management_widgets.dart';

/// 一键填入的示例（语义对齐 DSH Web 的 `GUIDE_EXAMPLES`：给形态模板，不给真包名）。
///
/// 刻意**不用**真实包名：示例被一键填入后会真的装东西，用真实包会把示例变成推荐。
class PluginSpecExample {
  final String spec;
  const PluginSpecExample(this.spec);

  static const all = <PluginSpecExample>[
    // npm 包名（可带 @version）。
    PluginSpecExample('@scope/dsh-plugin-name'),
    // Git 仓库（GitHub 简写）。
    PluginSpecExample('github:owner/dsh-plugin'),
    // 电脑上的本地目录（**宿主绝对路径**；手机无法浏览电脑文件系统）。
    PluginSpecExample('/Users/name/my-dsh-plugin'),
    // tarball（http(s) 链接或宿主上的 .tgz 路径）。
    PluginSpecExample('https://example.com/dsh-plugin-1.0.0.tgz'),
  ];
}

/// 手动安装页（全屏路由；安装中显示与 #146/#153 相同的步骤/回滚/取消）。
class PluginSpecInstallScreen extends StatefulWidget {
  final Future<PluginSpecInspection> Function(String spec, {String? registry})
  inspect;
  final Future<PluginOperation> Function(String spec, {String? registry})
  onInstall;
  final Future<PluginRegistryList> Function()? loadRegistries;
  final Future<PluginOperation> Function(String opId)? poll;
  final Future<String> Function(String opId)? cancel;

  /// 本机偏好（记住上次选择的源）。`null` = 不记忆。
  final AppStore? store;

  const PluginSpecInstallScreen({
    super.key,
    required this.inspect,
    required this.onInstall,
    this.loadRegistries,
    this.poll,
    this.cancel,
    this.store,
  });

  @override
  State<PluginSpecInstallScreen> createState() =>
      _PluginSpecInstallScreenState();
}

class _PluginSpecInstallScreenState extends State<PluginSpecInstallScreen> {
  final _specController = TextEditingController();
  final _urlController = TextEditingController();

  PluginRegistryList? _registries;
  bool _loadingRegistries = false;
  String _selectedRegistryKey = pluginInstallSourceHost;
  bool _rememberManualUrl = false;
  late final PluginInstallSourceMemory _memory = PluginInstallSourceMemory();

  /// 最近一次预校验结果（null = 还没校验）。
  PluginSpecInspection? _inspection;

  /// 预校验/提交的错误（人话，不含 spec 原文）。
  String? _error;

  /// 输入形态错误（空 / 过长），在输入框下方即时显示。
  String? _inputError;

  bool _checking = false;
  PluginOperation? _operation;
  bool _cancelPending = false;

  @override
  void initState() {
    super.initState();
    _restoreSelection();
    _loadRegistries();
  }

  @override
  void dispose() {
    _specController.dispose();
    _urlController.dispose();
    super.dispose();
  }

  void _restoreSelection() {
    final store = widget.store;
    if (store != null) _memory.restore(store);
    _selectedRegistryKey = _memory.selectedKey;
    if (_memory.manualUrl.isNotEmpty) {
      _urlController.text = _memory.manualUrl;
      _rememberManualUrl = true;
    }
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
        _memory
          ..selectedKey = _selectedRegistryKey
          ..manualUrl = _urlController.text;
        _selectedRegistryKey = _memory.validate(list);
      });
    } catch (_) {
      if (!mounted) return;
      // 读取失败不阻断安装：退回「宿主默认源」。
      setState(() {
        _loadingRegistries = false;
        if (_selectedRegistryKey != pluginInstallSourceManual) {
          _selectedRegistryKey = pluginInstallSourceHost;
        }
      });
    }
  }

  Future<void> _rememberSelection(String key) async {
    _memory.selectedKey = key;
    await _memory.remember(widget.store, key);
  }

  Future<void> _syncManualMemory() async {
    _memory.manualUrl = _urlController.text;
    await _memory.syncManualMemory(widget.store, _rememberManualUrl);
  }

  /// 把当前 UI 的选源状态同步进共享记忆并取本次的 `registry` 参数。
  String? get _registryForThisInstall =>
      _syncMemoryFromUi().registryFor(_registries);

  String get _registryLabel => _syncMemoryFromUi().labelFor(_registries);

  PluginInstallSourceMemory _syncMemoryFromUi() => _memory
    ..selectedKey = _selectedRegistryKey
    ..manualUrl = _urlController.text;

  bool get _installing => _operation != null && _operation!.running;

  /// 输入形态的**即时**反馈（不含语义判断——那交宿主）。
  String? _validateInput(String raw) {
    final value = raw.trim();
    if (value.isEmpty) return L10n.t('请填写安装地址', 'Enter an install address');
    if (value.length > 2048) {
      return L10n.t('安装地址太长（上限 2048 字符）', 'The install address is too long (2048 max)');
    }
    if (RegExp(r'[\u0000-\u001f\u007f]').hasMatch(raw)) {
      return L10n.t('安装地址含控制字符', 'The install address contains control characters');
    }
    // 手动源若被选中，也要在提交前拦住非法 URL（避免一次无意义往返）。
    if (_selectedRegistryKey == pluginInstallSourceManual) {
      final urlError = pluginManualUrlError(_urlController.text);
      if (urlError.isNotEmpty) return urlError;
    }
    return null;
  }

  /// 第一步：预校验。通过后才让用户确认安装。
  Future<void> _inspect() async {
    final spec = _specController.text;
    final inputError = _validateInput(spec);
    if (inputError != null) {
      setState(() {
        _inputError = inputError;
        _inspection = null;
        _error = null;
      });
      return;
    }
    setState(() {
      _inputError = null;
      _error = null;
      _checking = true;
      _inspection = null;
    });
    try {
      final result = await widget.inspect(spec.trim(), registry: _registryForThisInstall);
      if (!mounted) return;
      setState(() {
        _inspection = result;
        _checking = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      final parsed = PluginSpecError.fromJson(e.body);
      setState(() {
        _checking = false;
        _error = parsed.text();
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _checking = false;
        _error = L10n.t('无法完成预校验，请重试。', 'Could not verify; retry.');
      });
    }
  }

  /// 第二步：显式确认（说明这会改动电脑端插件配置）。
  Future<void> _confirmAndInstall() async {
    final inspection = _inspection;
    final spec = _specController.text.trim();
    final target = inspection != null && inspection.accepted && inspection.name.isNotEmpty
        ? inspection.name
        : L10n.t('该安装地址', 'this install address');
    final version = inspection != null && inspection.accepted && inspection.version.isNotEmpty
        ? ' v${inspection.version}'
        : '';
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(L10n.t('安装到电脑端？', 'Install on the desktop?'), style: const TextStyle(fontSize: 16)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              L10n.t(
                '这会修改电脑端的插件配置（$target$version）。来源：$_registryLabel。\n'
                    '安装失败由电脑端事务自动回滚，不会留下半安装。',
                'This changes the desktop plugin configuration ($target$version). Source: $_registryLabel.\n'
                    'A failure rolls back automatically with no partial installation.',
              ),
              style: const TextStyle(fontSize: 13, height: 1.5),
            ),
            const SizedBox(height: 10),
            Text(
              L10n.t(
                '若该包含安装脚本，可能需要到电脑端授权（手机端不提供该授权）。',
                'If the package runs install scripts, approval may be needed on the desktop (not available here).',
              ),
              style: TextStyle(fontSize: 12, height: 1.4, color: DshColors.ink3(context)),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(L10n.t('取消', 'Cancel')),
          ),
          FilledButton(
            key: const ValueKey('spec-install-confirm'),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(L10n.t('安装', 'Install')),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() => _error = null);
    try {
      final operation = await widget.onInstall(spec, registry: _registryForThisInstall);
      if (!mounted) return;
      setState(() => _operation = operation);
      if (operation.running) _startPolling(operation.opId);
    } on ApiException catch (e) {
      if (!mounted) return;
      final parsed = PluginSpecError.fromJson(e.body);
      setState(() => _error = parsed.text());
    } catch (_) {
      if (!mounted) return;
      setState(() => _error = L10n.t('安装请求未能提交，请重试。', 'The install request could not be submitted; retry.'));
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
      // 取消失败不改变已显示的状态。
    } finally {
      if (mounted) setState(() => _cancelPending = false);
    }
  }

  void _fillExample(PluginSpecExample example) {
    setState(() {
      _specController.text = example.spec;
      _inspection = null;
      _error = null;
      _inputError = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(
          L10n.t('手动安装插件', 'Install a plugin manually'),
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
          children: [
            _inputCard(context),
            if (_inputError != null) ...[
              const SizedBox(height: 8),
              _errorText(context, _inputError!, key: const ValueKey('spec-input-error')),
            ],
            const SizedBox(height: 12),
            if (_inspection == null && !_checking && _operation == null) ...[
              FilledButton(
                key: const ValueKey('spec-inspect'),
                onPressed: _installing ? null : _inspect,
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                child: Text(L10n.t('检查并继续', 'Check and continue')),
              ),
            ],
            if (_checking) ...[
              Row(
                children: [
                  const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
                  const SizedBox(width: 8),
                  Text(L10n.t('正在向电脑端确认…', 'Checking with the desktop…'), style: const TextStyle(fontSize: 12.5)),
                ],
              ),
            ],
            if (_inspection != null) ...[
              _inspectionCard(context, _inspection!),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _checking || _installing ? null : _inspect,
                      child: Text(L10n.t('重新检查', 'Check again')),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: FilledButton(
                      key: const ValueKey('spec-install'),
                      // 拒绝时不允许继续；旧宿主（supported=false）允许直接装，
                      // 因为预校验能力不存在，不能把用户卡死。
                      onPressed: (_inspection!.accepted || !_inspection!.supported) && !_installing
                          ? _confirmAndInstall
                          : null,
                      child: Text(L10n.t('安装', 'Install')),
                    ),
                  ),
                ],
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 8),
              _errorText(context, _error!, key: const ValueKey('spec-error')),
            ],
            if (_operation != null) ...[
              const SizedBox(height: 14),
              _operationCard(context, _operation!),
            ],
            const SizedBox(height: 16),
            _registrySection(context),
            const SizedBox(height: 16),
            Text(
              L10n.t(
                '安装地址由电脑端宿主解析与校验；App 不解析路径、不上传文件、不浏览电脑目录。'
                    '本地目录必须填电脑上的绝对路径。',
                'The desktop host parses and validates the address; the app does not parse paths, '
                    'upload files, or browse the desktop. A local directory must be an absolute '
                    'path on the desktop.',
              ),
              style: TextStyle(fontSize: 11, height: 1.45, color: DshColors.ink3(context)),
            ),
          ],
        ),
      ),
    );
  }

  Widget _inputCard(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
      decoration: BoxDecoration(
        color: DshColors.surface(context),
        borderRadius: BorderRadius.circular(DshTheme.radiusMd),
        border: Border.all(color: DshColors.line(context)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            L10n.t('安装地址', 'Install address'),
            style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 8),
          TextField(
            key: const ValueKey('spec-input'),
            controller: _specController,
            enabled: !_installing,
            minLines: 1,
            maxLines: 3,
            autocorrect: false,
            enableSuggestions: false,
            decoration: InputDecoration(
              isDense: true,
              hintText: L10n.t('包名 / GitHub 地址 / 电脑上的绝对路径 / tarball 链接', 'Package / GitHub URL / desktop path / tarball'),
              border: const OutlineInputBorder(),
            ),
            onChanged: (_) => setState(() {
              _inspection = null;
              _error = null;
              _inputError = null;
            }),
          ),
          const SizedBox(height: 6),
          Text(
            L10n.t(
              '本地目录请填电脑上的绝对路径（如 /Users/name/my-plugin），不是手机的；手机无法浏览电脑文件。',
              'For a local directory use an absolute path on the desktop (e.g. /Users/name/my-plugin), '
                  'not on the phone; the phone cannot browse the desktop.',
            ),
            style: TextStyle(fontSize: 11, height: 1.4, color: DshColors.ink3(context)),
          ),
          const SizedBox(height: 10),
          Text(
            L10n.t('示例（点一下填入）', 'Examples (tap to fill)'),
            style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: DshColors.ink2(context)),
          ),
          const SizedBox(height: 6),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final example in PluginSpecExample.all)
                ActionChip(
                  key: ValueKey('spec-example-${example.spec}'),
                  label: Text(
                    example.spec,
                    style: const TextStyle(fontSize: 11, fontFamily: 'monospace'),
                  ),
                  onPressed: _installing ? null : () => _fillExample(example),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _inspectionCard(BuildContext context, PluginSpecInspection inspection) {
    if (!inspection.supported) {
      return Container(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
        decoration: BoxDecoration(
          color: DshColors.brandSoft(context),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: DshColors.line(context)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.info_outline, size: 16, color: DshColors.ink3(context)),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                L10n.t(
                  '当前电脑端不支持安装前预校验；仍可直接安装，完整校验由电脑端完成。',
                  'This desktop cannot verify before installing; you can still install and '
                      'the desktop will check it fully.',
                ),
                style: TextStyle(fontSize: 12, height: 1.4, color: DshColors.ink2(context)),
              ),
            ),
          ],
        ),
      );
    }
    if (inspection.refused) {
      return Container(
        key: const ValueKey('spec-refused'),
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
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
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    L10n.t('无法安装', 'Cannot install'),
                    style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: DshColors.danger(context)),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    inspection.problemText,
                    style: TextStyle(fontSize: 12, height: 1.45, color: DshColors.ink2(context)),
                  ),
                  if (inspection.reason.isNotEmpty) ...[
                    const SizedBox(height: 3),
                    Text(
                      inspection.reason,
                      style: TextStyle(fontSize: 11, color: DshColors.ink3(context)),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      );
    }
    return Container(
      key: const ValueKey('spec-accepted'),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 6),
      decoration: BoxDecoration(
        color: DshColors.surface(context),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: DshColors.line(context)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.check_circle_outline, size: 16, color: DshColors.ok(context)),
              const SizedBox(width: 6),
              Text(
                L10n.t('可以安装', 'Ready to install'),
                style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: DshColors.ok(context)),
              ),
            ],
          ),
          const SizedBox(height: 6),
          if (inspection.name.isNotEmpty)
            _fact(context, L10n.t('包名', 'Package'), inspection.name),
          if (inspection.version.isNotEmpty)
            _fact(context, L10n.t('版本', 'Version'), inspection.version),
          _fact(context, L10n.t('类型', 'Kind'), inspection.kindLabel),
          if (inspection.host.isNotEmpty) _fact(context, L10n.t('主机', 'Host'), inspection.host),
          if (inspection.description.isNotEmpty)
            _fact(context, L10n.t('说明', 'Description'), inspection.description),
          if (inspection.bundle == false)
            _fact(
              context,
              L10n.t('插件声明', 'Bundle'),
              L10n.t('未声明 dsh.bundle', 'No dsh.bundle declared'),
            ),
        ],
      ),
    );
  }

  Widget _fact(BuildContext context, String label, String value) => Padding(
    padding: const EdgeInsets.only(bottom: 5),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 64,
          child: Text(label, style: TextStyle(fontSize: 11.5, color: DshColors.ink3(context))),
        ),
        Expanded(
          child: Text(value, style: const TextStyle(fontSize: 12.5, height: 1.35)),
        ),
      ],
    ),
  );

  Widget _errorText(BuildContext context, String text, {Key? key}) => Container(
    key: key,
    padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
    decoration: BoxDecoration(
      color: DshColors.surface(context),
      borderRadius: BorderRadius.circular(8),
      border: Border.all(color: DshColors.danger(context).withValues(alpha: 0.45)),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(Icons.warning_amber_outlined, size: 15, color: DshColors.danger(context)),
        const SizedBox(width: 6),
        Expanded(
          child: Text(text, style: TextStyle(fontSize: 12, height: 1.45, color: DshColors.ink2(context))),
        ),
      ],
    ),
  );

  /// 进度/结果卡片：复用 #146/#153 的语义（步骤、回滚、取消、重启提示）。
  Widget _operationCard(BuildContext context, PluginOperation operation) {
    final running = operation.running;
    final failed = operation.failed;
    final ok = operation.succeeded;
    // #175 P2：build-blocked 是**唯一**需要用户去电脑端处理的失败类型。
    final buildBlocked = failed && operation.errorCode == 'build-blocked';
    final color = ok
        ? (operation.restartRequired ? DshColors.warn(context) : DshColors.ok(context))
        : failed
        ? DshColors.danger(context)
        : DshColors.brand(context);
    final title = running
        ? L10n.t('正在安装…', 'Installing…')
        : ok
        ? L10n.t(
            '安装完成${operation.version.isEmpty ? '' : ' v${operation.version}'}',
            'Installed${operation.version.isEmpty ? '' : ' v${operation.version}'}',
          )
        : operation.wasCancelled
        ? L10n.t('已取消，未留下半安装', 'Cancelled; no partial installation')
        : L10n.t('安装失败', 'Installation failed');
    return Container(
      key: const ValueKey('spec-operation'),
      padding: const EdgeInsets.fromLTRB(12, 10, 10, 10),
      decoration: BoxDecoration(
        color: DshColors.surface(context),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withValues(alpha: 0.5)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              if (running)
                const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
              else
                Icon(ok ? Icons.check_circle_outline : Icons.error_outline, size: 16, color: color),
              const SizedBox(width: 8),
              Expanded(
                child: Text(title, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: color)),
              ),
              if (running && widget.cancel != null)
                TextButton(
                  onPressed: _cancelPending ? null : _cancelOperation,
                  child: Text(L10n.t('取消', 'Cancel')),
                ),
            ],
          ),
          if (operation.steps.isNotEmpty) ...[
            const SizedBox(height: 6),
            Wrap(
              spacing: 6,
              runSpacing: 4,
              children: [
                for (final step in operation.steps)
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        switch (step.state) {
                          'done' => Icons.check_circle_outline,
                          'running' => Icons.radio_button_checked,
                          'failed' => Icons.error_outline,
                          'skipped' => Icons.remove_circle_outline,
                          _ => Icons.circle_outlined,
                        },
                        size: 12,
                        color: switch (step.state) {
                          'done' => DshColors.ok(context),
                          'running' => DshColors.brand(context),
                          'failed' => DshColors.danger(context),
                          _ => DshColors.ink3(context),
                        },
                      ),
                      const SizedBox(width: 3),
                      Text(pluginStepLabel(step.key), style: TextStyle(fontSize: 11, color: DshColors.ink3(context))),
                    ],
                  ),
              ],
            ),
          ],
          if (buildBlocked) ...[
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
              decoration: BoxDecoration(
                color: DshColors.brandSoft(context),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    L10n.t(
                      '需要在电脑端完成安装脚本授权',
                      'Install scripts must be approved on the desktop',
                    ),
                    style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    L10n.t(
                      '这个包包含安装脚本，pnpm 已拦截。安装脚本可以执行任意代码，'
                          '因此必须在能看到完整脚本的电脑端显式批准；手机端不提供该授权。',
                      'This package runs install scripts, which pnpm blocked. Install scripts can run '
                          'arbitrary code, so approval must happen on the desktop where the scripts are visible; '
                          'the phone cannot grant it.',
                    ),
                    style: TextStyle(fontSize: 11.5, height: 1.45, color: DshColors.ink2(context)),
                  ),
                  if (operation.pendingBuilds.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(
                      L10n.t(
                        '待授权：${operation.pendingBuilds.join('、')}',
                        'Awaiting approval: ${operation.pendingBuilds.join(', ')}',
                      ),
                      style: TextStyle(fontSize: 11.5, fontFamily: 'monospace', color: DshColors.ink3(context)),
                    ),
                  ],
                  const SizedBox(height: 4),
                  Text(
                    L10n.t(
                      '处理：在电脑端 DSH 设置 → 插件里重新安装并批准，或运行 dsh plugin install 后按提示批准。',
                      'To resolve: reinstall from DSH on the desktop (Settings → Plugins) and approve, '
                          'or run dsh plugin install there and approve when prompted.',
                    ),
                    style: TextStyle(fontSize: 11.5, height: 1.45, color: DshColors.ink3(context)),
                  ),
                ],
              ),
            ),
          ] else if (failed) ...[
            const SizedBox(height: 6),
            Text(
              operation.rolledBack
                  ? L10n.t('已自动回滚，未留下半安装。', 'Rolled back automatically; no partial installation.')
                  : pluginOperationErrorText(operation.errorCode),
              style: TextStyle(fontSize: 12, height: 1.45, color: DshColors.ink2(context)),
            ),
          ],
        ],
      ),
    );
  }

  Widget _registrySection(BuildContext context) {
    final entries = _registries?.registries ?? const <PluginRegistry>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          L10n.t('安装源（仅本次）', 'Source (this install only)'),
          style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: DshColors.ink2(context)),
        ),
        const SizedBox(height: 6),
        _registryOption(
          context,
          key: pluginInstallSourceHost,
          title: L10n.t('电脑端配置的源', 'Sources configured on the desktop'),
          subtitle: entries.isNotEmpty
              ? '${entries.first.displayLabel} · ${L10n.t('首选', 'preferred')}'
              : L10n.t('使用电脑端当前的解析顺序', 'Use the desktop resolution order'),
        ),
        for (final entry in entries.skip(1))
          _registryOption(
            context,
            key: entry.url,
            title: entry.roleLabel,
            subtitle: entry.displayLabel,
          ),
        _registryOption(
          context,
          key: pluginInstallSourceManual,
          title: L10n.t('手动 http(s) URL', 'Manual http(s) URL'),
          subtitle: L10n.t('仅本次生效，不写入电脑端配置', 'This install only; never written to the desktop'),
        ),
        if (_selectedRegistryKey == pluginInstallSourceManual) ...[
          const SizedBox(height: 4),
          TextField(
            key: const ValueKey('spec-manual-registry'),
            controller: _urlController,
            enabled: !_installing,
            decoration: InputDecoration(
              isDense: true,
              hintText: 'https://registry.npmjs.org/',
              border: const OutlineInputBorder(),
              errorText: _urlErrorForDisplay(),
            ),
            onChanged: (_) => setState(() {}),
          ),
          CheckboxListTile(
            key: const ValueKey('spec-registry-remember'),
            contentPadding: EdgeInsets.zero,
            dense: true,
            controlAffinity: ListTileControlAffinity.leading,
            value: _rememberManualUrl,
            onChanged: _installing
                ? null
                : (value) {
                    setState(() => _rememberManualUrl = value ?? false);
                    unawaited(_syncManualMemory());
                  },
            title: Text(
              L10n.t('记住此地址', 'Remember this address'),
              style: const TextStyle(fontSize: 12.5),
            ),
          ),
        ],
        if (_loadingRegistries)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              L10n.t('正在读取电脑端安装源…', 'Reading desktop sources…'),
              style: TextStyle(fontSize: 11.5, color: DshColors.ink3(context)),
            ),
          )
        else if (_registries != null && !_registries!.supported)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              L10n.t(
                '当前电脑端不提供安装源信息；仍可用它自己的默认源。',
                'This desktop does not report sources; its default source is still used.',
              ),
              style: TextStyle(fontSize: 11.5, color: DshColors.ink3(context)),
            ),
          ),
      ],
    );
  }

  String? _urlErrorForDisplay() {
    if (_selectedRegistryKey != pluginInstallSourceManual) return null;
    final raw = _urlController.text.trim();
    if (raw.isEmpty) return null;
    final error = pluginManualUrlError(raw);
    return error.isEmpty ? null : error;
  }

  Widget _registryOption(
    BuildContext context, {
    required String key,
    required String title,
    required String subtitle,
  }) {
    final selected = _selectedRegistryKey == key;
    final brand = DshColors.brand(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Semantics(
        selected: selected,
        inMutuallyExclusiveGroup: true,
        button: true,
        label: title,
        child: InkWell(
          key: ValueKey('spec-source-$key'),
          borderRadius: BorderRadius.circular(10),
          onTap: _installing
              ? null
              : () {
                  setState(() {
                    _selectedRegistryKey = key;
                    _error = null;
                  });
                  unawaited(_rememberSelection(key));
                },
          child: Container(
            constraints: const BoxConstraints(minHeight: 54),
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
            decoration: BoxDecoration(
              color: selected ? DshColors.brandSoft(context) : DshColors.surface(context),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: selected ? brand.withValues(alpha: 0.5) : DshColors.line(context)),
            ),
            child: Row(
              children: [
                Icon(
                  selected ? Icons.radio_button_checked : Icons.radio_button_unchecked,
                  size: 18,
                  color: selected ? brand : DshColors.ink3(context),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
                      ),
                      const SizedBox(height: 1),
                      Text(
                        subtitle,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 11, height: 1.3, color: DshColors.ink3(context)),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
