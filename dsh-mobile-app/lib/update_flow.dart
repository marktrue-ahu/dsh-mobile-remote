// 自动更新 UI 流程：确认弹窗 → 下载进度（可取消）→ 结果反馈。
// 手动「检查更新」与首页「有新版本」横幅共用此流程。
import 'package:flutter/material.dart';
import '../l10n.dart';
import '../store.dart';
import '../theme.dart';
import '../toast.dart';
import '../update_core.dart';
import '../updater.dart';

/// 对给定候选执行完整更新流（spec：确认 → 下载 → 校验 → 签名预检 → 安装）。
/// Installer launch never clears the fixed candidate/journal; a restarted App verifies version/build.
/// 所有 App 更新入口的**唯一门禁**（F8）：无论从首页横幅、设置页版本行还是「检查更新」
/// 进来，都先经过这里——避免某一条路径绕开"插件先行"，把 App 升到需要新端点插件的版本。
/// 两端编排的前置检查（F8/R9）：插件未对齐就先处理插件，返回是否允许继续装 App。
Future<bool> ensurePluginAlignedFirst(BuildContext context, AppStore store, [UpdateCandidate? candidate]) async {
  final gate = store.appUpdateGate(candidate);
  if (gate.allowed) return true;
  switch (gate.reason) {
    case 'plugin-update-in-progress':
      showToast(context, L10n.t('电脑端插件正在更新，完成后会自动继续', 'Desktop plugin is updating — this continues automatically'));
      return false;
    case 'plugin-update-failed':
    case 'plugin-update-available':
      final go = await _confirmPluginFirst(context);
      if (go == true) await store.beginPluginUpdate();
      return false;
    case 'plugin-update-guidance':
      showToast(context, L10n.t('电脑端插件需按指引更新（设置页可见）', 'Desktop plugin needs a manual update — see Settings'));
      return false;
    case 'plugin-transaction-pending':
      showToast(context, L10n.t('电脑端插件更新尚未确认，请稍后再试', 'Desktop plugin update is not confirmed yet — try again shortly'));
      return false;
    case 'plugin-check-unavailable':
    default:
      // W3：检查没做成时**不**说成"无需更新"，也不放行 App 更新
      showToast(context, L10n.t('无法确认该发布的插件目标；请在设置页重试或按电脑端插件指引升级。旧组合仍可正常使用', 'Cannot confirm this release’s plugin target. Retry or follow the desktop plugin guide in Settings; existing features remain usable'));
      return false;
  }
}

Future<bool?> _confirmPluginFirst(BuildContext context) => showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(L10n.t('先更新电脑端插件', 'Update the desktop plugin first')),
        content: Text(L10n.t(
          '电脑端插件有新版本。先把插件更新好，再更新 App，否则新 App 需要的新端点会缺失。',
          'A newer desktop plugin is available. Update it before the app, otherwise endpoints the new app needs will be missing.',
        )),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(L10n.t('稍后', 'Later'))),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(L10n.t('先更新插件', 'Update plugin'))),
        ],
      ),
    );

Future<void> runUpdateFlow(
  BuildContext context,
  AppStore store,
  UpdateCandidate candidate,
) async {
  if (!await ensurePluginAlignedFirst(context, store, candidate)) return;
  if (!context.mounted) return;
  final ok = await _confirmDialog(context, candidate);
  if (ok != true || !context.mounted) return;

  final result = await showDialog<String>(
    context: context,
    barrierDismissible: false,
    builder: (_) => _DownloadDialog(store: store, candidate: candidate),
  );

  if (!context.mounted) return;
  if (result == 'cancelled') {
    showToast(context, L10n.t('已取消更新', 'Update cancelled'));
  } else if (result == null || result.isEmpty) {
    showToast(context, L10n.t('已拉起安装器，请按系统提示完成安装', 'Installer opened — follow the system prompt'));
  } else {
    showToast(context, result);
  }
}

/// 确认弹窗：版本 / 说明 / 大小 / 来源。
Future<bool?> _confirmDialog(BuildContext context, UpdateCandidate c) {
  final size = c.sizeBytes != null
      ? '${(c.sizeBytes! / (1024 * 1024)).toStringAsFixed(1)} MB'
      : L10n.t('未知大小', 'unknown size');
  return showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(L10n.t('发现新版本', 'New version available')),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _kv(L10n.t('版本', 'Version'), c.version),
          _kv(L10n.t('来源', 'Source'), c.source),
          _kv(L10n.t('大小', 'Size'), size),
          if (c.notes != null && c.notes!.isNotEmpty) ...[
            const SizedBox(height: 8),
            // notes 取 CHANGELOG 最新条目全文，可能很长：限高滚动
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 180),
              child: SingleChildScrollView(
                child: Text(c.notes!, style: TextStyle(fontSize: 12.5, color: DshColors.ink2(ctx))),
              ),
            ),
          ],
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: Text(L10n.t('取消', 'Cancel'))),
        FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: Text(L10n.t('立即更新', 'Update now'))),
      ],
    ),
  );
}

