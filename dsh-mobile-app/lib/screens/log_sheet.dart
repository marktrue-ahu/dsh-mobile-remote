// issue #136：应用日志查看/复制弹层。
//
// 设计要点：
//   - 级别阈值同时决定展示行（写入侧已由 AppLog 过滤）；
//   - 单块 SelectableText.rich 渲染 800 行，不逐行建组件；
//   - 复制当前（过滤后）/ 复制全部（含低级别与旧格式）明确计数；
//   - 旧格式无级别行原样显示，按 info 过滤/计数。
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
  AppLogLevel _level = AppLog.instance.level;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
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
    });
  }

  Future<void> _pickLevel() async {
    final msgr = ScaffoldMessenger.of(context);
    showChoiceSheet(
      context,
      title: L10n.t('日志记录级别', 'Log level'),
      items: [
        (
          id: AppLogLevel.debug.name,
          name: L10n.t('调试（debug）', 'Debug'),
          sub: L10n.t(
            '记录所有日志，包括高频排障信息；可能增加日志体积',
            'Record everything, including high-frequency troubleshooting data; may increase log size',
          ),
        ),
        (
          id: AppLogLevel.info.name,
          name: L10n.t('信息（info）', 'Info'),
          sub: L10n.t(
            '默认；启动、连接、关键动作',
            'Default; startup, connection, key actions',
          ),
        ),
        (
          id: AppLogLevel.warn.name,
          name: L10n.t('警告（warn）', 'Warning'),
          sub: L10n.t('仅警告与错误', 'Warnings and errors only'),
        ),
        (
          id: AppLogLevel.error.name,
          name: L10n.t('错误（error）', 'Error'),
          sub: L10n.t('仅错误', 'Errors only'),
        ),
      ],
      selectedId: _level.name,
      footnote: L10n.t(
        '只影响之后写入与日志页展示；已有日志不删除。低于当前级别的历史行会被隐藏。',
        'Affects future writes and this view only; existing logs are not deleted. Older lines below the level are hidden.',
      ),
      onPick: (id) async {
        final level = AppLogLevel.tryParse(id) ?? AppLogLevel.info;
        final failure = await AppLog.instance.setLevel(level);
        if (!mounted) return;
        if (failure != null) {
          showToastAt(msgr, '${L10n.t('设置失败：', 'Failed: ')}$failure');
          return;
        }
        setState(() => _level = level);
      },
    );
  }

  List<AppLogEntry> get _displayed =>
      AppLog.filterEntries(_all, _level).reversed.toList();

  void _copyCurrent() {
    final msgr = ScaffoldMessenger.of(context);
    final rows = _displayed;
    if (rows.isEmpty) return;
    Clipboard.setData(ClipboardData(text: rows.map((e) => e.raw).join('\n')));
    showToastAt(
      msgr,
      L10n.t(
        '已复制 ${rows.length} 行（≥ ${_level.label}）',
        'Copied ${rows.length} lines (≥ ${_level.label})',
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
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                L10n.t(
                  '最近 ${_all.length} 行 · 显示 ≥ ${_level.label}',
                  'Last ${_all.length} lines · showing ≥ ${_level.label}',
                ),
                key: const ValueKey('log-summary'),
                style: TextStyle(fontSize: 11, color: ink3),
              ),
            ),
            const SizedBox(width: 8),
            Semantics(
              button: true,
              label: L10n.t(
                '日志级别，当前 ${_level.label}',
                'Log level, currently ${_level.label}',
              ),
              child: InkWell(
                key: const ValueKey('log-level-chip'),
                onTap: _pickLevel,
                borderRadius: BorderRadius.circular(999),
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
                    '${_level.label} ▾',
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
          ],
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
        const SizedBox(height: 8),
        ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 300),
          child: SingleChildScrollView(
            child: displayed.isEmpty
                ? Padding(
                    padding: const EdgeInsets.symmetric(vertical: 20),
                    child: Text(
                      _all.isEmpty
                          ? L10n.t('（暂无日志）', '(No logs)')
                          : L10n.t('当前级别下没有日志', 'No logs at the current level'),
                      key: const ValueKey('log-empty'),
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 11.5, color: ink3),
                    ),
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
              child: OutlinedButton(
                key: const ValueKey('log-copy-all'),
                onPressed: _all.isEmpty ? null : _copyAll,
                child: Text(L10n.t('复制全部', 'Copy all')),
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
                '复制全部含 $hiddenBelow 行低于当前级别/旧格式日志',
                'Copy all includes $hiddenBelow lines below the current level or legacy',
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
