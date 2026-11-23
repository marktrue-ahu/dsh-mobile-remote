// issue #153：插件主页面化（一页三 Tab）+ 安装源选择页的展示组件。
//
// 这些组件只渲染宿主已判定的事实（分类/HIDDEN/可更新），不在 App 侧重算分类：
// 谓词与 `EXPERIMENTAL_BUNDLES` 静态表都在插件宿主侧（`lib/experimental-bundles.js`）。
import 'package:flutter/material.dart';

import '../l10n.dart';
import '../plugin_inventory.dart';
import '../theme.dart';

/// 三个产品分类的固定顺序（Tab 顺序与语义都是产品契约，不随数据变）。
const pluginCategoryOrder = <String>['builtin', 'experimental', 'custom'];

/// tone 底色：不做成新令牌，按 tone 12% 叠在 surface 上（深浅色都成立）。
Color _toneSoft(BuildContext context, Color tone) => Color.alphaBlend(
  tone.withValues(alpha: 0.12),
  DshColors.surface(context),
);

String pluginCategoryLabel(String kind) => switch (kind) {
  'builtin' => L10n.t('内置', 'Built-in'),
  'experimental' => L10n.t('实验性', 'Experimental'),
  'custom' => L10n.t('自定义', 'Custom'),
  _ => L10n.t('未分类', 'Unclassified'),
};

/// 每个 Tab 的搜索提示（随 Tab 变化，不搜别的 Tab）。
String pluginSearchHint(String kind) => switch (kind) {
  'builtin' => L10n.t('搜索内置插件', 'Search built-in plugins'),
  'experimental' => L10n.t('搜索实验性插件', 'Search experimental plugins'),
  _ => L10n.t('搜索自定义插件', 'Search custom plugins'),
};

/// 每个 Tab 的空态（分类之间不混用文案）。
String pluginTabEmptyText(String kind) => switch (kind) {
  'builtin' => L10n.t('没有内置插件', 'No built-in plugins'),
  'experimental' => L10n.t('此电脑版本没有匹配的实验性插件', 'No experimental plugins for this desktop version'),
  _ => L10n.t('没有自定义插件', 'No custom plugins'),
};

String pluginTabNoInstallableText(String kind) => switch (kind) {
  'builtin' => L10n.t('配置渠道没有可安装的内置插件', 'No built-in plugins to install from the configured source'),
  'experimental' => L10n.t('配置渠道没有可安装的实验性插件', 'No experimental plugins to install from the configured source'),
  _ => L10n.t('配置渠道没有可安装的自定义插件', 'No custom plugins to install from the configured source'),
};

/// 分类标签（文字 + tone，不依赖颜色区分）。
class PluginCategoryTag extends StatelessWidget {
  final PluginCategory category;
  const PluginCategoryTag({super.key, required this.category});

  @override
  Widget build(BuildContext context) {
    final (fg, bg) = switch (category.kind) {
      'experimental' => (DshColors.warn(context), _toneSoft(context, DshColors.warn(context))),
      'builtin' => (DshColors.ink2(context), DshColors.brandSoft(context)),
      'custom' => (DshColors.ink2(context), DshColors.line(context)),
      _ => (DshColors.ink3(context), DshColors.line(context)),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        category.displayLabel,
        style: TextStyle(
          fontSize: 10.5,
          fontWeight: FontWeight.w600,
          color: fg,
        ),
      ),
    );
  }
}

/// 三 Tab 选择条：等权、选中态 brand + 2dp indicator（320 下允许横向滚动）。
class PluginCategoryTabs extends StatelessWidget {
  final String selected;
  final Map<String, int> counts;
  final ValueChanged<String> onSelect;

