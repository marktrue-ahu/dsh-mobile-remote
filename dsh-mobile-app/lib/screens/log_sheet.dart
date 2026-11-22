// issue #136：应用日志查看/复制弹层。
// issue #154：记录级别（AppLog 写入阈值）与显示筛选拆分——
//   - 头部同时展示 `记录 ≥`（只读）与 `显示 ≥`（本地筛选 chip）；
//   - 显示筛选只影响本页，记住上次但绝不写 app_log_level、不改记录级别；
//   - 复制当前只含筛选后行，复制全部含所有已记录行；
//   - 旧格式无级别行原样显示，按 info 过滤/计数。
//
// 渲染仍用单块 SelectableText.rich（800 行不逐行建组件），文件/清理语义不变。
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../l10n.dart';
import '../logger.dart';
import '../theme.dart';
import '../toast.dart';
import 'sheets.dart';

void showLogSheet(BuildContext context) {
  showSheet(context, L10n.t('应用日志', 'App log'), [
    _LogSheetBody(read: AppLog.instance.readAll()),
  ]);
}

class _LogSheetBody extends StatefulWidget {
  const _LogSheetBody({required this.read});

  final Future<String> read;

  @override
  State<_LogSheetBody> createState() => _LogSheetBodyState();
}

class _LogSheetBodyState extends State<_LogSheetBody> {
  static final _levelPrefix = RegExp(
    r'^(\[\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?\] )(\[(?:DEBUG|INFO|WARN|ERROR)\])(.*)$',
  );
  String? _text;
  List<AppLogEntry> _all = const [];
  AppLogLevel _displayLevel = AppLog.defaultDisplayLevel;

