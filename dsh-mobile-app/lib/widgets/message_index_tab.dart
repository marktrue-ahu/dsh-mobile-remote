// issue #144：「代理 → 消息」当前会话消息索引页签。
//
// 设计依据：3.3.0 UI 设计 §3（GitLab #144 note 3450、note 3458 已审定）。
// 只读：筛选全部/对话/团队/代理；行 = 分类图标 + 分类·发送方→接收方 + 正文预览 +
// 时间 + 投递状态（有则）；点按关闭面板并跳回时间线 seq。空/加载/失败/降级完整。

import 'dart:async';

import 'package:flutter/material.dart';

import '../l10n.dart';
import '../message_index.dart';
import '../theme.dart';

class MessageIndexTab extends StatefulWidget {
  /// null = 旧宿主不提供索引（降级说明，不伪造数据）。
  final MessageIndexLoader? loader;
  final MessageOpenHandler? onOpenMessage;

  const MessageIndexTab({super.key, this.loader, this.onOpenMessage});

  @override
  State<MessageIndexTab> createState() => _MessageIndexTabState();
}

class _MessageIndexTabState extends State<MessageIndexTab>
    with AutomaticKeepAliveClientMixin<MessageIndexTab> {
  // 面板内切页签/筛选后返回时保留本次筛选与滚动位置（关闭面板即重置）。
  @override
  bool get wantKeepAlive => true;
  final ScrollController _listCtrl = ScrollController();
  MessageIndexSnapshot? _snapshot;
  MessageIndexCategory? _filter;
  bool _loading = false;
  String? _error;
  int? _jumpingSeq;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _listCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final loader = widget.loader;
    if (loader == null) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final snapshot = await loader();
      if (!mounted) return;
      setState(() {
        _snapshot = snapshot;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  void _setFilter(MessageIndexCategory? category) {
    if (_filter == category) return;
    setState(() => _filter = category);
    if (_listCtrl.hasClients) _listCtrl.jumpTo(0);
  }

  List<MessageIndexEntry> get _filtered {
    final entries = _snapshot?.entries ?? const <MessageIndexEntry>[];
    final filter = _filter;
    if (filter == null) return entries;
    return entries.where((e) => e.category == filter).toList(growable: false);
  }

  Future<void> _open(MessageIndexEntry entry) async {
    final handler = widget.onOpenMessage;
    if (handler == null || _jumpingSeq != null) return;
    setState(() => _jumpingSeq = entry.seq);
    // 设计 §3：点按先关闭「代理」面板，再回聊天页定位（定位反馈由聊天页负责）。
    Navigator.of(context).maybePop();
    unawaited(handler(entry.seq));
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final unsupported = widget.loader == null;
    final entries = _filtered;
    return Column(
      children: [
        _FilterBar(selected: _filter, onSelected: _setFilter),
        Expanded(
          child: unsupported
              ? const _EmptyState(
                  key: ValueKey<String>('message-index-unsupported'),
                  icon: Icons.forum_outlined,
                  title: '当前电脑端不支持消息索引',
                  subtitle: '升级电脑端后，可在这里查看当前会话的消息并跳回对话。',
                )
              : _loading && _snapshot == null
              ? const Center(
                  child: SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                )
              : _error != null && _snapshot == null
              ? _LoadError(message: _error!, onRetry: _load)
              : RefreshIndicator(
                  onRefresh: _load,
                  child: _buildList(context, entries),
                ),
        ),
      ],
    );
  }

  Widget _buildList(BuildContext context, List<MessageIndexEntry> entries) {
    if (entries.isEmpty) {
      if (_filter == null) {
        return ListView(
          controller: _listCtrl,
          physics: const AlwaysScrollableScrollPhysics(),
          children: const [
            _EmptyState(
              key: ValueKey<String>('message-index-empty-all'),
              icon: Icons.forum_outlined,
              title: '当前会话还没有可索引的消息',
              subtitle: '用户、主代理、团队与代理之间的消息会显示在这里。',
            ),
          ],
        );
      }
      return ListView(
        controller: _listCtrl,
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          _EmptyState(
            key: const ValueKey<String>('message-index-empty-filter'),
            icon: Icons.filter_alt_off_outlined,
            title: '该分类暂无消息',
            subtitle: '切换到「全部」查看当前会话的其它消息。',
            action: TextButton(
              key: const ValueKey<String>('message-index-show-all'),
              onPressed: () => _setFilter(null),
              child: Text(L10n.t('查看全部', 'Show all')),
            ),
          ),
        ],
      );
    }

    // 日期分隔 + 消息行（新→旧；分隔只在日期变化时出现）。
    final rows = <Widget>[];
    String? lastDateKey;
    for (var i = 0; i < entries.length; i++) {
      final entry = entries[i];
      final dateKey = messageDateKey(entry.time);
      if (dateKey != lastDateKey) {
        lastDateKey = dateKey;
        rows.add(
          Padding(
            key: ValueKey<String>('message-date:$dateKey'),
            padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
            child: Text(
              messageDateLabel(entry.time),
              style: TextStyle(fontSize: 11, color: DshColors.ink3(context)),
            ),
          ),
        );
      }
      rows.add(
        _MessageRow(
          entry: entry,
          busy: _jumpingSeq == entry.seq,
          onTap: widget.onOpenMessage == null || !entry.visibleInTimeline
              ? null
              : () => _open(entry),
        ),
      );
      if (i != entries.length - 1) {
        rows.add(
          Divider(height: 1, thickness: 1, color: DshColors.line(context)),
        );
      }
    }
    if (_snapshot?.hasEarlierHistory == true) {
      rows.add(
        Padding(
          key: const ValueKey<String>('message-index-degraded'),
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
          child: Text(
            L10n.t(
              '仅索引当前已加载的消息，更早消息可能未包含',
              'Only loaded messages are indexed; earlier messages may be missing',
            ),
            style: TextStyle(fontSize: 11, color: DshColors.ink3(context)),
          ),
        ),
      );
    }
    return ListView(
      controller: _listCtrl,
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(0, 0, 0, 24),
      children: rows,
    );
  }
}

class _FilterBar extends StatelessWidget {
  final MessageIndexCategory? selected;
  final ValueChanged<MessageIndexCategory?> onSelected;

  const _FilterBar({required this.selected, required this.onSelected});

  @override
  Widget build(BuildContext context) {
    final brand = DshColors.brand(context);
    final brandSoft = DshColors.brandSoft(context);
    final line = DshColors.line(context);
    final surface = DshColors.surface(context);
    final ink2 = DshColors.ink2(context);
    final items = <({String label, MessageIndexCategory? value, Key key})>[
      (
        label: L10n.t('全部', 'All'),
        value: null,
        key: const ValueKey<String>('message-filter-all'),
      ),
      (
        label: messageCategoryLabel(MessageIndexCategory.conversation),
        value: MessageIndexCategory.conversation,
        key: const ValueKey<String>('message-filter-conversation'),
      ),
      (
        label: messageCategoryLabel(MessageIndexCategory.team),
        value: MessageIndexCategory.team,
        key: const ValueKey<String>('message-filter-team'),
      ),
      (
        label: messageCategoryLabel(MessageIndexCategory.agent),
        value: MessageIndexCategory.agent,
        key: const ValueKey<String>('message-filter-agent'),
      ),
    ];
    return SizedBox(
      height: 44,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        children: [
          for (final item in items)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: Semantics(
                button: true,
                selected: selected == item.value,
                child: InkWell(
                  key: item.key,
                  onTap: () => onSelected(item.value),
                  borderRadius: BorderRadius.circular(999),
                  // 视觉 chip 高 30，但整行 44 都是命中区（设计 §0.1）。
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 7),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 14),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: selected == item.value ? brandSoft : surface,
                        borderRadius: BorderRadius.circular(999),
                        border: Border.all(
                          color: selected == item.value ? brand : line,
                        ),
                      ),
                      child: Text(
                        item.label,
                        maxLines: 1,
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: selected == item.value ? brand : ink2,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _MessageRow extends StatelessWidget {
  final MessageIndexEntry entry;
  final bool busy;
  final VoidCallback? onTap;

  const _MessageRow({
    required this.entry,
    required this.busy,
    required this.onTap,
  });

  IconData get _icon => switch (entry.category) {
    MessageIndexCategory.conversation => Icons.chat_bubble_outline,
    MessageIndexCategory.team => Icons.groups_outlined,
    MessageIndexCategory.agent => Icons.smart_toy_outlined,
  };

  @override
  Widget build(BuildContext context) {
    final ink = DshColors.ink(context);
    final ink3 = DshColors.ink3(context);
    final ok = DshColors.ok(context);
    final delivery = entry.deliveryStatus;
    final semantics = [
      messageCategoryLabel(entry.category),
      '${entry.sender} → ${entry.target}',
      messageClockLabel(entry.time),
      if (delivery != null) messageDeliveryLabel(delivery),
      entry.visibleInTimeline
          ? L10n.t('跳转到对话', 'Jump to conversation')
          : L10n.t('不在当前对话中，无法跳转', 'Not in the conversation; cannot jump'),
    ].join('，');
    return Semantics(
      button: onTap != null,
      label: semantics,
      child: InkWell(
        key: ValueKey<String>('message-index-row:${entry.seq}'),
        onTap: busy ? null : onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 64),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 1),
                  child: Icon(_icon, size: 20, color: ink3),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '${messageCategoryLabel(entry.category)} · '
                        '${entry.sender} → ${entry.target}'
                        '${entry.visibleInTimeline ? '' : ' · ${L10n.t('仅日志', 'Log only')}'}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 11.5, color: ink3),
                      ),
                      if (entry.text.isNotEmpty) ...[
                        const SizedBox(height: 3),
                        Text(
                          entry.text,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 13.5,
                            color: ink,
                            height: 1.4,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                SizedBox(
                  width: 56,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text(
                        messageClockLabel(entry.time),
                        maxLines: 1,
                        style: TextStyle(fontSize: 11, color: ink3),
                      ),
                      if (busy) ...[
                        const SizedBox(height: 5),
                        SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: ink3,
                          ),
                        ),
                      ] else if (delivery != null) ...[
                        const SizedBox(height: 5),
                        FittedBox(
                          fit: BoxFit.scaleDown,
                          alignment: Alignment.centerRight,
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(
                                delivery == MessageDeliveryStatus.delivered
                                    ? Icons.check
                                    : Icons.schedule,
                                size: 12,
                                color:
                                    delivery == MessageDeliveryStatus.delivered
                                    ? ok
                                    : ink3,
                              ),
                              const SizedBox(width: 2),
                              Text(
                                messageDeliveryLabel(delivery),
                                maxLines: 1,
                                style: TextStyle(
                                  fontSize: 10.5,
                                  fontWeight: FontWeight.w600,
                                  color:
                                      delivery ==
                                          MessageDeliveryStatus.delivered
                                      ? ok
                                      : ink3,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
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

class _EmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final Widget? action;

  const _EmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    this.action,
  });

  @override
  Widget build(BuildContext context) {
    final ink3 = DshColors.ink3(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 72, 24, 24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 30, color: ink3),
          const SizedBox(height: 10),
          Text(
            title,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 4),
          Text(
            subtitle,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12.5, color: ink3, height: 1.4),
          ),
          if (action != null) ...[const SizedBox(height: 4), action!],
        ],
      ),
    );
  }
}

class _LoadError extends StatelessWidget {
  final String message;
  final Future<void> Function() onRetry;

  const _LoadError({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    final ink2 = DshColors.ink2(context);
    final ink3 = DshColors.ink3(context);
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 40, 16, 16),
      children: [
        Icon(Icons.error_outline, size: 28, color: ink2),
        const SizedBox(height: 8),
        Text(
          L10n.t('消息索引读取失败', 'Could not load message index'),
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 13.5, color: ink2),
        ),
        const SizedBox(height: 4),
        Text(
          message,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 12, color: ink3),
        ),
        const SizedBox(height: 8),
        Center(
          child: TextButton(
            key: const ValueKey<String>('message-index-retry'),
            onPressed: onRetry,
            child: Text(L10n.t('重试', 'Retry')),
          ),
        ),
      ],
    );
  }
}