  const PluginCategoryTabs({
    super.key,
    required this.selected,
    required this.counts,
    required this.onSelect,
  });

  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.sizeOf(context).width >= 360;
    final scale = MediaQuery.textScalerOf(context).scale(13.5);
    // 2.0x 下三格等分会裁字：退化为可滚动（标签保最小宽度）。
    final scrollable = scale >= 24;
    final row = Row(
      children: [
        for (final kind in pluginCategoryOrder) ...[
          if (kind != pluginCategoryOrder.first) const SizedBox(width: 8),
          if (scrollable)
            _tab(context, kind, minWidth: scale * 3.2)
          else
            Expanded(child: _tab(context, kind)),
        ],
      ],
    );
    if (!wide && scrollable) {
      return SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: IntrinsicWidth(child: row),
      );
    }
    return row;
  }

  Widget _tab(BuildContext context, String kind, {double minWidth = 0}) {
    final active = kind == selected;
    final brand = DshColors.brand(context);
    final ink2 = DshColors.ink2(context);
    final count = counts[kind];
    return Semantics(
      selected: active,
      button: true,
      label: '${pluginCategoryLabel(kind)}${count == null ? '' : ' $count'}',
      child: Material(
        color: active ? DshColors.brandSoft(context) : DshColors.surface(context),
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: () => onSelect(kind),
          child: Container(
            constraints: BoxConstraints(minHeight: 46, minWidth: minWidth),
            alignment: Alignment.center,
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(10),
              border: Border.all(
                color: active ? brand.withValues(alpha: 0.45) : DshColors.line(context),
              ),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  pluginCategoryLabel(kind),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w600,
                    color: active ? brand : ink2,
                  ),
                ),
                if (count != null) ...[
                  const SizedBox(height: 1),
                  Text(
                    '$count',
                    style: TextStyle(
                      fontSize: 11,
                      color: active ? brand : DshColors.ink3(context),
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
}

/// 「检查全部更新」进度/汇总 banner。
class PluginUpdateScanBanner extends StatelessWidget {
  final PluginUpdateScan scan;
  final VoidCallback onCancel;
  const PluginUpdateScanBanner({
    super.key,
    required this.scan,
    required this.onCancel,
  });

  @override
  Widget build(BuildContext context) {
    final running = scan.running;
    final summary = running
        ? L10n.t(
            '正在检查 ${scan.dispatched}/${scan.totalItemCount}…',
            'Checking ${scan.dispatched}/${scan.totalItemCount}…',
          )
        : L10n.t(
            '${scan.availableCount} 个可更新 · ${scan.currentCount} 最新 · ${scan.failedCount} 失败'
            '${scan.skippedCount > 0 ? ' · ${scan.skippedCount} 跳过' : ''}',
            '${scan.availableCount} updatable · ${scan.currentCount} up to date · '
                '${scan.failedCount} failed'
                '${scan.skippedCount > 0 ? ' · ${scan.skippedCount} skipped' : ''}',
          );
    return Semantics(
      liveRegion: true,
      child: Container(
        margin: const EdgeInsets.only(top: 10),
        padding: const EdgeInsets.fromLTRB(12, 8, 6, 8),
        decoration: BoxDecoration(
          color: DshColors.brandSoft(context),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: DshColors.line(context)),
        ),
        child: Row(
          children: [
            if (running)
              const SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            else
              Icon(
                scan.failedCount > 0
                    ? Icons.warning_amber_outlined
                    : Icons.check_circle_outline,
                size: 16,
                color: scan.failedCount > 0
                    ? DshColors.warn(context)
                    : DshColors.ok(context),
              ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                summary,
                style: TextStyle(
                  fontSize: 12,
                  height: 1.35,
                  color: DshColors.ink2(context),
                ),
              ),
            ),
            if (running)
              TextButton(
                onPressed: onCancel,
                child: Text(L10n.t('取消', 'Cancel')),
              ),
          ],
        ),
      ),
    );
  }
}

/// 行内检查结果标签（可更新 / 最新 / 检查失败 / 跳过）。
class PluginScanResultTag extends StatelessWidget {
  final PluginUpdateCheckResult result;
  final VoidCallback? onRetry;
  final bool compact;

  const PluginScanResultTag({
    super.key,
    required this.result,
    this.onRetry,
    this.compact = false,
  });

  @override
  Widget build(BuildContext context) {
    final (text, fg, bg, tooltip) = switch (result.state) {
      'available' => (
        L10n.t('可更新 v${result.latest}', 'v${result.latest} available'),
        DshColors.brand(context),
        DshColors.brandSoft(context),
        result.answeredRegistry.isEmpty
            ? L10n.t('有新版本可升级', 'A newer version is available')
            : L10n.t('来自 ${result.answeredRegistry}', 'From ${result.answeredRegistry}'),
      ),
      'current' => (
        L10n.t('最新', 'Up to date'),
        DshColors.ok(context),
        _toneSoft(context, DshColors.ok(context)),
        L10n.t('没有更新版本', 'No newer version'),
      ),
      'skipped' => (
        L10n.t('跳过', 'Skipped'),
        DshColors.ink3(context),
        DshColors.line(context),
        result.reason.isEmpty ? '' : result.reason,
      ),
      _ => (
        L10n.t('检查失败', 'Check failed'),
        DshColors.danger(context),
        _toneSoft(context, DshColors.danger(context)),
        result.errorCode.isEmpty ? '' : result.errorCode,
      ),
    };
    final tag = Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(6),
      ),
      // 不截断文案：版本号是判断依据，窄屏允许折行（标签在 Wrap 里，不会横向溢出）。
      child: Text(
        text,
        maxLines: compact ? 2 : 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w600, color: fg),
      ),
    );
    final wrapped = tooltip.isEmpty ? tag : Tooltip(message: tooltip, child: tag);
    if (result.isFailed && onRetry != null) {
      return InkWell(
        onTap: onRetry,
        borderRadius: BorderRadius.circular(6),
        child: Padding(
          padding: const EdgeInsets.all(4),
          child: wrapped,
        ),
      );
    }
    return wrapped;
  }
}

