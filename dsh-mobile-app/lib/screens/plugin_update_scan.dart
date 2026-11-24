// issue #153：「检查全部更新」= **App 侧有界并发**（默认 3），不新增宿主批量端点。
//
// 契约（用户已裁决）：
//   - 只对 `management.canUpdate === true` 的行发起检查；
//   - `updateKind === "git"` → `skipped/git-update-desktop-required`，**不发请求**；
//   - 内置/本地/条目行（canUpdate 为 false）不检查；
//   - 取消 = 停派发 + 让在飞请求的结果被丢弃（已完成结果保留）；
//   - **绝不**调用 install/update/cancel，不创建 op、不返回 opId、不自动安装；
//   - 安装事务进行中也可检查（两者互不阻塞）。
import 'dart:async';

import '../plugin_inventory.dart';

/// 逐项检查的默认并发上限（有界，避免一次打满宿主 pnpm 并发）。
const pluginUpdateScanConcurrency = 3;

/// 单项检查结果里 `skipped` 的稳定原因码。
const pluginScanSkipGitDesktop = 'git-update-desktop-required';
const pluginScanSkipNotUpdatable = 'not-updatable';

/// 需要**发请求**检查的行（顺序稳定，便于 UI 按清单顺序展示进度）。
///
/// Git 来源的 bundle 即便 `canUpdate`（宿主配置渠道下的理论组合）也不能问 registry：
/// 它的新版本信息只有桌面端能拿到，所以在这里就排除，避免一次无意义的网络请求。
List<PluginInfo> pluginUpdateScanTargets(PluginInventory inventory) => inventory
    .plugins
    .where((p) => p.canUpdate && p.updateKind != 'git')
    .toList();

/// 全部“本应检查”的行（含 Git 来源，用于进度总数与 skipped 结果）。
List<PluginInfo> pluginUpdateScanCandidates(PluginInventory inventory) =>
    inventory.plugins.where((p) => p.canUpdate).toList();

/// 单项检查：把一次 `checkVersions` 归一到 `PluginUpdateCheckResult`。
///
/// 失败必须带 `errorCode`（不能只给一句人话），否则 UI 无法归因/重试。
PluginUpdateCheckResult pluginScanResultOf(
  PluginInfo plugin,
  PluginVersionCheck check,
) {
  final latest = _latestUsable(check);
  if (check.listed) {
    if (latest == null) {
      return PluginUpdateCheckResult(
        name: plugin.name,
        state: 'current',
        installed: check.installedVersion.isNotEmpty
            ? check.installedVersion
            : plugin.version,
        answeredRegistry: check.answeredRegistry,
      );
    }
    return PluginUpdateCheckResult(
      name: plugin.name,
      state: 'available',
      latest: latest.version,
      installed: check.installedVersion.isNotEmpty
          ? check.installedVersion
          : plugin.version,
      answeredRegistry: check.answeredRegistry,
    );
  }
  return PluginUpdateCheckResult(
    name: plugin.name,
    state: 'failed',
    installed: check.installedVersion.isNotEmpty
        ? check.installedVersion
        : plugin.version,
    errorCode: check.problem.isNotEmpty
        ? 'plugin-versions-${check.problem}'
        : 'plugin-versions-unavailable',
    reason: check.reason,
    answeredRegistry: check.answeredRegistry,
  );
}

/// 取可用的最高版本（不比较 SemVer：宿主已只返回“更新”的版本且新到旧排序）。
PluginVersionInfo? _latestUsable(PluginVersionCheck check) {
  for (final version in check.versions) {
    if (version.usable) return version;
  }
  return null;
}

/// issue #174：把「检查全部更新」已拿到的单项结果**回灌**成一次检查结果。
///
/// 详情 sheet 原来只看自己发起的检查，于是列表行已经显示「可更新 vX」时，点开还要
/// 再点一次「检查更新」。这里把列表已知的结果变成 `_check` 的初始值，让详情页直接
/// 呈现升级入口，不再要求二次检查。
///
/// 只有 `available` / `current` 能回灌：
/// - `available` → 一个可用版本（`pluginScanResultOf` 只取过 `usable` 版本）；
/// - `current` → 空版本列表（渲染为「已是最新版本」）；
/// - `failed` / `skipped` → 返回 null，保留「检查更新」按钮供用户重试（失败不该被
///   当成“已检查过”）。
PluginVersionCheck? pluginVersionCheckFromScan(PluginUpdateCheckResult? result) {
  if (result == null) return null;
  switch (result.state) {
    case 'available':
      if (result.latest.isEmpty) return null;
      return PluginVersionCheck(
        status: 'listed',
        installedVersion: result.installed,
        answeredRegistry: result.answeredRegistry,
        versions: [PluginVersionInfo(version: result.latest)],
      );
    case 'current':
      return PluginVersionCheck(
        status: 'listed',
        installedVersion: result.installed,
        answeredRegistry: result.answeredRegistry,
      );
    default:
      return null;
  }
}

/// 一次「检查全部更新」的运行句柄：有界并发、可取消、结果增量落地。
class PluginUpdateScanController {
  final Future<PluginVersionCheck> Function(String name) checkVersions;
  final int concurrency;
  final void Function(PluginUpdateScan scan) onUpdate;

  PluginUpdateScan _scan = const PluginUpdateScan();
  final Map<String, PluginUpdateCheckResult> _results = {};
  final Set<String> _cancelledTokens = {};

