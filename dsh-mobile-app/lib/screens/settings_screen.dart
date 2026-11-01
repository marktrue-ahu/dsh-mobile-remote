// 设置页（对齐网页端 settings screen）：连接/默认配置/账户/显示/关于
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api.dart';
import '../floating.dart';
import '../l10n.dart';
import '../logger.dart';
import '../models.dart';
import '../plugin_update_resume.dart';
import '../plugin_update_log.dart';
import '../plugin_update_progress.dart';
import '../plugin_update_status.dart';
import '../store.dart';
import '../theme.dart';
import '../toast.dart';
import '../fmt.dart';
import '../update_core.dart';
import '../update_flow.dart';
import '../updater.dart';
import '../version_alignment.dart';
import 'sheets.dart';
import 'providers_screen.dart';
import 'usage_screen.dart';

/// 失败原因的稳定码 → 可读文案（未知码原样显示，绝不隐藏）。
String _pluginUpdateFailureReasonText(String reason) {
  const known = <String, String>{
    'npm-carrier-plugin-identity-mismatch': '载体清单与 NPM 包身份不一致（版本/大小校验失败）',
    'npm-carrier-manifest-unreadable': '载体清单不可读',
    'npm-carrier-extract-failed': '载体解包失败',
    'npm-plugin-tarball-sha256-mismatch': '插件 tarball 字节哈希与载体清单不一致',
    'npm-plugin-content-sha256-mismatch': '插件内容标识与载体清单不一致',
    'npm-packument-content-sha256-mismatch': 'NPM 包内容与载体清单不一致',
    'npm-packument-app-version-mismatch': 'NPM 包 App build 与载体清单不一致',
    'npm-pack-failed': '宿主机 npm pack 下载插件/载体失败',
    'npm-pack-integrity-mismatch': 'npm pack 产物完整性不符（registry 返回异常）',
    'npm-pack-metadata-mismatch': 'npm pack 返回的包版本/完整性不符',
    'npm-pack-tarball-missing': 'npm pack 产物缺失',
    'install-failed': 'pnpm 安装失败',
    'health-check-failed': '新插件健康检查失败，已回滚',
    'rollback-failed': '回滚失败，需要人工处理',
    'restart-unsupported': '宿主形态不支持自动重启',
  };
  return known[reason] != null ? '${known[reason]}（$reason）' : reason;
}

class _PluginUpdateDetailsPanel extends StatefulWidget {
  const _PluginUpdateDetailsPanel({
    super.key,
    required this.checkLines,
    required this.opId,
    required this.client,
    this.transaction,
  });
  final List<String> checkLines;
  final String opId;
  final Api client;
  final PluginTransaction? transaction;
  @override
  State<_PluginUpdateDetailsPanel> createState() =>
      _PluginUpdateDetailsPanelState();
}

class _PluginUpdateDetailsPanelState extends State<_PluginUpdateDetailsPanel> {
  Timer? _timer;
  int _cursor = 0;
  final List<PluginUpdateLogLine> _installLines = [];
  String _phase = '';
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    if (widget.opId.isNotEmpty) {
      _loading = true;
      _poll();
      _timer = Timer.periodic(const Duration(seconds: 3), (_) => _poll());
    }
  }

  Future<void> _poll() async {
    try {
      final data = await widget.client.pluginUpdateLog(
        opId: widget.opId,
        afterSeq: _cursor,
      );
      if (!mounted || !PluginUpdateLog.matchesOperation(data, widget.opId)) {
        return;
      }
      final page = PluginUpdateLog.fromJson(data);
      setState(() {
        _phase = page.phase;
        _installLines.addAll(page.lines.where((line) => line.seq > _cursor));
        if (page.cursor > _cursor) _cursor = page.cursor;
        if (_installLines.length > 400) {
          _installLines.removeRange(0, _installLines.length - 400);
        }
        _loading = false;
      });
      if (const {'settled', 'failed', 'rolled-back'}.contains(page.phase)) {
        _timer?.cancel();
        _timer = null;
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  String get _combinedText {
    final lines = <String>[...widget.checkLines];
    if (_installLines.isNotEmpty) {
      lines.add('# 安装详情（宿主 pnpm 输出，已脱敏）');
      lines.addAll(_installLines.map((line) => line.text));
    }
    final reason = widget.transaction?.reason ?? '';
    if (reason.isNotEmpty) {
      final phase = widget.transaction?.phase ?? 'failed';
      lines.add('# 安装结果：$phase · 原因：${_pluginUpdateFailureReasonText(reason)}');
    }
    return lines.join('\n');
  }

  @override
  Widget build(BuildContext context) {
    final text = _combinedText;
    final summary = widget.opId.isEmpty
        ? L10n.t('最近一次检查', 'Last check')
        : '${L10n.t('操作', 'Operation')}: ${widget.opId} · ${_phase.isEmpty ? L10n.t('等待日志', 'waiting for logs') : _phase}';
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          summary,
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 11, color: DshColors.ink3(context)),
        ),
        const SizedBox(height: 8),
        ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 360),
          child: SingleChildScrollView(
            child: SelectableText(
              text.isEmpty
                  ? (_loading
                        ? L10n.t('正在读取…', 'Loading…')
                        : L10n.t('（暂无更新详情）', '(No update details)'))
                  : text,
              style: TextStyle(
                fontSize: 11.5,
                height: 1.6,
                color: DshColors.ink(context),
                fontFamily: 'monospace',
              ),
            ),
          ),
        ),
        const SizedBox(height: 12),
        FilledButton.icon(
          onPressed: text.isEmpty ? null : () => _copy(text),
          icon: const Icon(Icons.copy),
          label: Text(L10n.t('复制', 'Copy')),
        ),
      ],
    );
  }

  Future<void> _copy(String text) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (mounted) showToast(context, L10n.t('已复制', 'Copied'));
  }
}

class SettingsScreen extends StatefulWidget {
  final AppStore store;
  final Future<void> Function() onReconfigure;
  const SettingsScreen({
    super.key,
    required this.store,
    required this.onReconfigure,
  });

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  UsageSnapshot? _usage;
  String? _usageError; // partial | outdated | failed；build 时再翻译
  bool _usageBusy = false; // 用量与额度刷新中
  bool _alertShown = false; // 本次会话内余额预警已提示过
  Map<String, dynamic>? _diag;
  bool _diagLoaded = false;
  String _diagTime = '';
  String _appVersion = ''; // App 自身版本（package_info_plus，构建时打包）
  bool _bubbleOn = false; // 悬浮球开关状态（与服务实际运行状态同步）
  bool _updateFlowBusy = false;

  // 插件更新进度：只在更新进行中轮询，终态后保留结果卡片。
  Timer? _progressTimer;
  String _progressOpId = '';
  String _progressStage = '';
  String _progressLine = '';
  int _progressCursor = 0;
  String _lastProgressPhase = '';

  @override
  void initState() {
    super.initState();
    _refreshUsage();
    _loadAppVersion();
    _initBubbleState();
    // 连接状态等 store 变化实时刷新（修复：旧版离开页面重进才能看到状态更新）
    widget.store.addListener(_onStoreChanged);
    _syncUpdateProgressWatcher();
  }

  Future<void> _initBubbleState() async {
    final on = await Floating.isRunning();
    final want = widget.store.floatingEnabled;
    final canOverlay = await Floating.canDrawOverlay();
    // v2.7.2：偏好是开但服务没跑（清理后台/重启后）→ 自动拉起，开关保持开
    if (want && !on && canOverlay) {
      await Floating.setPetConfig(
        height: widget.store.petHeight,
        reducedMotion: widget.store.petReducedMotion,
        edgeHide: widget.store.petEdgeHide,
      );
      await Floating.start();
      unawaited(
        Floating.setBalanceAlert(
          widget.store.balanceAlert,
          widget.store.balanceThreshold,
        ),
      );
    }
    // v2.7.2 review(M7)：权限被撤销时开关显示关（此前 want||on 会假开——球实际不在）
    if (mounted) setState(() => _bubbleOn = on || (want && canOverlay));
  }