/// 「显示隐藏项」开关（无插件页的 bundle 默认不占主列表）。
class PluginHiddenToggle extends StatelessWidget {
  final bool value;
  final int hiddenCount;
  final ValueChanged<bool> onChanged;
  const PluginHiddenToggle({
    super.key,
    required this.value,
    required this.hiddenCount,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: () => onChanged(!value),
      child: Container(
        constraints: const BoxConstraints(minHeight: 44),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              value ? Icons.visibility_outlined : Icons.visibility_off_outlined,
              size: 15,
              color: DshColors.ink2(context),
            ),
            const SizedBox(width: 6),
            Text(
              L10n.t('显示隐藏项（$hiddenCount）', 'Show hidden ($hiddenCount)'),
              style: TextStyle(fontSize: 12, color: DshColors.ink2(context)),
            ),
            const SizedBox(width: 4),
            Switch(
              value: value,
              onChanged: onChanged,
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
          ],
        ),
      ),
    );
  }
}

/// 分类表与 DSH 版本不匹配的提示（仍展示分类，只提示未覆盖）。
class PluginClassificationNotice extends StatelessWidget {
  final PluginClassification classification;
  const PluginClassificationNotice({super.key, required this.classification});

  @override
  Widget build(BuildContext context) {
    final dsh = classification.dshVersion.isEmpty
        ? L10n.t('未知版本', 'unknown version')
        : classification.dshVersion;
    return Container(
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.fromLTRB(12, 9, 12, 9),
      decoration: BoxDecoration(
        color: _toneSoft(context, DshColors.warn(context)),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: DshColors.line(context)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            Icons.info_outline,
            size: 16,
            color: DshColors.warn(context),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              L10n.t(
                '分类表与当前 DSH 版本不匹配（DSH $dsh，表 ${classification.tableVersion}）：'
                    '下面仍按已知分类展示，未覆盖的插件可能归类不准。',
                'The classification table does not match this DSH version '
                    '(DSH $dsh, table ${classification.tableVersion}). '
                    'Known categories are still shown; uncovered plugins may be misclassified.',
              ),
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
  }
}

/// 扁平降级提示：宿主不提供分类时，页面退回单列表（不伪造三 Tab）。
class PluginCategoryUnavailableNotice extends StatelessWidget {
  const PluginCategoryUnavailableNotice({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.fromLTRB(12, 9, 12, 9),
      decoration: BoxDecoration(
        color: DshColors.surface(context),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: DshColors.line(context)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            Icons.info_outline,
            size: 16,
            color: DshColors.ink3(context),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              L10n.t(
                '当前电脑端不提供插件分类，已切换为「已安装（未分类）」列表。',
                'This desktop does not report plugin categories; showing a flat installed list.',
              ),
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
  }
}

/// 实验性 Tab 段首说明（风险与来源都写清楚，不靠颜色/标签)。
class PluginExperimentalNotice extends StatelessWidget {
  final String tableVersion;
  const PluginExperimentalNotice({super.key, this.tableVersion = ''});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.fromLTRB(12, 9, 12, 9),
      decoration: BoxDecoration(
        color: _toneSoft(context, DshColors.warn(context)),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: DshColors.line(context)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            Icons.warning_amber_outlined,
            size: 16,
            color: DshColors.warn(context),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              L10n.t(
                '实验性功能可能不稳定；分类来自当前 DSH 版本的静态 EXPERIMENTAL_BUNDLES 表'
                    '${tableVersion.isEmpty ? '' : '（表 $tableVersion）'}。',
                'Experimental features may be unstable; categories come from the static '
                    'EXPERIMENTAL_BUNDLES table of the current DSH version'
                    '${tableVersion.isEmpty ? '' : ' (table $tableVersion)'}.',
              ),
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
  }
}

/// 宿主安装/升级步骤的可读标签（安装源页与操作 banner 共用）。
String pluginStepLabel(String key) => switch (key) {
  'prepare' => L10n.t('准备', 'Prepare'),
  'install' => L10n.t('安装', 'Install'),
  'enable' => L10n.t('启用', 'Enable'),
  'check' => L10n.t('检查版本', 'Check version'),
  'remove' => L10n.t('停止并移除旧版本', 'Stop and remove old version'),
  'restore' => L10n.t('恢复旧版本', 'Restore old version'),
  _ => key,
};

String pluginStepStateLabel(String state) => switch (state) {
  'done' => L10n.t('完成', 'done'),
  'running' => L10n.t('进行中', 'running'),
  'failed' => L10n.t('失败', 'failed'),
  'skipped' => L10n.t('跳过', 'skipped'),
  _ => L10n.t('待处理', 'pending'),
};