  /// 记录级别只读：只能在设置页修改，日志页不得改写。
  AppLogLevel get _recordLevel => AppLog.instance.level;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final display = await AppLog.instance.loadDisplayLevel();
    String text;
    try {
      text = await widget.read;
    } catch (_) {
      text = AppLog.instance.lines.join('\n');
    }
    if (!mounted) return;
    setState(() {
      _text = text;
      _all = AppLog.parseLines(text);
      _displayLevel = display;
    });
  }

  Future<void> _pickDisplayLevel() async {
    final msgr = ScaffoldMessenger.of(context);
    showChoiceSheet(
      context,
      title: L10n.t('日志显示筛选', 'Log display filter'),
      items: [
        (
          id: AppLogLevel.debug.name,
          name: L10n.t('调试（debug）', 'Debug'),
          sub: L10n.t(
            '显示所有已记录日志；不会补记未写入的 debug',
            'Show all recorded logs; debug lines that were not recorded cannot be recovered',
          ),
        ),
        (
          id: AppLogLevel.info.name,
          name: L10n.t('信息（info）', 'Info'),
          sub: L10n.t('显示信息及以上', 'Show info and above'),
        ),
        (
          id: AppLogLevel.warn.name,
          name: L10n.t('警告（warn）', 'Warning'),
          sub: L10n.t('仅显示警告与错误', 'Show warnings and errors only'),
        ),
        (
          id: AppLogLevel.error.name,
          name: L10n.t('错误（error）', 'Error'),
          sub: L10n.t('仅显示错误', 'Show errors only'),
        ),
      ],
      selectedId: _displayLevel.name,
      footnote: L10n.t(
        '仅筛选显示，不改变记录级别；未记录的低级别日志无法补回。',
        'Display filter only; does not change the recording level. Lower-level lines that were not recorded cannot be recovered.',
      ),
      onPick: (id) async {
        final level = AppLogLevel.tryParse(id) ?? AppLog.defaultDisplayLevel;
        final failure = await AppLog.instance.setDisplayLevel(level);
        if (!mounted) return;
        if (failure != null) {
          showToastAt(msgr, '${L10n.t('设置失败：', 'Failed: ')}$failure');
          return;
        }
        setState(() => _displayLevel = level);
      },
    );
  }

  List<AppLogEntry> get _displayed =>
      AppLog.filterEntries(_all, _displayLevel).reversed.toList();

  void _copyCurrent() {
    final msgr = ScaffoldMessenger.of(context);
    final rows = _displayed;
    if (rows.isEmpty) return;
    Clipboard.setData(ClipboardData(text: rows.map((e) => e.raw).join('\n')));
    showToastAt(
      msgr,
      L10n.t(
        '已复制 ${rows.length} 行（显示 ≥ ${_displayLevel.label}）',
        'Copied ${rows.length} lines (display ≥ ${_displayLevel.label})',
      ),
    );
  }

  void _copyAll() {
    final msgr = ScaffoldMessenger.of(context);
    if (_all.isEmpty) return;
    Clipboard.setData(ClipboardData(text: _all.map((e) => e.raw).join('\n')));
    showToastAt(
      msgr,
      L10n.t('已复制全部 ${_all.length} 行', 'Copied all ${_all.length} lines'),
    );
  }

  Future<void> _clear() async {
    final msgr = ScaffoldMessenger.of(context);
    await AppLog.instance.clear();
    if (!mounted) return;
    setState(() {
      _text = '';
      _all = const [];
    });
    showToastAt(msgr, L10n.t('日志已清空', 'Log cleared'));
  }

  @override
  Widget build(BuildContext context) {
    final ink3 = DshColors.ink3(context);
    if (_text == null) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 32),
        child: Center(
          child: SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      );
    }
    final displayed = _displayed;
    final hasLegacy = _all.any((entry) => !entry.hasLevel);
    final hiddenBelow = _all.length - displayed.length;
    final displayBelowRecord = _displayLevel.rank < _recordLevel.rank;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          excludeSemantics: true,
          label: L10n.t(
            '当前记录级别 ${_recordLevel.label}；最近 ${_all.length} 行',
            'Recording level ${_recordLevel.label}; last ${_all.length} lines',
          ),
          child: Text(
            L10n.t(
              '最近 ${_all.length} 行 · 记录 ≥ ${_recordLevel.label}',
              'Last ${_all.length} lines · recording ≥ ${_recordLevel.label}',
            ),
            key: const ValueKey('log-summary'),
            style: TextStyle(fontSize: 11, color: ink3),
          ),
        ),
        const SizedBox(height: 4),
        Row(
          children: [
            Text(
              L10n.t('显示 ≥', 'Display ≥'),
              style: TextStyle(fontSize: 11.5, color: ink3),
            ),
            const SizedBox(width: 6),
            Semantics(
              button: true,
              excludeSemantics: true,
              label: L10n.t(
                '日志显示筛选，当前 ${_displayLevel.label}；仅筛选显示',
                'Log display filter, currently ${_displayLevel.label}; view only',
              ),
              onTap: _pickDisplayLevel,
              child: ConstrainedBox(
                constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
                child: InkWell(
                  key: const ValueKey('log-level-chip'),
                  onTap: _pickDisplayLevel,
                  borderRadius: BorderRadius.circular(999),
                  child: Center(
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 6,
                      ),
                      decoration: BoxDecoration(
                        color: DshColors.brandSoft(context),
                        borderRadius: BorderRadius.circular(999),
                        border: Border.all(color: DshColors.brand(context)),
                      ),
                      child: Text(
                        '${_displayLevel.label} ▾',
                        maxLines: 1,
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                          color: DshColors.brand(context),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
        Padding(
          padding: const EdgeInsets.only(top: 2),
          child: Text(
            L10n.t(
              '仅筛选显示，不改变记录级别',
              'Display filter only; recording level is unchanged',
            ),
            key: const ValueKey('log-filter-hint'),
            style: TextStyle(fontSize: 11, color: ink3),
          ),
        ),
        if (hasLegacy)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              L10n.t(
                '旧日志行无级别，按 info 处理',
                'Legacy log lines have no level; treated as info',
              ),
              key: const ValueKey('log-legacy-hint'),
              style: TextStyle(fontSize: 11, color: ink3),
            ),
          ),
        if (displayBelowRecord)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              L10n.t(
                '显示级别低于记录级别；更详细日志未被记录',
                'Display level is below the recording level; more detailed lines were not recorded',
              ),
              key: const ValueKey('log-display-below-record'),
              style: TextStyle(fontSize: 11, color: DshColors.warn(context)),
            ),
          ),
        const SizedBox(height: 8),
        ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 300),
          child: SingleChildScrollView(
            child: displayed.isEmpty
                ? Column(
                    children: [
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 20),
                        child: Text(
                          _all.isEmpty
                              ? L10n.t('（暂无日志）', '(No logs)')
                              : L10n.t(
                                  '当前显示级别下没有日志',
                                  'No logs at the current display level',
                                ),
                          key: const ValueKey('log-empty'),
                          textAlign: TextAlign.center,
                          style: TextStyle(fontSize: 11.5, color: ink3),
                        ),
                      ),
                      if (_all.isNotEmpty)
                        Text(
                          L10n.t(
                            '调低显示筛选可查看更多已记录日志',
                            'Lower the display filter to see more recorded logs',
                          ),
                          key: const ValueKey('log-empty-hint'),
                          textAlign: TextAlign.center,
                          style: TextStyle(fontSize: 11, color: ink3),
                        ),
                    ],
                  )
                : SelectableText.rich(
                    TextSpan(
                      style: TextStyle(
                        fontSize: 11.5,
                        height: 1.6,
                        color: DshColors.ink(context),
                        fontFamily: 'monospace',
                      ),
                      children: _logSpans(displayed, context),
                    ),
                    key: const ValueKey('log-text'),
                  ),
          ),
        ),
        const SizedBox(height: 12),
        FilledButton(
          key: const ValueKey('log-copy-current'),
          onPressed: displayed.isEmpty ? null : _copyCurrent,
          child: Text(
            L10n.t(
              '复制当前（${displayed.length} 行）',
              'Copy current (${displayed.length} lines)',
            ),
          ),
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: Semantics(
                button: true,
                excludeSemantics: true,
                enabled: _all.isNotEmpty,
                label: L10n.t(
                  '复制全部，已记录 ${_all.length} 行（含显示筛选外）',
                  'Copy all ${_all.length} recorded lines (including filtered out)',
                ),
                onTap: _all.isEmpty ? null : _copyAll,
                child: OutlinedButton(
                  key: const ValueKey('log-copy-all'),
                  onPressed: _all.isEmpty ? null : _copyAll,
                  child: Text(L10n.t('复制全部', 'Copy all')),
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: OutlinedButton(
                key: const ValueKey('log-clear'),
                onPressed: _all.isEmpty ? null : _clear,
                child: Text(L10n.t('清空', 'Clear')),
              ),
            ),
          ],
        ),
        if (hiddenBelow > 0)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              L10n.t(
                '复制全部含 $hiddenBelow 行被显示筛选隐藏（含旧格式）',
                'Copy all includes $hiddenBelow lines hidden by the display filter (including legacy)',
              ),
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 11, color: ink3),
            ),
          ),
      ],
    );
  }

  List<TextSpan> _logSpans(List<AppLogEntry> entries, BuildContext context) {
    final debug = DshColors.ink3(context);
    final info = DshColors.ink2(context);
    final warn = DshColors.warn(context);
    final error = DshColors.danger(context);
    final colors = {
      AppLogLevel.debug: debug,
      AppLogLevel.info: info,
      AppLogLevel.warn: warn,
      AppLogLevel.error: error,
    };
    final spans = <TextSpan>[];
    for (var i = 0; i < entries.length; i++) {
      final entry = entries[i];
      if (!entry.hasLevel) {
        spans.add(TextSpan(text: entry.raw));
      } else {
        final match = _levelPrefix.firstMatch(entry.raw);
        if (match == null) {
          spans.add(TextSpan(text: entry.raw));
        } else {
          spans.add(TextSpan(text: match.group(1)));
          spans.add(
            TextSpan(
              text: match.group(2),
              style: TextStyle(
                color: colors[entry.level],
                fontWeight: FontWeight.w600,
              ),
            ),
          );
          spans.add(TextSpan(text: match.group(3)));
        }
      }
      if (i != entries.length - 1) spans.add(const TextSpan(text: '\n'));
    }
    return spans;
  }
}