  /// 桌面宠物开关：打开需悬浮窗权限（未授权 → 居中弹窗引导），关闭即停止服务。
  Future<void> _toggleBubble(bool v) async {
    if (v) {
      final ok = await Floating.canDrawOverlay();
      if (!ok) {
        if (!mounted) return;
        final go = await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: Text(L10n.t('需要悬浮窗权限', 'Overlay permission needed')),
            content: Text(
              L10n.t(
                '开启桌面宠物需要在系统设置中允许「显示在其他应用上层」。\n点击【去开启】跳转系统设置。',
                'The desktop pet needs the "display over other apps" permission.\nTap Open Settings to grant it.',
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(ctx).pop(false),
                child: Text(L10n.t('取消', 'Cancel')),
              ),
              FilledButton(
                onPressed: () => Navigator.of(ctx).pop(true),
                child: Text(L10n.t('去开启', 'Open Settings')),
              ),
            ],
          ),
        );
        if (go == true) {
          await Floating.openOverlaySettings();
        }
        return; // 授权后由用户重新打开开关（或重进页面状态同步）
      }
      try {
        await Floating.setPetConfig(
          height: widget.store.petHeight,
          reducedMotion: widget.store.petReducedMotion,
          edgeHide: widget.store.petEdgeHide,
        );
        await Floating.start();
      } catch (e) {
        if (mounted) {
          setState(() => _bubbleOn = false);
          showToast(context, '${L10n.t('桌面宠物启动失败：', 'Pet start failed: ')}$e');
        }
        return;
      }
      await widget.store.setFloatingEnabled(true); // v2.7.2：持久化开关（await 确保落盘）
      if (mounted) setState(() => _bubbleOn = true);
    } else {
      await Floating.stop();
      await widget.store.setFloatingEnabled(false); // v2.7.2：持久化开关
      if (mounted) setState(() => _bubbleOn = false);
    }
  }

  @override
  void dispose() {
    _progressTimer?.cancel();
    widget.store.removeListener(_onStoreChanged);
    super.dispose();
  }

  void _onStoreChanged() {
    _syncUpdateProgressWatcher();
    if (mounted) setState(() {});
  }

  /// 宿主事务或本地接续记录仍在进行时，每 2 秒刷新一次状态与最新日志。
  bool _updateInFlight() {
    final store = widget.store;
    final tx = store.api.pluginUpdate.transaction;
    if (tx != null &&
        !tx.rolledBack &&
        !const {'settled', 'failed', 'rolled-back'}.contains(tx.phase)) {
      return true;
    }
    final journal = store.pluginUpdateJournal;
    if (journal != null &&
        !journal.isPreparationPhase &&
        const {
          UpdatePhase.pluginPending,
          UpdatePhase.pluginConfirmed,
          UpdatePhase.appPending,
        }.contains(journal.phase)) {
      return true;
    }
    return false;
  }

  void _syncUpdateProgressWatcher() {
    final active = _updateInFlight();
    if (active && _progressTimer == null) {
      _progressTimer = Timer.periodic(
        const Duration(seconds: 2),
        (_) => unawaited(_pollUpdateProgress()),
      );
      unawaited(_pollUpdateProgress());
    } else if (!active && _progressTimer != null) {
      _progressTimer?.cancel();
      _progressTimer = null;
    }
  }

  Future<void> _pollUpdateProgress() async {
    if (!mounted) return;
    final store = widget.store;
    try {
      // 用完整 bootstrap（不是只吸收更新字段）：这样会触发 store 的接续回调，
      // 手机端由本次更新产生的 journal 能在卡片完成时同步推进，而不是等首页刷新。
      final data = await store.api.getJson('/api/bootstrap');
      store.api.absorbBootstrap(data);
    } catch (_) {
      // 宿主重启期间会短暂失败：保留旧状态，等下一次轮询。
    }
    final tx = store.api.pluginUpdate.transaction;
    final journal = store.pluginUpdateJournal;
    final opId = tx?.opId ?? journal?.opId ?? '';
    if (opId.isNotEmpty && opId != _progressOpId) {
      _progressOpId = opId;
      _progressCursor = 0;
      _progressStage = '';
      _progressLine = '';
      _lastProgressPhase = '';
    }
    if (opId.isNotEmpty) {
      try {
        final page = await store.api.pluginUpdateLog(
          opId: opId,
          afterSeq: _progressCursor,
        );
        if (PluginUpdateLog.matchesOperation(page, opId)) {
          final log = PluginUpdateLog.fromJson(page);
          if (log.cursor > _progressCursor) _progressCursor = log.cursor;
          if (log.lines.isNotEmpty) {
            final last = log.lines.last;
            if (last.stage.isNotEmpty) _progressStage = last.stage;
            if (last.text.isNotEmpty) _progressLine = last.text;
          }
        }
      } catch (_) {}
    }
    if (!mounted) return;
    _syncUpdateProgressWatcher();
    setState(() {});
    _announceProgressTransition(tx);
  }

  void _announceProgressTransition(PluginTransaction? tx) {
    if (tx == null) return;
    final previous = _lastProgressPhase;
    _lastProgressPhase = tx.phase;
    if (previous.isEmpty || previous == tx.phase) return;
    final progress = PluginUpdateProgressView.describe(
      phase: tx.phase,
      rolledBack: tx.rolledBack,
      resultOk: tx.resultOk,
    );
    if (!progress.terminal) return;
    if (progress.failed) {
      showToast(
        context,
        '${L10n.t('插件更新失败：', 'Plugin update failed: ')}${_pluginUpdateFailureReasonText(tx.reason ?? 'unknown')}',
      );
    } else {
      showToast(
        context,
        L10n.t(
          '插件更新完成（v${tx.targetVersion}）',
          'Plugin update completed (v${tx.targetVersion})',
        ),
      );
    }
  }

  static String _formatElapsed(Duration duration) {
    final seconds = duration.inSeconds.clamp(0, 86400);
    if (seconds < 60) return '${seconds}s';
    return '${seconds ~/ 60}m${seconds % 60}s';
  }

  /// 更新进度卡片：阶段时间线 + 当前阶段/用时 + 最新一行输出 + 失败原因。
  Widget _updateProgressCard(AppStore store) {
    final tx = store.api.pluginUpdate.transaction;
    final journal = store.pluginUpdateJournal;
    if (tx == null && journal == null) {
      // 只有检查结果（没有更新事务）：仍给一个可打开详情的紧凑卡片。
      final status = store.api.pluginUpdate;
      final brand = DshColors.brand(context);
      final ink3 = DshColors.ink3(context);
      final danger = DshColors.danger(context);
      final lineColor = DshColors.line(context);
      final upToDate = status.upToDate;
      final failureReason = upToDate
          ? ''
          : (status.reason.isEmpty
                ? '检查暂不可用'
                : _pluginUpdateFailureReasonText(status.reason));
      final detail = status.checkLog.isNotEmpty
          ? status.checkLog.last
          : failureReason;
      return Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: upToDate ? lineColor : danger, width: 1),
        ),
        child: Row(
          children: [
            Icon(
              upToDate ? Icons.check_circle_outline : Icons.error_outline,
              size: 16,
              color: upToDate ? brand : danger,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    upToDate ? '最近一次插件更新检查：已是最新' : '最近一次插件更新检查：不可用',
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                      color: upToDate ? null : danger,
                    ),
                  ),
                  if (detail.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        detail,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 10.5,
                          fontFamily: 'monospace',
                          color: upToDate ? ink3 : danger,
                        ),
                      ),
                    ),
                ],
              ),
            ),
            TextButton(
              onPressed: _openPluginUpdateDetails,
              child: Text(
                L10n.t('详情 ▸', 'Details ▸'),
                style: const TextStyle(fontSize: 12),
              ),
            ),
          ],
        ),
      );
    }
    final brand = DshColors.brand(context);
    final ink3 = DshColors.ink3(context);
    final danger = DshColors.danger(context);
    final lineColor = DshColors.line(context);

    PluginUpdateProgressView progress;
    String title;
    String? failureReason;
    DateTime? startedAt;
    String targetVersion = '';
    String appBuild = '';
    if (tx != null) {
      progress = PluginUpdateProgressView.describe(
        phase: tx.phase,
        rolledBack: tx.rolledBack,
        resultOk: tx.resultOk,
        logStage: _progressStage.isEmpty ? null : _progressStage,
      );
      startedAt = tx.startedAt;
      targetVersion = tx.targetVersion;
      appBuild = tx.targetAppVersion;
      if (progress.failed) {
        failureReason = _pluginUpdateFailureReasonText(tx.reason ?? 'unknown');
      }
      title = progress.terminal
          ? (progress.failed ? '最近一次插件更新：失败' : '最近一次插件更新：完成')
          : progress.stageText;
    } else {
      final phase = journal!.phase;
      if (phase == UpdatePhase.pluginPending) {
        progress = const PluginUpdateProgressView(
          step: 2,
          stageText: '等待电脑端确认并安装',
          terminal: false,
          failed: false,
        );
        title = '等待电脑端确认并安装';
      } else if (phase == UpdatePhase.pluginConfirmed) {
        progress = const PluginUpdateProgressView(
          step: 4,
          stageText: '插件已更新，正在确定 App 目标',
          terminal: false,
          failed: false,
        );
        title = '插件已更新，正在确定 App 目标';
      } else if (phase == UpdatePhase.appPending) {
        progress = const PluginUpdateProgressView(
          step: 5,
          stageText: '等待安装/核验 App',
          terminal: false,
          failed: false,
        );
        title = '等待安装/核验 App';
      } else if (phase == UpdatePhase.pluginRetry) {
        progress = const PluginUpdateProgressView(
          step: 4,
          stageText: '上次更新未确认',
          terminal: true,
          failed: true,
        );
        title = '上次更新未确认';
        failureReason = '可重试，或取消并重新检查';
      } else {
        progress = const PluginUpdateProgressView(
          step: 0,
          stageText: '准备中',
          terminal: false,
          failed: false,
        );
        title = '准备中';
      }
      startedAt = journal.startedAt;
      targetVersion = journal.targetVersion;
      appBuild = journal.appVersion;
    }
    final elapsed = startedAt == null
        ? ''
        : _formatElapsed(DateTime.now().toUtc().difference(startedAt));
    final detailLine = _progressLine.isNotEmpty
        ? _progressLine
        : (failureReason ?? progress.stageText);

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: progress.failed ? danger : lineColor,
          width: 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              if (progress.failed)
                Icon(Icons.error_outline, size: 16, color: danger)
              else if (progress.terminal)
                Icon(Icons.check_circle_outline, size: 16, color: brand)
              else
                SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  title,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: progress.failed ? danger : null,
                  ),
                ),
              ),
              if (elapsed.isNotEmpty)
                Text(elapsed, style: TextStyle(fontSize: 11, color: ink3)),
              TextButton(
                onPressed: _openPluginUpdateDetails,
                child: Text(
                  L10n.t('详情 ▸', 'Details ▸'),
                  style: const TextStyle(fontSize: 12),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          LinearProgressIndicator(
            value: progress.terminal ? 1 : (progress.step + 1) / 6,
            minHeight: 3,
            backgroundColor: lineColor,
            color: progress.failed ? danger : brand,
          ),
          const SizedBox(height: 6),
          Wrap(
            spacing: 8,
            runSpacing: 2,
            children: [
              for (var i = 0; i < PluginUpdateProgressView.steps.length; i++)
                Text(
                  '${i <= progress.step ? '●' : '○'} ${PluginUpdateProgressView.steps[i]}',
                  style: TextStyle(
                    fontSize: 10.5,
                    color: i <= progress.step
                        ? (progress.failed ? danger : brand)
                        : ink3,
                    fontWeight: i == progress.step
                        ? FontWeight.w700
                        : FontWeight.w400,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            detailLine,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 11,
              fontFamily: 'monospace',
              color: progress.failed ? danger : ink3,
            ),
          ),
          if (targetVersion.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                '目标：插件 v$targetVersion${appBuild.isEmpty ? '' : ' · App build $appBuild'}',
                style: TextStyle(fontSize: 11, color: ink3),
              ),
            ),
        ],
      ),
    );
  }

  Future<void> _loadAppVersion() async {
    try {
      final info = await PackageInfo.fromPlatform();
      if (!mounted) return;
      setState(() {
        _appVersion = '${info.version}+${info.buildNumber}';
      });
    } catch (_) {
      // 读取失败时版本行显示 App 端为「…」
    }
  }

  /// 手动切换连接地址（回家想切回局域网 / 出门想切蒲公英时用）。
  Future<void> _pickAddress() async {
    final candidates = api.baseUrls;
    if (candidates.isEmpty) return;
    final current = api.baseUrl;
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 14, 20, 6),
              child: Text(
                L10n.t('选择连接地址', 'Choose address'),
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
              ),
            ),
            // 候选地址随使用动态累积（局域网/组网/历史地址），列表区可滚动防溢出
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final c in candidates)
                    ListTile(
                      dense: true,
                      leading: Icon(
                        c == current
                            ? Icons.check_circle
                            : Icons.circle_outlined,
                        size: 18,
                        color: c == current
                            ? DshColors.brand(context)
                            : DshColors.ink3(context),
                      ),
                      title: Text(
                        c,
                        style: TextStyle(
                          fontSize: 13.5,
                          color: c == current ? DshColors.brand(context) : null,
                        ),
                      ),
                      onTap: () => Navigator.of(ctx).pop(c),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 6),
          ],
        ),
      ),
    );
    if (choice == null || choice == current || !mounted) return;
    final err = await widget.store.switchBase(choice);
    if (!mounted) return;
    if (err != null) {
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(
          SnackBar(
            content: Text(err),
            duration: const Duration(milliseconds: 2000),
            behavior: SnackBarBehavior.floating,
          ),
        );
    } else {
      showToast(context, L10n.t('已切换 → ', 'Switched to ') + choice);
    }
  }

  String _gitTabName(String id) => switch (id) {
    'branches' => L10n.t('分支', 'Branches'),
    'graph' => L10n.t('图谱', 'Graph'),
    'worktree' => L10n.t('工作区', 'Worktree'),
    _ => id,
  };

  String get _gitTabsSummary =>
      widget.store.gitTabs.map(_gitTabName).join(' · ');

  Future<void> _pickGitTabs() async {
    var selected = List<String>.of(widget.store.gitTabs);
    final result = await showDialog<List<String>>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: Text(L10n.t('Git 标签页', 'Git tabs')),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                L10n.t(
                  '选择 1–3 项并调整顺序；第一项为默认页。',
                  'Choose 1–3 tabs and reorder them; the first is the default.',
                ),
              ),
              const SizedBox(height: 8),
              for (final id in [
                ...selected,
                ...AppStore.gitTabIds.where((id) => !selected.contains(id)),
              ])
                Builder(
                  builder: (context) {
                    final isSelected = selected.contains(id);
                    final index = selected.indexOf(id);
                    return Semantics(
                      label: _gitTabName(id),
                      child: CheckboxListTile(
                        contentPadding: EdgeInsets.zero,
                        title: Text(_gitTabName(id)),
                        value: isSelected,
                        onChanged:
                            (isSelected && selected.length == 1) ||
                                (!isSelected && selected.length == 3)
                            ? null
                            : (value) {
                                if (value == true && selected.length < 3) {
                                  setDialogState(() => selected.add(id));
                                } else if (value == false &&
                                    selected.length > 1) {
                                  setDialogState(() => selected.remove(id));
                                }
                              },
                        secondary: isSelected
                            ? Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  IconButton(
                                    tooltip: L10n.t(
                                      '上移 ${_gitTabName(id)}',
                                      'Move ${_gitTabName(id)} up',
                                    ),
                                    onPressed: index > 0
                                        ? () => setDialogState(() {
                                            selected.removeAt(index);
                                            selected.insert(index - 1, id);
                                          })
                                        : null,
                                    icon: const Icon(Icons.arrow_upward),
                                  ),
                                  IconButton(
                                    tooltip: L10n.t(
                                      '下移 ${_gitTabName(id)}',
                                      'Move ${_gitTabName(id)} down',
                                    ),
                                    onPressed: index < selected.length - 1
                                        ? () => setDialogState(() {
                                            selected.removeAt(index);
                                            selected.insert(index + 1, id);
                                          })
                                        : null,
                                    icon: const Icon(Icons.arrow_downward),
                                  ),
                                ],
                              )
                            : null,
                      ),
                    );
                  },
                ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: Text(L10n.t('取消', 'Cancel')),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, selected),
              child: Text(L10n.t('保存', 'Save')),
            ),
          ],
        ),
      ),
    );
    if (result != null) await widget.store.setGitTabs(result);
  }

  Future<void> _refreshUsage() async {
    if (_usageBusy) return;
    setState(() {
      _usageBusy = true;
      _usageError = null;
    });
    try {
      final snapshot = await api.accountUsage();
      if (!mounted) return;
      final deepSeek = snapshot.sourceOf('deepseek');
      final total = deepSeek?.amountNumber;
      setState(() {
        _usage = snapshot;
        _usageError = snapshot.failedCount > 0 ? 'partial' : null;
      });
      // 余额联动悬浮球与预警仍只使用 DeepSeek 金额余额。
      if (total != null) unawaited(Floating.notifyBalance(total));
      if (widget.store.balanceAlert &&
          total != null &&
          total < widget.store.balanceThreshold &&
          !_alertShown) {
        _alertShown = true;
        showToast(
          context,
          L10n.t('余额不足 ¥', 'Low balance ¥') +
              total.toStringAsFixed(1) +
              L10n.t('，建议及时充值', ' — consider topping up'),
        );
      }
    } catch (e) {
      if (!mounted) return;
      final oldPlugin = e is ApiException && e.code == 'not-found';
      setState(() {
        // 保留最后一次成功快照，避免短暂网络失败把账户摘要清空。
        _usageError = oldPlugin ? 'outdated' : 'failed';
      });
    } finally {
      if (mounted) setState(() => _usageBusy = false);
    }
  }

  /// 阈值显示格式：整数不带小数（¥10），非整数两位（¥12.50）。
  String _fmtThreshold(double v) =>
      v == v.roundToDouble() ? v.round().toString() : v.toStringAsFixed(2);

  /// v3.1.2：发送测试通知——逐个通道验证（服务端绕过节流）。
  Future<void> _sendTestPush() async {
    try {
      final r = await api.pushTest();
      final results = (r['results'] as List? ?? []).whereType<Map>().toList();
      final okCount = results.where((e) => e['ok'] == true).length;
      if (mounted) {
        showToast(
          context,
          L10n.t(
            '测试通知已发送（$okCount/${results.length} 个通道成功）',
            'Test sent ($okCount/${results.length} channels OK)',
          ),
        );
      }
    } catch (e) {
      if (mounted) showToast(context, '${L10n.t('发送失败：', 'Send failed: ')}$e');
    }
  }

  /// 余额预警阈值选择：¥5 / ¥10 / ¥20 / ¥50 / 自定义输入。
  Future<void> _pickThreshold() async {
    final presets = [5.0, 10.0, 20.0, 50.0];
    final current = widget.store.balanceThreshold;
    final scheme = Theme.of(context);
    final brand = DshColors.brand(context);
    final selected = await showModalBottomSheet<double>(
      context: context,
      backgroundColor: scheme.scaffoldBackgroundColor,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 4),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  L10n.t('余额预警阈值', 'Low-balance threshold'),
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ),
            ...presets.map(
              (p) => ListTile(
                dense: true,
                title: Text(
                  '¥${_fmtThreshold(p)}',
                  style: const TextStyle(fontSize: 15),
                ),
                trailing: p == current
                    ? Icon(Icons.check, size: 18, color: brand)
                    : null,
                onTap: () => Navigator.of(ctx).pop(p),
              ),
            ),
            ListTile(
              dense: true,
              title: Text(
                L10n.t('自定义…', 'Custom…'),
                style: const TextStyle(fontSize: 15),
              ),
              onTap: () async {
                Navigator.of(ctx).pop();
                final ctrl = TextEditingController(
                  text: current == current.roundToDouble()
                      ? current.round().toString()
                      : current.toStringAsFixed(2),
                );
                final v = await showDialog<String>(
                  context: context,
                  builder: (dctx) => AlertDialog(
                    title: Text(
                      L10n.t('自定义阈值（元）', 'Custom threshold (¥)'),
                      style: const TextStyle(fontSize: 16),
                    ),
                    content: TextField(
                      controller: ctrl,
                      autofocus: true,
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                      ),
                      decoration: const InputDecoration(hintText: '10'),
                    ),
                    actions: [
                      TextButton(
                        onPressed: () => Navigator.of(dctx).pop(),
                        child: Text(L10n.t('取消', 'Cancel')),
                      ),
                      TextButton(
                        onPressed: () => Navigator.of(dctx).pop(ctrl.text),
                        child: Text(
                          L10n.t('确定', 'OK'),
                          style: TextStyle(color: brand),
                        ),
                      ),
                    ],
                  ),
                );
                if (v != null && v.trim().isNotEmpty) {
                  final parsed = double.tryParse(v.trim());
                  if (parsed != null && parsed > 0) {
                    await widget.store.setBalanceThreshold(parsed);
                    if (mounted) {
                      showToast(
                        context,
                        L10n.t('阈值已设为 ¥', 'Threshold set to ¥') +
                            _fmtThreshold(parsed),
                      );
                    }
                  } else if (mounted) {
                    showToast(
                      context,
                      L10n.t('请输入大于 0 的金额', 'Enter an amount greater than 0'),
                    );
                  }
                }
              },
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (selected != null) {
      await widget.store.setBalanceThreshold(selected);
    }
  }

  bool get _deepSeekLow =>
      widget.store.balanceAlert &&
      ((_usage?.sourceOf('deepseek')?.amountNumber ?? double.infinity) <
          widget.store.balanceThreshold);

  String? get _usageErrorText => switch (_usageError) {
    'partial' => L10n.t('部分额度来源刷新失败', 'Some usage sources failed to refresh'),
    'outdated' => L10n.t('电脑端插件版本过旧', 'Desktop plugin is outdated'),
    'failed' => L10n.t('额度查询失败', 'Usage query failed'),
    _ => null,
  };

  /// 用量与额度摘要（build 时求值：语言切换后即时换语言）。
  String get _usageLabel {
    if (_usageBusy && _usage == null) return L10n.t('查询中…', 'Loading…');
    if (_usageErrorText != null) return _usageErrorText!;
    final sources = _usage?.sources;
    if (sources == null) return L10n.t('尚未查询', 'Not queried yet');
    final count = sources.where((source) => source.available).length;
    if (count == 0) return L10n.t('暂无可用额度来源', 'No usage sources');
    return L10n.t(
      '$count 个来源可用',
      '$count source${count == 1 ? '' : 's'} available',
    );
  }

  Future<void> _openUsage() async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => UsageScreen(store: widget.store, initial: _usage),
      ),
    );
    if (mounted) unawaited(_refreshUsage());
  }

  Future<void> _loadDiag() async {
    try {
      final d = await api.diagnostics();
      if (!mounted) return;
      final now = DateTime.now();
      setState(() {
        _diag = d;
        _diagLoaded = true;
        _diagTime =
            '${now.hour.toString().padLeft(2, '0')}:${now.minute.toString().padLeft(2, '0')}:${now.second.toString().padLeft(2, '0')}';
      });
    } catch (e) {
      // 刷新失败：清空旧数据，明确显示「检测失败」而非静默展示过期结果
      if (!mounted) return;
      setState(() {
        _diag = null;
        _diagTime = '';
      });
      AppLog.instance.log('环境诊断失败: $e');
    }
  }

  String get _diagText {
    final d = _diag;
    if (d == null) return L10n.t('检测失败', 'Check failed');
    final buf = StringBuffer();
    final runtime = d['runtime'] as Map<String, dynamic>? ?? {};
    final form = runtime['form'];
    final formText = form == 'desktop'
        ? 'desktop · ${L10n.t('桌面版', 'DSH Desktop')}'
        : form == 'cli'
        ? 'cli · ${L10n.t('命令行/网页', 'CLI / Web')}'
        : '${form ?? '?'}';
    buf.writeln(
      '${L10n.t('运行形态: ', 'Mode: ')}$formText${runtime['authEnabled'] == true ? L10n.t(' · 口令已启用', ' · auth on') : L10n.t(' · 口令未启用', ' · auth off')}',
    );
    buf.writeln(
      '${L10n.t('监听: ', 'Listen: ')}${runtime['host']}:${runtime['port']}',
    );
    buf.writeln('${L10n.t('进程目录: ', 'CWD: ')}${runtime['cwd']}');
    final metrics = runtime['metrics'] as Map<String, dynamic>?;
    if (metrics != null && metrics.isNotEmpty) {
      buf.writeln();
      buf.writeln(L10n.t('实时指标:', 'Live metrics:'));
      metrics.forEach((k, v) {
        final n = _metricsName(k);
        buf.writeln('  • $n（$k）= $v');
      });
    }
    buf.writeln();
    final services = d['services'] as Map<String, dynamic>? ?? {};
    buf.writeln(L10n.t('服务:', 'Services:'));
    services.forEach((k, v) {
      final n = _diagName('services', k);
      buf.writeln('  ${v == true ? '✅' : '❌'} ${k == n ? n : '$n ($k)'}');
    });
    buf.writeln();
    final checks = d['checks'] as Map<String, dynamic>? ?? {};
    buf.writeln(L10n.t('端点实测:', 'Endpoint checks:'));
    checks.forEach((k, v) {
      final n = _diagName('checks', k);
      final shown = k == n ? n : '$n ($k)';
      if (k == 'approvalMode') {
        // v3.1.3：审批策略取值说明（both 双端同卡 / mobile 手机独占 / desktop 仅桌面）
        final m = v == 'both'
            ? L10n.t('both · 双端同卡，先答生效', 'both · both ends, first answer wins')
            : v == 'mobile'
            ? L10n.t('mobile · 手机在线独占', 'mobile · phone-exclusive while online')
            : v == 'desktop'
            ? L10n.t('desktop · 仅桌面 GUI', 'desktop · desktop GUI only')
            : '${v ?? '?'}';
        buf.writeln('  ℹ $shown：$m');
      } else if (v == true) {
        buf.writeln('  ✅ $shown');
      } else if (v == false) {
        buf.writeln('  ❌ $shown');
      } else if (v is num) {
        // 计数字段（如 pendingFrames 挂起待答数）：0 正常，>0 表示有问询/审批待处理
        buf.writeln(
          '  ${v == 0 ? '✅' : '⚠'} $shown = $v${v == 0 ? '' : L10n.t('（有审批/问询待处理）', ' (approval/question pending)')}',
        );
      } else {
        // v3.1.3（issue #9）：策略/状态字符串字段（如 approvalMode = both）友好直读
        buf.writeln('  ℹ $shown = $v');
      }
    });
    final notes = d['notes'] as List? ?? [];
    if (notes.isNotEmpty) {
      buf.writeln();
      buf.writeln(L10n.t('备注:', 'Notes:'));
      for (final n in notes) {
        buf.writeln('  • $n');
      }
    }
    final plugin = d['plugin'] as Map<String, dynamic>? ?? {};
    buf.writeln();
    buf.writeln(
      '${L10n.t('插件: ', 'Plugin: ')}${plugin['name']} v${plugin['version']}',
    );
    return buf.toString();
  }

  /// 实时指标中文名（v3.1.3 runtime.metrics）。未知 key 原样返回。
  String _metricsName(String key) {
    switch (key) {
      case 'mobileOnline':
        return L10n.t('手机在线连接', 'Phone connections');
      case 'agents':
        return L10n.t('运行中 Agent', 'Live agents');
      case 'sessions':
        return L10n.t('会话数', 'Sessions');
      case 'workspaces':
        return L10n.t('工作区数', 'Workspaces');
      case 'pushChannels':
        return L10n.t('推送通道', 'Push channels');
      default:
        return key;
    }
  }

  /// 服务/实测项中文名（环境诊断可读化，v3.1.3+）。未知 key 原样返回。
  /// 渲染时保留英文 key 便于复制粘贴排障（issue/日志对照）。
  String _diagName(String section, String key) {
    switch (section) {
      case 'services':
        switch (key) {
          case 'webServer':
            return L10n.t('网页服务', 'Web server');
          case 'agents':
            return L10n.t('Agent 服务', 'Agents');
          case 'sessions':
            return L10n.t('会话服务', 'Sessions');
          case 'llm':
            return L10n.t('模型服务', 'LLM');
          case 'permissionPresets':
            return L10n.t('权限预设', 'Permission presets');
          case 'agentPresets':
            return L10n.t('Agent 预设', 'Agent presets');
          case 'workspaceRegistry':
            return L10n.t('工作区服务', 'Workspaces');
          case 'approval':
            return L10n.t('审批服务', 'Approval');
          case 'credentials':
            return L10n.t('凭据服务', 'Credentials');
          case 'messageFeedback':
            return L10n.t('消息反馈', 'Message feedback');
          case 'userQuestions':
            return L10n.t('问询服务', 'Questions');
          case 'apiProxy':
            return L10n.t(
              '旧帧桥 apiProxy（0.1.1 内核）',
              'Legacy apiProxy (0.1.1 kernel)',
            );
          default:
            return key;
        }
      default:
        switch (key) {
          case 'modelsRpc':
            return L10n.t('模型目录 RPC', 'Model catalog RPC');
          case 'sessionsList':
            return L10n.t('会话列表', 'Session list');
          case 'directories':
            return L10n.t('目录浏览', 'Directory browse');
          case 'workspaces':
            return L10n.t('工作区列表', 'Workspace list');
          case 'notifications':
            return L10n.t('通知中心', 'Notifications');
          case 'actions':
            return L10n.t('动作区', 'Actions');
          case 'approvalMode':
            return L10n.t('审批策略', 'Approval mode');
          case 'remoteEvents':
            return L10n.t('双端审批通道', 'Dual-end channel');
          case 'respondBridge':
            return L10n.t('旧帧桥应答（0.1.1 内核）', 'Legacy respond (0.1.1 kernel)');
          case 'frameBridge':
            return L10n.t(
              '旧帧桥循环（0.1.1 内核）',
              'Legacy frame loop (0.1.1 kernel)',
            );
          case 'pendingFrames':
            return L10n.t('挂起待答', 'Pending frames');
          default:
            return key;
        }
    }
  }

  Widget _card(String title, List<Widget> children) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: DshColors.surface(context),
        borderRadius: BorderRadius.circular(DshTheme.radiusMd),
        boxShadow: Theme.of(context).brightness == Brightness.dark
            ? DshTheme.shadowDark
            : DshTheme.shadow,
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 6, 16, 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 10, bottom: 2),
              child: Text(
                title.toUpperCase(),
                style: TextStyle(
                  fontSize: 11.5,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.5,
                  color: DshColors.ink3(context),
                ),
              ),
            ),
            ...children,
          ],
        ),
      ),
    );
  }

  Widget _row({
    required Widget leading,
    required String title,
    String? sub,
    Widget? trailing,
    VoidCallback? onTap,
  }) {
    final ink3 = DshColors.ink3(context);
    final line = DshColors.line(context);
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 12),
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: line, width: 1)),
        ),
        child: Row(
          children: [
            Icon(
              leading is Icon ? leading.icon : Icons.circle,
              size: 15,
              color: ink3,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: const TextStyle(fontSize: 14)),
                  if (sub != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 1),
                      child: Text(
                        sub,
                        style: TextStyle(fontSize: 11, color: ink3),
                      ),
                    ),
                ],
              ),
            ),
            if (trailing != null) ...[trailing],
            if (onTap != null) Icon(Icons.chevron_right, size: 16, color: ink3),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final store = widget.store;
    final ink3 = DshColors.ink3(context);
    final brand = DshColors.brand(context);
    final danger = DshColors.danger(context);
    final ok = DshColors.ok(context);
    final warn = DshColors.warn(context);

    String permName(String? id) => permNameOf(id) ?? '…';
    String presetName(String? id) => switch (id) {
      'standard' => L10n.t('标准模式', 'Standard'),
      'code' => L10n.t('PTC 模式', 'PTC'),
      'minimal' => L10n.t('极简模式', 'Minimal'),
      'cordis' => L10n.t('创造模式', 'Creative'),
      _ => '…',
    };

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _card(L10n.t('连接', 'Connection'), [
          _row(
            leading: const Icon(Icons.computer_outlined),
            title: L10n.t('电脑地址', 'PC address'),
            sub: api.baseUrls.length > 1
                ? L10n.t(
                    '${api.baseUrl} · 共 ${api.baseUrls.length} 个地址自动切换 · 点按手动切换',
                    '${api.baseUrl} · ${api.baseUrls.length} addresses · tap to switch',
                  )
                : api.baseUrl,
            onTap: () => _pickAddress(),
            // 连接状态实时显示（修复：旧版写死「已连接」，断线也显示绿色已连接）
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: switch (store.connState) {
                      'connected' => ok,
                      'connecting' => warn,
                      _ => ink3,
                    },
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 5),
                Text(
                  switch (store.connState) {
                    'connected' => L10n.t('已连接', 'Connected'),
                    'connecting' => L10n.t('连接中…', 'Connecting…'),
                    _ => L10n.t('离线 · 自动重连', 'Offline · reconnecting'),
                  },
                  style: TextStyle(
                    fontSize: 12,
                    color: switch (store.connState) {
                      'connected' => ok,
                      'connecting' => warn,
                      _ => ink3,
                    },
                  ),
                ),
              ],
            ),
          ),
          _row(
            leading: const Icon(Icons.settings_outlined),
            title: L10n.t('重新配置连接', 'Reconfigure connection'),
            sub: L10n.t('更换电脑地址或访问口令', 'Change PC address or token'),
            trailing: Text(
              L10n.t('配置 ▸', 'Configure ▸'),
              style: TextStyle(fontSize: 12, color: brand),
            ),
            onTap: () => widget.onReconfigure(),
          ),
        ]),
        // v3.1.2：推送通道自检（配置在电脑端 cordis.patch.yml 的 pushUrls）
        _card(L10n.t('通知', 'Notifications'), [
          _row(
            leading: const Icon(Icons.notifications_active_outlined),
            title: L10n.t('发送测试通知', 'Send test notification'),
            sub: L10n.t(
              '验证推送通道（电脑端 cordis.patch.yml 配置）',
              'Verify push channels (configured on the PC)',
            ),
            trailing: Text(
              L10n.t('发送 ▸', 'Send ▸'),
              style: TextStyle(fontSize: 12, color: brand),
            ),
            onTap: _sendTestPush,
          ),
        ]),
        _card(L10n.t('默认配置', 'Defaults'), [
          _row(
            leading: const Icon(Icons.security_outlined),
            title: L10n.t('默认权限预设', 'Default permission'),
            sub: L10n.t('作用于之后新建的会话', 'Applies to new sessions'),
            trailing: Text(
              permName(store.catalog?.defaults['permissionPreset'] as String?),
              style: TextStyle(fontSize: 12, color: brand),
            ),
            onTap: () => _pickDefaultPerm(store),
          ),
          _row(
            leading: const Icon(Icons.bolt_outlined),
            title: L10n.t('默认 Agent 预设', 'Default agent preset'),
            sub: L10n.t('作用于之后新建的会话', 'Applies to new sessions'),
            trailing: Text(
              presetName(store.catalog?.defaults['agentPreset'] as String?),
              style: TextStyle(fontSize: 12, color: brand),
            ),
            onTap: () => _pickDefaultPreset(store),
          ),
          _row(
            leading: const Icon(Icons.dns_outlined),
            title: L10n.t('模型提供商', 'Model providers'),
            sub: L10n.t(
              '与 PC 端「设置 → 模型」同一配置通道',
              'Same channel as PC Settings → Models',
            ),
            trailing: Text(
              L10n.t('管理', 'Manage'),
              style: TextStyle(fontSize: 12, color: brand),
            ),
            onTap: () {
              // Phase 2：与模型弹层共用提供商页打开入口
              openProviders(context, store);
            },
          ),
        ]),
        _card(L10n.t('账户', 'Account'), [
          _row(
            leading: const Icon(Icons.account_balance_wallet_outlined),
            title: L10n.t('用量与额度', 'Usage & allowance'),
            sub: _usageLabel,
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  _usage == null
                      ? '—'
                      : '${_usage!.sources.where((source) => source.available).length}',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    color: _deepSeekLow ? danger : brand,
                  ),
                ),
                if (_usageBusy)
                  const Padding(
                    padding: EdgeInsets.only(left: 8),
                    child: SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  ),
              ],
            ),
            onTap: _openUsage,
          ),
          _row(
            leading: const Icon(Icons.add_card_outlined),
            title: L10n.t('充值', 'Top up'),
            sub: L10n.t('跳转 DeepSeek 开放平台', 'Go to DeepSeek Open Platform'),
            trailing: Text(
              L10n.t('去充值 ▸', 'Top up ▸'),
              style: TextStyle(fontSize: 12, color: brand),
            ),
            onTap: () => launchUrl(
              // 以电脑端插件配置为准（catalog.rechargeUrl），缺省回退官方充值页
              Uri.parse(
                store.catalog?.rechargeUrl ??
                    'https://platform.deepseek.com/top_up',
              ),
              mode: LaunchMode.externalApplication,
            ),
          ),
          _row(
            leading: const Icon(Icons.notifications_active_outlined),
            title: L10n.t('余额预警', 'Low-balance alert'),
            // v2.7.1：副标题动态显示当前阈值
            sub:
                L10n.t('余额低于 ¥', 'Remind to top up when balance is below ¥') +
                _fmtThreshold(store.balanceThreshold) +
                L10n.t(' 时提醒充值（点此修改）', ' — tap to change'),
            onTap: _pickThreshold,
            trailing: DshSwitch(
              value: store.balanceAlert,
              onChanged: (v) => store.setBalanceAlert(v),
            ),
          ),
        ]),
        _card(L10n.t('显示', 'Display'), [
          _row(
            leading: const Icon(Icons.tab_outlined),
            title: L10n.t('Git 标签页', 'Git tabs'),
            sub: _gitTabsSummary,
            onTap: _pickGitTabs,
          ),
          _row(
            leading: const Icon(Icons.psychology_outlined),
            title: L10n.t('思考内容', 'Thinking content'),
            sub: L10n.t(
              '活动条思考状态展开时是否显示思考原文（默认关：只显示状态）',
              'Show raw thinking text when expanded (default off: status only)',
            ),
            trailing: DshSwitch(
              value: store.showReasoning,
              onChanged: (v) => store.setShowReasoning(v),
            ),
          ),
          _row(
            leading: const Icon(Icons.account_tree_outlined),
            title: L10n.t('思维链默认展开', 'Thinking chain default expanded'),
            sub: L10n.t(
              '回复里的「思维链」块默认折叠还是展开（单条消息仍可点按切换）',
              'Whether the thinking-chain block in replies is expanded by default (each message stays toggleable)',
            ),
            trailing: DshSwitch(
              value: store.reasoningDefaultExpanded,
              onChanged: (v) => store.setReasoningDefaultExpanded(v),
            ),
          ),
          _row(
            leading: const Icon(Icons.bug_report_outlined),
            title: L10n.t('对话调试模式', 'Conversation debug mode'),
            sub: L10n.t(
              '显示工具原始参数、结果、事件序号与未知可见事件（默认关闭）',
              'Show raw tool IO, event metadata and unknown visible events (off by default)',
            ),
            trailing: DshSwitch(
              value: store.timelineDebug,
              onChanged: (v) => store.setTimelineDebug(v),
            ),
          ),
          _row(
            leading: const Icon(Icons.dark_mode_outlined),
            title: L10n.t('深色模式', 'Dark mode'),
            sub: switch (store.darkMode) {
              'dark' => L10n.t('已选深色', 'Dark'),
              'light' => L10n.t('已选浅色', 'Light'),
              _ => L10n.t('跟随系统', 'System'),
            },
            trailing: GestureDetector(
              onTap: () {
                final next = switch (store.darkMode) {
                  'system' => 'dark',
                  'dark' => 'light',
                  _ => 'system',
                };
                store.setDarkMode(next);
              },
              child: Text(switch (store.darkMode) {
                'dark' => L10n.t('深色', 'Dark'),
                'light' => L10n.t('浅色', 'Light'),
                _ => L10n.t('跟随系统', 'System'),
              }, style: TextStyle(fontSize: 13, color: brand)),
            ),
          ),
          _row(
            leading: const Icon(Icons.language_outlined),
            title: L10n.t('语言', 'Language'),
            sub: L10n.t('界面显示语言（即时生效）', 'UI language (applies immediately)'),
            onTap: () => _pickLanguage(store),
            trailing: Text(
              store.language == 'en' ? 'English' : '中文',
              style: TextStyle(fontSize: 13, color: brand),
            ),
          ),
          _row(
            leading: const Icon(Icons.pets_outlined),
            title: L10n.t('桌面宠物（大肥鱼）', 'Desktop pet (BigFish)'),
            sub: L10n.t(
              '显示任务状态/通知/余额，点它互动，长按打开面板（默认关）',
              'Shows task status / notifications / balance; tap to interact, long-press for panel (off by default)',
            ),
            trailing: DshSwitch(value: _bubbleOn, onChanged: _toggleBubble),
          ),
          _row(
            leading: const Icon(Icons.straighten_outlined),
            title: L10n.t('宠物大小', 'Pet size'),
            sub: L10n.t('迷你 / 标准 / 大', 'Mini / Standard / Large'),
            trailing: Text(
              _petSizeLabel(widget.store.petHeight),
              style: TextStyle(fontSize: 12, color: brand),
            ),
            onTap: () => _pickPetSize(widget.store),
          ),
          _row(
            leading: const Icon(Icons.motion_photos_off_outlined),
            title: L10n.t('减少动态', 'Reduce motion'),
            sub: L10n.t(
              '固定姿势，关闭待机与点击动画',
              'Freeze the pose; disable idle and tap animations',
            ),
            trailing: DshSwitch(
              value: widget.store.petReducedMotion,
              onChanged: (v) => widget.store.setPetReducedMotion(v),
            ),
          ),
          _row(
            leading: const Icon(Icons.vertical_align_bottom_outlined),
            title: L10n.t('贴边自动躲藏', 'Auto-hide at edge'),
            sub: L10n.t(
              '5 秒无操作后缩到屏幕边缘并虚化',
              'Tuck into the edge and fade after 5s idle',
            ),
            trailing: DshSwitch(
              value: widget.store.petEdgeHide,
              onChanged: (v) => widget.store.setPetEdgeHide(v),
            ),
          ),
          _row(
            leading: const Icon(Icons.help_outline),
            title: L10n.t('桌面宠物操作说明', 'Pet guide'),
            sub: L10n.t('状态含义与手势操作', 'Status meaning and gestures'),
            trailing: Text(
              L10n.t('查看 ▸', 'View ▸'),
              style: TextStyle(fontSize: 12, color: brand),
            ),
            onTap: _showBubbleGuide,
          ),
        ]),
        _card(L10n.t('关于', 'About'), [
          _row(
            leading: const Icon(Icons.info_outline),
            title: L10n.t('版本', 'Version'),
            sub:
                'App v${_appVersion.isEmpty ? '…' : _appVersion}'
                ' · ${L10n.t('插件', 'plugin')} v${store.api.pluginVersion.isEmpty ? '…' : store.api.pluginVersion}'
                '${_alignmentNote()}'
                '${store.updateCandidate != null ? ' · ${L10n.t('有新版本', 'update available')} ${store.updateCandidate!.version}' : ''}',
            onTap: store.updateCandidate == null
                ? null
                : () {
                    final candidate = store.updateCandidate;
                    if (candidate != null) {
                      unawaited(runUpdateFlow(context, store, candidate));
                    }
                  },
            trailing: store.updateCandidate != null
                ? Icon(
                    Icons.brightness_1,
                    size: 9,
                    color: DshColors.danger(context),
                  )
                : (store.alignment.needsAttention
                      ? Icon(
                          Icons.brightness_1,
                          size: 9,
                          color: DshColors.danger(context),
                        )
                      : null),
          ),
          // 插件更新入口常驻（与桌面「连接移动端」页一致）：即使还不知道有没有新版，
          // 手机也必须能主动触发宿主侧只读检查；有进行中的记录时可点开「处理」。
          // 已知候选时按本机形态给「更新」/「指引」，未检查时给「检查」。
          // 不能自更新的形态给出**对应那一条**可复制指引（评审 R11）。
          _row(
            leading: const Icon(Icons.desktop_windows_outlined),
            title: L10n.t('更新电脑端插件', 'Update desktop plugin'),
            sub: store.pluginUpdateJournal != null
                ? _journalSub(store)
                : !store.api.pluginUpdate.contentUpdateAvailable
                ? L10n.t(
                    '检查电脑端插件是否有可用更新',
                    'Check the desktop plugin for updates',
                  )
                : store.api.pluginUpdate.canSelfUpdate
                ? L10n.t(
                    '电脑端插件有新版本：可在这里直接触发更新',
                    'A newer desktop plugin is available — trigger the update here',
                  )
                : L10n.t(
                    '电脑端插件有新版本：本机形态需按指引更新',
                    'A newer desktop plugin is available — follow the guide for your install',
                  ),
            onTap: store.pluginUpdateJournal != null
                ? () => unawaited(_updateJournalActions(store))
                : (!store.api.pluginUpdate.contentUpdateAvailable ||
                          store.api.pluginUpdate.canSelfUpdate
                      ? _triggerPluginUpdate
                      : _showPluginUpdateGuidance),
            trailing: store.pluginUpdateJournal == null
                ? Text(
                    !store.api.pluginUpdate.contentUpdateAvailable
                        ? L10n.t('检查 ▸', 'Check ▸')
                        : store.api.pluginUpdate.canSelfUpdate
                        ? L10n.t('更新 ▸', 'Update ▸')
                        : L10n.t('指引 ▸', 'Guide ▸'),
                    style: TextStyle(fontSize: 12, color: brand),
                  )
                : Text(
                    L10n.t('处理 ▸', 'Manage ▸'),
                    style: TextStyle(fontSize: 12, color: brand),
                  ),
          ),
          if (store.api.pluginUpdate.transaction != null ||
              store.pluginUpdateJournal != null ||
              store.api.pluginUpdate.checkLog.isNotEmpty)
            _updateProgressCard(store),
          _row(
            leading: const Icon(Icons.sync_outlined),
            title: L10n.t('检查 App 更新', 'Check App updates'),
            sub: store.updateChecking
                ? L10n.t('检查中…', 'Checking…')
                : L10n.t(
                    '检查电脑端提供的固定 App 发布',
                    'Check host-provided fixed App releases',
                  ),
            trailing: TextButton(
              onPressed: store.updateChecking || _updateFlowBusy
                  ? null
                  : _checkUpdate,
              child: Text(
                store.updateChecking
                    ? L10n.t('检查中…', 'Checking…')
                    : L10n.t('检查 ▸', 'Check ▸'),
                style: TextStyle(fontSize: 12, color: brand),
              ),
            ),
          ),
          _row(
            leading: const Icon(Icons.auto_awesome_outlined),
            title: L10n.t('角色素材', 'Character assets'),
            sub: L10n.t(
              'PC2005-cloud/dsh-pet · MIT（经 dsh-dafeiyu 转码）',
              'PC2005-cloud/dsh-pet · MIT (encoded via dsh-dafeiyu)',
            ),
          ),
          _row(
            leading: const Icon(Icons.monitor_heart_outlined),
            title: L10n.t('环境诊断', 'Diagnostics'),
            sub: _diagLoaded
                ? '${L10n.t('检测完成 · ', 'Done · ')}$_diagTime'
                : L10n.t('检测当前环境各项能力', 'Check environment capabilities'),
            trailing: TextButton(
              onPressed: _openDiag,
              child: Text(
                L10n.t('查看 ▸', 'View ▸'),
                style: TextStyle(fontSize: 12, color: brand),
              ),
            ),
          ),
          _row(
            leading: const Icon(Icons.article_outlined),
            title: L10n.t('应用日志', 'App log'),
            sub: L10n.t(
              '启动/连接/加载事件（排障用）',
              'Startup/connection/load events (troubleshooting)',
            ),
            trailing: TextButton(
              onPressed: _openLog,
              child: Text(
                L10n.t('查看 ▸', 'View ▸'),
                style: TextStyle(fontSize: 12, color: brand),
              ),
            ),
          ),
        ]),
      ],
    );
  }

  /// 修改默认 Agent 预设（作用于之后新建的会话）
  void _pickDefaultPreset(AppStore store) {
    final cat = store.catalog;
    if (cat == null) return;
    final current = cat.defaults['agentPreset'] as String?;
    final msgr = ScaffoldMessenger.of(context);
    showChoiceSheet(
      context,
      title: L10n.t('默认 Agent 预设', 'Default agent preset'),
      items: [
        for (final p in cat.agentPresets)
          (id: p.id, name: p.name, sub: p.description),
      ],
      selectedId: current,
      footnote: L10n.t('作用于之后新建的会话', 'Applies to new sessions'),
      onPick: (id) async {
        try {
          await api.updateDefaults(agentPreset: id);
          await store.refreshAll();
          showToastAt(msgr, L10n.t('已设置默认预设', 'Default preset set'));
        } catch (e) {
          showToastAt(msgr, '${L10n.t('设置失败：', 'Failed: ')}$e');
        }
      },
    );
  }

  /// 修改默认权限预设（作用于之后新建的会话）
  void _pickDefaultPerm(AppStore store) {
    final cat = store.catalog;
    if (cat == null) return;
    final current = cat.defaults['permissionPreset'] as String?;
    final msgr = ScaffoldMessenger.of(context);
    showChoiceSheet(
      context,
      title: L10n.t('默认权限预设', 'Default permission preset'),
      items: [
        for (final p in cat.permissionPresets)
          (id: p.id, name: p.name, sub: p.description),
      ],
      selectedId: current,
      footnote: L10n.t('作用于之后新建的会话', 'Applies to new sessions'),
      onPick: (id) async {
        try {
          await api.updateDefaults(permissionPreset: id);
          await store.refreshAll();
          showToastAt(msgr, L10n.t('已设置默认权限', 'Default permission set'));
        } catch (e) {
          showToastAt(msgr, '${L10n.t('设置失败：', 'Failed: ')}$e');
        }
      },
    );
  }

  /// 不能自更新时展示**与实际安装方式对应的那一条**指引（可复制），而不是先诱导点"一键更新"。
  Future<void> _showPluginUpdateGuidance() async {
    final g = widget.store.api.pluginUpdate.guidance;
    final shape = widget.store.api.pluginUpdate.installShape;
    final lines = <String>[
      if (g != null && g.summary.isNotEmpty) g.summary,
      if (g != null) ...g.steps.map((s) => '· $s'),
      if (shape.isNotEmpty) '${L10n.t('安装方式', 'install shape')}: $shape',
    ];
    final commands = g?.commands ?? const <String>[];
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(L10n.t('电脑端插件更新指引', 'Desktop plugin update guide')),
        content: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final l in lines)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Text(l, style: const TextStyle(fontSize: 13)),
                ),
              if (commands.isNotEmpty) ...[
                const SizedBox(height: 8),
                for (final c in commands)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: Row(
                      children: [
                        Expanded(
                          child: SelectableText(
                            c,
                            style: const TextStyle(
                              fontFamily: 'monospace',
                              fontSize: 12,
                            ),
                          ),
                        ),
                        TextButton(
                          onPressed: () async {
                            await Clipboard.setData(ClipboardData(text: c));
                            if (ctx.mounted)
                              showToast(ctx, L10n.t('已复制', 'Copied'));
                          },
                          child: Text(
                            L10n.t('复制', 'Copy'),
                            style: const TextStyle(fontSize: 12),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text(L10n.t('关闭', 'Close')),
          ),
        ],
      ),
    );
  }

  /// 在手机上触发电脑端插件更新。
  ///
  /// Legacy prepare 可在确认前查询候选，但不启动最终插件更新 POST。prepare 失败后
  /// 保留同一 opId；prepareId 与目标版本持久化后，重启 App 仍会先显示最终确认。
  Future<void> _triggerPluginUpdate({
    String? retryPrepareOpId,
    PluginUpdateJournal? preparedJournal,
  }) async {
    final store = widget.store;
    var opId = '';
    var pluginVersion = '';
    var targetAppVersion = '';
    var targetContentSha256 = '';
    String? prepareId;
    var legacy = false;
    try {
      if (preparedJournal != null &&
          preparedJournal.phase == UpdatePhase.pluginPrepared) {
        opId = preparedJournal.opId;
        pluginVersion = preparedJournal.targetVersion;
        targetAppVersion = preparedJournal.appVersion;
        targetContentSha256 = preparedJournal.targetContentSha256;
        prepareId = preparedJournal.prepareId;
        legacy = true;
      } else if (retryPrepareOpId != null) {
        final pending = store.pluginUpdateJournal;
        if (pending == null ||
            !pending.isPreparationPhase ||
            pending.opId != retryPrepareOpId) {
          return;
        }
        opId = pending.opId;
        legacy = true;
        final prepared = await store.preparePluginUpdate(opId: opId);
        final current = store.pluginUpdateJournal;
        if ((prepared['action'] != 'prepared' &&
                prepared['action'] != 'confirmation-required') ||
            current?.prepareId == null) {
          if (mounted) {
            showToast(
              context,
              store.pluginUpdateNotice ??
                  L10n.t('无法准备插件更新', 'Could not prepare plugin update'),
            );
          }
          return;
        }
        pluginVersion = current!.targetVersion;
        targetAppVersion = current.appVersion;
        targetContentSha256 = current.targetContentSha256;
        prepareId = current.prepareId;
      } else {
        final response = await store.api.checkPluginUpdate();
        if (!mounted) return;
        final rawStatus = response['pluginUpdate'];
        if (rawStatus is Map) {
          // 检查结果也是最新状态：刷新后行文案/是否可自更新都跟着变。
          store.api.pluginUpdate = PluginUpdateStatus.fromJson(
            Map<String, dynamic>.from(rawStatus),
          );
          setState(() {});
        }
        final update = response['pluginUpdate'];
        final candidate = update is Map ? update['candidate'] : null;
        final state = update is Map ? update['state'] : null;
        if (candidate is! Map || state != 'update-available') {
          final reason = update is Map ? update['reason'] : null;
          final text = switch (state) {
            'up-to-date' || 'local-ahead' => L10n.t(
              '电脑端插件已是最新',
              'Desktop plugin is up to date',
            ),
            'disabled' => L10n.t(
              '电脑端已停用插件自动更新',
              'Automatic plugin updates are disabled on the desktop',
            ),
            _ =>
              '${L10n.t('检查暂不可用：', 'Check unavailable: ')}${reason ?? state ?? 'unknown'}',
          };
          showToast(context, text);
          return;
        }
        if (!store.api.pluginUpdate.canSelfUpdate) {
          await _showPluginUpdateGuidance();
          return;
        }
        final carrier = candidate['carrier'] is Map
            ? candidate['carrier'] as Map
            : const {};
        final plugin = candidate['plugin'] is Map
            ? candidate['plugin'] as Map
            : const {};
        pluginVersion = (plugin['version'] ?? carrier['version'] ?? '')
            .toString();
        targetContentSha256 = (plugin['contentSha256'] ?? '')
            .toString()
            .trim()
            .toLowerCase();
        targetAppVersion = (carrier['appVersion'] ?? '').toString();
        legacy = carrier['legacyMetadataMissing'] == true;
        opId = genRequestId();
        if (legacy) {
          final prepared = await store.preparePluginUpdate(
            opId: opId,
            candidate: Map<String, dynamic>.from(candidate),
          );
          final current = store.pluginUpdateJournal;
          if ((prepared['action'] != 'prepared' &&
                  prepared['action'] != 'confirmation-required') ||
              current?.prepareId == null) {
            if (mounted) {
              showToast(
                context,
                store.pluginUpdateNotice ??
                    L10n.t('无法准备插件更新', 'Could not prepare plugin update'),
              );
            }
            return;
          }
          opId = current!.opId;
          pluginVersion = current.targetVersion;
          targetAppVersion = current.appVersion;
          targetContentSha256 = current.targetContentSha256;
          prepareId = current.prepareId;
        }
      }
      if (pluginVersion.isEmpty ||
          targetAppVersion.isEmpty ||
          (legacy && prepareId == null)) {
        if (legacy && opId.isNotEmpty) {
          await store.abandonPluginUpdatePreparation(opId);
        }
        if (!mounted) return;
        showToast(
          context,
          L10n.t(
            '更新候选缺少插件或 App 目标版本',
            'Update candidate is missing a plugin or App target version',
          ),
        );
        return;
      }
      if (!mounted) return;
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text(L10n.t('更新电脑端插件？', 'Update desktop plugin?')),
          content: Text(
            L10n.t(
              '插件目标版本：$pluginVersion\nApp 目标版本：$targetAppVersion\n电脑端宿主会重启，连接会短暂断开。',
              'Plugin target: $pluginVersion\nApp target: $targetAppVersion\nThe desktop host restarts and the connection briefly drops.',
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: Text(L10n.t('取消', 'Cancel')),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: Text(L10n.t('开始更新', 'Update')),
            ),
          ],
        ),
      );
      if (confirmed != true || !mounted) {
        if (legacy) await store.abandonPluginUpdatePreparation(opId);
        return;
      }
      await store.beginPluginUpdate(
        opId: opId,
        targetVersion: pluginVersion,
        targetContentSha256: targetContentSha256,
        targetAppVersion: targetAppVersion,
        prepareId: prepareId,
      );
      if (!mounted) return;
      final notice = store.pluginUpdateNotice;
      if (notice != null) showToast(context, notice);
    } catch (error) {
      if (mounted) showToast(context, store.pluginUpdateNotice ?? '$error');
    }
  }

  /// 进行中记录的状态说明（不同阶段该做什么不同）。
  String _journalSub(AppStore store) {
    return switch (store.pluginUpdateJournal?.phase) {
      UpdatePhase.pluginPreparePending => L10n.t(
        '正在准备插件候选；尚未提交安装',
        'Preparing the plugin candidate; installation has not been submitted',
      ),
      UpdatePhase.pluginPrepareRetry => L10n.t(
        '准备结果未确认；可用同一操作编号重试',
        'Prepare result is unknown; retry reuses the same operation id',
      ),
      UpdatePhase.pluginPrepared => L10n.t(
        '插件与 App 目标已固定；等待最终确认',
        'Plugin and App targets are fixed; waiting for final confirmation',
      ),
      UpdatePhase.appPending => L10n.t(
        '电脑端插件已确认；App 更新待安装/待核验',
        'Desktop plugin confirmed; the app update is pending install/verification',
      ),
      UpdatePhase.pluginConfirmed => L10n.t(
        '电脑端插件已更新；正在确定 App 目标…',
        'Desktop plugin updated; resolving the app target…',
      ),
      UpdatePhase.pluginRetry => L10n.t(
        '上次更新未确认；可重试，或取消并重新检查',
        'Last update was not confirmed; retry, or cancel and re-check',
      ),
      _ => L10n.t(
        '等待电脑端完成更新并重启…',
        'Waiting for the desktop plugin to restart…',
      ),
    };
  }

  /// 接续记录的出口：prepare 尚未 admission 时可同 opId 重试或安全取消；
  /// 已准备候选时回到最终确认，不提前发更新 POST。
  Future<void> _updateJournalActions(AppStore store) async {
    final journal = store.pluginUpdateJournal;
    if (journal == null) return;
    final prepared =
        journal.phase == UpdatePhase.pluginPrepared &&
        journal.prepareId != null &&
        journal.prepareId!.isNotEmpty;
    final preparing = journal.isPreparationPhase;
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 14, 20, 6),
              child: Text(
                L10n.t('处理进行中的更新', 'Manage pending update'),
                style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            if (prepared)
              ListTile(
                title: Text(L10n.t('继续确认并更新', 'Review and continue update')),
                subtitle: Text(
                  L10n.t(
                    '沿用已准备的目标与操作编号；确认前不会安装',
                    'Keeps the prepared target and operation id; nothing installs before confirmation',
                  ),
                ),
                onTap: () => Navigator.of(ctx).pop('confirm-prepared'),
              )
            else if (preparing)
              ListTile(
                title: Text(L10n.t('重试准备', 'Retry preparation')),
                subtitle: Text(
                  L10n.t(
                    '使用同一操作编号安全重试；不会开始安装',
                    'Retries with the same operation id; installation does not start',
                  ),
                ),
                onTap: () => Navigator.of(ctx).pop('retry-prepare'),
              )
            else
              ListTile(
                title: Text(L10n.t('继续等待', 'Keep waiting')),
                subtitle: Text(
                  L10n.t(
                    '重连后会自动确认；不会先装 App',
                    'It continues automatically after reconnecting and never installs the app first',
                  ),
                ),
                onTap: () => Navigator.of(ctx).pop('wait'),
              ),
            ListTile(
              title: Text(
                preparing
                    ? L10n.t('取消准备', 'Cancel preparation')
                    : L10n.t('取消并重新检查', 'Cancel and re-check'),
              ),
              subtitle: Text(
                preparing
                    ? L10n.t(
                        '清除未提交的本地准备记录；不会触发插件更新',
                        'Clears the unsubmitted local preparation; no plugin update is triggered',
                      )
                    : L10n.t(
                        '清除本地旧目标，按电脑端当前状态重新检查；不会自动降级 App',
                        'Clears the local old target and re-checks the current desktop state; the app is never downgraded',
                      ),
              ),
              onTap: () =>
                  Navigator.of(ctx)
                      .pop(preparing ? 'cancel-prepare' : 'recheck'),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (!mounted) return;
    if (choice == 'retry-prepare') {
      await _triggerPluginUpdate(retryPrepareOpId: journal.opId);
      return;
    }
    if (choice == 'confirm-prepared') {
      await _triggerPluginUpdate(preparedJournal: journal);
      return;
    }
    if (choice == 'cancel-prepare') {
      await store.abandonPluginUpdatePreparation(journal.opId);
      if (mounted)
        showToast(
          context,
          L10n.t('已取消插件更新准备', 'Plugin update preparation cancelled'),
        );
      return;
    }
    if (choice != 'recheck') return;
    await store.cancelUpdateAndRecheck();
    if (!mounted) return;
    final notice = store.pluginUpdateNotice;
    if (notice != null) showToast(context, notice);
  }

  /// 版本行的对齐尾注：未连接不判定；对齐时不加噪声；失配时说清**该动哪一端**。
  String _alignmentNote() {
    if (widget.store.api.pluginVersion.isEmpty) return '';
    return switch (widget.store.alignment.state) {
      AlignmentState.ok => '',
      AlignmentState.appOutdated =>
        ' · ${L10n.t('App 需更新', 'App needs update')}',
      AlignmentState.pluginOutdated =>
        ' · ${L10n.t('插件需更新', 'plugin needs update')}',
      AlignmentState.unknown => ' · ${L10n.t('对齐无法判定', 'alignment unknown')}',
    };
  }

  String _petSizeLabel(int height) {
    if (height <= 80) return L10n.t('迷你', 'Mini');
    if (height >= 106) return L10n.t('大', 'Large');
    return L10n.t('标准', 'Standard');
  }

  void _pickPetSize(AppStore store) {
    showChoiceSheet(
      context,
      title: L10n.t('宠物大小', 'Pet size'),
      items: [
        (id: '76', name: L10n.t('迷你', 'Mini'), sub: '76dp'),
        (id: '96', name: L10n.t('标准', 'Standard'), sub: '96dp'),
        (id: '116', name: L10n.t('大', 'Large'), sub: '116dp'),
      ],
      selectedId: '${store.petHeight}',
      onPick: (id) async {
        await store.setPetHeight(int.parse(id));
      },
    );
  }

  /// 桌面宠物操作说明弹窗（状态含义 + 手势操作）。
  void _showBubbleGuide() {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(
          L10n.t('桌面宠物操作说明', 'Desktop pet guide'),
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
        ),
        content: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              _guideSection(L10n.t('状态', 'Status'), [
                (
                  L10n.t('动作跟随任务', 'Animation follows the task'),
                  L10n.t(
                    '空闲 / 思考 / 处理 / 待确认 / 完成 / 出错',
                    'Idle / thinking / working / waiting / done / error',
                  ),
                ),
                (
                  L10n.t('红色角标', 'Red badge'),
                  L10n.t('未读通知数（60 秒后自动消退）', 'Unread count (clears after 60s)'),
                ),
                (
                  L10n.t('状态气泡', 'Status bubble'),
                  L10n.t(
                    '显示当前任务与进度，点它打开面板',
                    'Shows the task and progress; tap for panel',
                  ),
                ),
              ]),
              const SizedBox(height: 10),
              _guideSection(L10n.t('手势', 'Gestures'), [
                (
                  L10n.t('点头部 / 身体 / 尾巴', 'Tap head / body / tail'),
                  L10n.t('摸头 / 戳一下 / 碰尾巴', 'Head pat / poke / tail'),
                ),
                (
                  L10n.t('双击', 'Double tap'),
                  L10n.t('摸头（专属台词）', 'Head pat (special line)'),
                ),
                (
                  L10n.t('拖动', 'Drag'),
                  L10n.t(
                    '悬空，松手落地并吸附到最近边缘',
                    'Lift, then land and snap to the nearest edge',
                  ),
                ),
                (
                  L10n.t('长按', 'Long press'),
                  L10n.t('打开 / 收起面板', 'Open / close panel'),
                ),
                (
                  L10n.t('贴边 5 秒', '5s at the edge'),
                  L10n.t(
                    '缩进边缘并虚化，点一下滑出',
                    'Tucks in and fades; tap to slide out',
                  ),
                ),
              ]),
              const SizedBox(height: 10),
              _guideSection(L10n.t('面板', 'Panel'), [
                (
                  L10n.t('内容', 'Content'),
                  L10n.t(
                    '运行中会话 / 最近通知 / 用量与额度 / 打开 App / 去充值',
                    'Active sessions / notifications / usage & allowance / open app / top up',
                  ),
                ),
                (
                  L10n.t('关闭', 'Close'),
                  L10n.t('点面板外任意位置', 'Tap anywhere outside'),
                ),
                (
                  L10n.t('关闭宠物', 'Turn off pet'),
                  L10n.t(
                    '面板底部的「关闭宠物」',
                    'Use "Turn off pet" at the bottom of the panel',
                  ),
                ),
              ]),
            ],
          ),
        ),
        actions: [
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: Text(L10n.t('知道了', 'Got it')),
          ),
        ],
      ),
    );
  }

  Widget _guideSection(String title, List<(String, String)> rows) {
    final ink2 = DshColors.ink2(context);
    final ink3 = DshColors.ink3(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w700,
            color: DshColors.brand(context),
          ),
        ),
        const SizedBox(height: 4),
        for (final (k, v) in rows)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '$k：',
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: ink2,
                  ),
                ),
                Expanded(
                  child: Text(v, style: TextStyle(fontSize: 13, color: ink3)),
                ),
              ],
            ),
          ),
      ],
    );
  }

  /// 选择界面语言（中文 / English），即时生效 + 持久化。
  Future<void> _pickLanguage(AppStore store) async {
    final brand = DshColors.brand(context);
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 14, 20, 6),
              child: Text(
                L10n.t('选择语言', 'Choose language'),
                style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            for (final (id, name) in [('zh', '中文'), ('en', 'English')])
              ListTile(
                title: Text(
                  name,
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: store.language == id
                        ? FontWeight.w700
                        : FontWeight.w400,
                    color: store.language == id ? brand : null,
                  ),
                ),
                trailing: store.language == id
                    ? Icon(Icons.check, size: 18, color: brand)
                    : null,
                onTap: () => Navigator.of(ctx).pop(id),
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (choice != null) await store.setLanguage(choice);
  }

  Future<void> _checkUpdate() async {
    final store = widget.store;
    // 先把电脑端最新状态与手机端接续记录对齐：否则刚完成插件更新时，
    // 本地 journal 仍停在“未确认”，会把 App 更新挡在门禁外。
    try {
      final data = await store.api.getJson('/api/bootstrap');
      store.api.absorbBootstrap(data);
    } catch (_) {}
    if (store.pluginUpdateJournal != null) {
      try {
        await store.resumePluginUpdate();
      } catch (_) {}
    }
    if (!mounted) return;
    // 两端编排（F8）：**唯一判据在 store.appUpdateGate()**，这里只是同一个门禁的入口
    store.updateChecking = true;
    if (mounted) setState(() {});
    final outcome = await Updater.check(store);
    store.updateChecking = false;
    if (!mounted) return;
    setState(() {});
    switch (outcome.verdict) {
      case UpdateVerdict.updateAvailable:
        final candidate = outcome.candidate;
        if (candidate == null) return;
        store.setUpdateCandidate(candidate);
        _updateFlowBusy = true;
        setState(() {});
        await runUpdateFlow(context, store, candidate);
        _updateFlowBusy = false;
        if (mounted) setState(() {});
        break;
      case UpdateVerdict.upToDate:
        showToast(
          context,
          outcome.error ?? L10n.t('已是最新版本', 'Already up to date'),
        );
        break;
      case UpdateVerdict.remoteOlder:
        showToast(
          context,
          L10n.t(
            '电脑端固定发布低于当前版本，已忽略',
            'Host fixed release is older than current — ignored',
          ),
        );
        break;
    }
  }

  /// 最近一次插件更新检查的脱敏诊断：与桌面端「检查详情」显示同一份内容。
  /// 插件更新详情：检查诊断 + 安装进度合并展示（与桌面端同一份内容）。
  void _openPluginUpdateDetails() {
    final store = widget.store;
    final checkLines = store.api.pluginUpdate.checkLog;
    final opId = store.pluginUpdateLogOpId;
    if (checkLines.isEmpty && opId.isEmpty) return;
    showSheet(context, L10n.t('插件更新详情', 'Plugin update details'), [
      _PluginUpdateDetailsPanel(
        key: ValueKey('plugin-update-details-$opId'),
        checkLines: checkLines,
        opId: opId,
        client: store.api,
        transaction: store.api.pluginUpdate.transaction,
      ),
    ]);
  }

  /// 应用日志：查看 / 复制 / 清空
  Future<void> _openLog() async {
    final text = await AppLog.instance.readAll();
    if (!mounted) return;
    final msgr = ScaffoldMessenger.of(context);
    showSheet(context, L10n.t('应用日志', 'App log'), [
      Text(
        '${L10n.t('最近 ', 'Last ')}${AppLog.instance.lines.length}${L10n.t(' 条 · 文件 dsh_mobile.log', ' entries · file dsh_mobile.log')}',
        textAlign: TextAlign.center,
        style: TextStyle(fontSize: 11, color: DshColors.ink3(context)),
      ),
      const SizedBox(height: 8),
      ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 320),
        child: SingleChildScrollView(
          // v3.0.0：日志倒序展示——最新日志在最上面，不用每次翻到底部
          child: SelectableText(
            text.isEmpty ? L10n.t('（暂无日志）', '(No logs)') : _reverseLog(text),
            style: TextStyle(
              fontSize: 11.5,
              height: 1.6,
              color: DshColors.ink(context),
              fontFamily: 'monospace',
            ),
          ),
        ),
      ),
      const SizedBox(height: 12),
      Row(
        children: [
          Expanded(
            child: OutlinedButton(
              onPressed: () async {
                await AppLog.instance.clear();
                showToastAt(msgr, L10n.t('日志已清空', 'Log cleared'));
              },
              child: Text(L10n.t('清空', 'Clear')),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: FilledButton(
              onPressed: () => _copy(text),
              child: Text(L10n.t('复制', 'Copy')),
            ),
          ),
        ],
      ),
    ]);
  }

  /// v3.0.0：日志倒序展示（最新在上，省去翻到底部）——逐行倒排，丢弃尾部空行。
  static String _reverseLog(String text) {
    final lines = text.split('\n');
    return lines.reversed.where((l) => l.isNotEmpty).join('\n');
  }

  Future<void> _openDiag() async {
    // 每次打开都实时拉取（修复：旧版只在首次加载，之后永远显示过期版本）
    await _loadDiag();
    if (!mounted) return;
    ScaffoldMessenger.of(context).clearSnackBars();
    showSheet(context, L10n.t('环境诊断', 'Diagnostics'), [
      ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 320),
        child: SingleChildScrollView(
          child: SelectableText(
            _diagText,
            style: TextStyle(
              fontSize: 13,
              height: 1.7,
              color: DshColors.ink(context),
            ),
          ),
        ),
      ),
      const SizedBox(height: 12),
      FilledButton(
        onPressed: () => _copy(_diagText),
        child: Text(L10n.t('复制', 'Copy')),
      ),
    ]);
  }

  Future<void> _copy(String text) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (mounted) {
      showToast(context, L10n.t('已复制', 'Copied'));
    }
  }
}