Widget _kv(String k, String v) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Text('$k：', style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
          Expanded(child: Text(v, style: const TextStyle(fontSize: 13))),
        ],
      ),
    );

/// 下载/校验/安装进度弹窗；返回 null=成功，'cancelled'=用户取消，其他=错误信息。
class _DownloadDialog extends StatefulWidget {
  final AppStore store;
  final UpdateCandidate candidate;
  const _DownloadDialog({required this.store, required this.candidate});

  @override
  State<_DownloadDialog> createState() => _DownloadDialogState();
}

class _DownloadDialogState extends State<_DownloadDialog> {
  String _stage = 'download';
  int _received = 0;
  int? _total;
  String? _error;
  bool _cancelled = false;
  bool _done = false;
  String? _result;
  final _cancelToken = UpdateCancelToken();

  Future<void> _start() async {
    final err = await widget.store.installAppUpdate(
      widget.candidate,
      onProgress: (r, t) {
        if (mounted) {
          setState(() {
            _received = r;
            _total = t;
          });
        }
      },
      onStage: (s) {
        if (mounted) {
          setState(() => _stage = s);
        }
      },
      cancel: _cancelToken,
    );
    if (!mounted) return;
    if (err == null) {
      setState(() {
        _done = true;
        _result = '';
      });
    } else if (!_cancelled) {
      setState(() {
        _done = true;
        _error = err;
      });
    }
    // err == 'cancelled'：用户已取消，弹窗已关/即将关，无需展示
  }

  /// 取消（按钮 / 系统返回键同路）：中止下载 + 清理半成品 + 关闭弹窗。
  void _onCancel() {
    _cancelToken.cancel();
    setState(() {
      _cancelled = true;
      _done = true;
      _result = 'cancelled';
    });
    Navigator.of(context).pop('cancelled');
  }

  @override
  void initState() {
    super.initState();
    _start();
  }

  String get _stageLabel => switch (_stage) {
        'download' => L10n.t('下载中…', 'Downloading…'),
        'checksum' => L10n.t('校验完整性…', 'Verifying checksum…'),
        'signature' => L10n.t('校验签名…', 'Verifying signature…'),
        'install' => L10n.t('拉起安装器…', 'Opening installer…'),
        _ => L10n.t('处理中…', 'Processing…'),
      };

  @override
  Widget build(BuildContext context) {
    final ink3 = DshColors.ink3(context);
    final brand = DshColors.brand(context);
    return PopScope(
      canPop: _done,
      onPopInvokedWithResult: (didPop, _) {
        // 返回键与「取消」按钮同一通道：真正取消下载，而非仅改本地状态
        if (!didPop) _onCancel();
      },
      child: AlertDialog(
        title: Text(_error != null || _done ? L10n.t('更新', 'Update') : _stageLabel),
        content: Builder(builder: (ctx) {
          if (_error != null) {
            return Text(_error!, style: const TextStyle(fontSize: 13.5));
          }
          if (_done && _result == 'cancelled') {
            return Text(L10n.t('已取消', 'Cancelled'), style: TextStyle(color: ink3));
          }
          if (_done && _result == '') {
            return Text(L10n.t('已拉起安装器，返回本页后继续使用 App', 'Installer opened — return to keep using the app'), style: TextStyle(color: ink3));
          }
          // 下载中：进度条
          final pct = (_total != null && _total! > 0) ? (_received / _total!).clamp(0.0, 1.0) : null;
          final mb = _received / (1024 * 1024);
          final totalMb = _total != null ? _total! / (1024 * 1024) : null;
          return Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                _stage == 'download'
                    ? (totalMb != null
                        ? L10n.t('${mb.toStringAsFixed(1)} / ${totalMb.toStringAsFixed(1)} MB', '${mb.toStringAsFixed(1)} / ${totalMb.toStringAsFixed(1)} MB')
                        : L10n.t('${mb.toStringAsFixed(1)} MB', '${mb.toStringAsFixed(1)} MB'))
                    : _stageLabel,
                style: TextStyle(fontSize: 13, color: ink3),
              ),
              const SizedBox(height: 10),
              if (_stage == 'download')
                LinearProgressIndicator(
                  value: pct,
                  color: brand,
                  backgroundColor: DshColors.line(ctx),
                )
              else
                LinearProgressIndicator(color: brand, backgroundColor: DshColors.line(ctx)),
            ],
          );
        }),
        actions: [
          if (!_done)
            TextButton(onPressed: _onCancel, child: Text(L10n.t('取消', 'Cancel'))),
          if (_done) ...[
            if (_error != null)
              TextButton(
                onPressed: () => Navigator.of(context).pop(_error),
                child: Text(L10n.t('知道了', 'Got it')),
              )
            else
              FilledButton(
                onPressed: () => Navigator.of(context).pop(_result),
                child: Text(L10n.t('完成', 'Done')),
              ),
          ],
        ],
      ),
    );
  }
}