  /// issue #174：已被操作（升级/卸载/启停）作废的插件名。
  ///
  /// 只作废**这些**项：作废发生在升级成功之后，若该项的检查还在飞，
  /// 迟到的结果也必须丢弃，否则旧 `latest` 会重新贴回「可更新」。
  final Set<String> _invalidated = {};
  bool _running = false;
  int _token = 0;
  int _dispatched = 0;
  int _nextIndex = 0;
  List<PluginInfo> _targets = const [];

  PluginUpdateScanController({
    required this.checkVersions,
    required this.onUpdate,
    this.concurrency = pluginUpdateScanConcurrency,
  });

  PluginUpdateScan get scan => _scan;
  bool get running => _running;

  /// 取消：停派发 + 丢弃在飞结果；**已完成结果保留**。
  void cancel() {
    if (!_running) return;
    _running = false;
    _cancelledTokens.add('$_token');
    _scan = _scan.copyWith(running: false);
    onUpdate(_scan);
  }

  /// issue #174：让指定插件的扫描结果失效（**只丢这些项，其余项保留**）。
  ///
  /// 用于升级/卸载/启停成功后：版本或可更新状态已变，旧 `latest` 会让行继续显示
  /// 「可更新 vX」。同时把名字记进作废集合，使该轮仍在飞的结果到达后被丢弃。
  /// 返回是否有变化（无变化时不触发 `onUpdate`）。
  bool invalidate(Iterable<String> names) {
    final drop = names.where((value) => value.isNotEmpty).toSet();
    if (drop.isEmpty) return false;
    _invalidated.addAll(drop);
    final before = _results.length;
    _results.removeWhere((key, _) => drop.contains(key));
    if (_results.length == before) return false;
    _scan = _scan.copyWith(results: Map.unmodifiable(_results));
    onUpdate(_scan);
    return true;
  }

  /// 开始检查（同一时刻只跑一轮；再次调用先取消旧轮）。
  Future<void> start(PluginInventory inventory) async {
    if (_running) cancel();
    _token += 1;
    final token = _token;
    _results.clear();
    // 新一轮是完整的重查：上一轮被操作作废的项也要重新采信。
    _invalidated.clear();
    _cancelledTokens.removeWhere((value) => value != '$token');
    final candidates = pluginUpdateScanCandidates(inventory);
    _targets = pluginUpdateScanTargets(inventory);
    _nextIndex = 0;
    _dispatched = 0;
    _running = true;
    final initial = <String, PluginUpdateCheckResult>{};
    // Git 来源：不发请求，直接 skipped（桌面端才能升级）。
    for (final plugin in candidates) {
      if (plugin.updateKind == 'git') {
        initial[plugin.name] = PluginUpdateCheckResult(
          name: plugin.name,
          state: 'skipped',
          installed: plugin.version,
          reason: pluginScanSkipGitDesktop,
        );
      }
    }
    _results.addAll(initial);
    _scan = PluginUpdateScan(
      results: Map.unmodifiable(_results),
      totalItemCount: candidates.length,
      dispatched: 0,
      running: _targets.isNotEmpty,
    );
    if (_targets.isEmpty) {
      _running = false;
      _scan = _scan.copyWith(running: false);
      onUpdate(_scan);
      return;
    }
    onUpdate(_scan);
    await _drain(token);
  }

  /// 当前轮仍在跑（token 匹配且未被取消）。
  bool _isCurrent(int token) =>
      token == _token && _running && !_cancelledTokens.contains('$token');

  /// 有界并发的实现用 **N 个 worker** 而不是“派发/等待”状态机：
  /// worker 循环取下一个目标，天然保证最多 `concurrency` 个在飞，且取消后立刻停派发。
  Future<void> _drain(int token) async {
    final workers = <Future<void>>[];
    for (var i = 0; i < concurrency; i++) {
      workers.add(_worker(token));
    }
    await Future.wait(workers);
    if (!_isCurrent(token)) return;
    _running = false;
    _scan = _scan.copyWith(running: false);
    onUpdate(_scan);
  }

  Future<void> _worker(int token) async {
    while (_isCurrent(token)) {
      if (_nextIndex >= _targets.length) return;
      final plugin = _targets[_nextIndex];
      _nextIndex += 1;
      _dispatched += 1;
      _scan = _scan.copyWith(dispatched: _dispatched);
      onUpdate(_scan);
      PluginUpdateCheckResult result;
      try {
        final check = await checkVersions(plugin.name);
        result = pluginScanResultOf(plugin, check);
      } catch (e) {
        // 不能用“无更新”掩盖失败：失败必须有可归因 errorCode。
        result = PluginUpdateCheckResult(
          name: plugin.name,
          state: 'failed',
          installed: plugin.version,
          errorCode: _errorCodeOf(e),
        );
      }
      // 取消后到达的结果直接丢弃（不写进已完成集合，也不触发 UI 更新）。
      if (!_isCurrent(token)) return;
      // issue #174：该项已被操作作废（升级/卸载/启停已完成）→ 迟到的结果同样丢弃，
      // 不能把过期的「可更新」贴回该行；**只丢这一项**，其他项照常落结果。
      if (_invalidated.contains(plugin.name)) continue;
      _results[plugin.name] = result;
      _scan = _scan.copyWith(results: Map.unmodifiable(_results));
      onUpdate(_scan);
    }
  }

  String _errorCodeOf(Object error) {
    // 避免把宿主异常原文当码：只取稳定 code，未知一律 check-failed。
    try {
      final code = (error as dynamic).code;
      if (code is String && code.trim().isNotEmpty) return code.trim();
    } catch (_) {
      // 不是 ApiException：落到稳定兜底码。
    }
    return 'check-failed';
  }
}
