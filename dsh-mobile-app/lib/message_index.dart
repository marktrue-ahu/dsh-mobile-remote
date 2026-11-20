// issue #144：当前会话消息索引（纯逻辑层）。
//
// 只把消息型事件投影成索引用行：user/assistant/team/agent；工具/过程/推理/审批/
// todo/turn 事件都不进索引。数据来自当前会话已加载的时间线事件（不新增持久化），
// 团队 queued/delivered 按 messageId 合并成一行。
//
// fail-open：任何字段缺省/类型不符都退化为可读占位，绝不让单条异常事件打断索引构建。

import 'l10n.dart';
import 'models.dart';

enum MessageIndexCategory { conversation, team, agent }

/// 面板打开/下拉刷新时读取当前已加载窗口的消息索引。
typedef MessageIndexLoader = Future<MessageIndexSnapshot> Function();

/// 点按消息行后回到对话时间线定位；面板已 pop，失败提示由聊天页负责。
typedef MessageOpenHandler = Future<void> Function(int seq);

enum MessageDeliveryStatus { queued, delivered }

String messageCategoryLabel(MessageIndexCategory category) =>
    switch (category) {
      MessageIndexCategory.conversation => L10n.t('对话', 'Conversation'),
      MessageIndexCategory.team => L10n.t('团队', 'Team'),
      MessageIndexCategory.agent => L10n.t('代理', 'Agent'),
    };

String messageDeliveryLabel(MessageDeliveryStatus status) => switch (status) {
  MessageDeliveryStatus.queued => L10n.t('已排队', 'Queued'),
  MessageDeliveryStatus.delivered => L10n.t('已投递', 'Delivered'),
};

/// 索引中的一行（一条消息）。[seq] 是跳回时间线的持久锚点。
class MessageIndexEntry {
  final int seq;
  final MessageIndexCategory category;
  final String sender;
  final String target;
  final String text;
  final DateTime? time;
  final String? messageId;
  final MessageDeliveryStatus? deliveryStatus;

  const MessageIndexEntry({
    required this.seq,
    required this.category,
    required this.sender,
    required this.target,
    required this.text,
    this.time,
    this.messageId,
    this.deliveryStatus,
  });

  MessageIndexEntry copyWith({
    String? sender,
    String? target,
    String? text,
    MessageDeliveryStatus? deliveryStatus,
  }) => MessageIndexEntry(
    seq: seq,
    category: category,
    sender: sender ?? this.sender,
    target: target ?? this.target,
    text: text ?? this.text,
    time: time,
    messageId: messageId,
    deliveryStatus: deliveryStatus ?? this.deliveryStatus,
  );
}

/// 当前已加载窗口的快照；[hasEarlierHistory] 为真时提示「更早消息可能未包含」。
class MessageIndexSnapshot {
  final List<MessageIndexEntry> entries;
  final bool hasEarlierHistory;

  const MessageIndexSnapshot({
    required this.entries,
    required this.hasEarlierHistory,
  });

  static const empty = MessageIndexSnapshot(
    entries: <MessageIndexEntry>[],
    hasEarlierHistory: false,
  );
}

/// 从时间线事件增量派生消息索引。只由当前 ChatScreen 在内存中使用。
class MessageIndexBuilder {
  final Map<int, MessageIndexEntry> _bySeq = <int, MessageIndexEntry>{};
  final Map<String, int> _seqByMessageId = <String, int>{};

  void clear() {
    _bySeq.clear();
    _seqByMessageId.clear();
  }

  List<MessageIndexEntry> get entries {
    final list = _bySeq.values.toList(growable: false)
      ..sort((a, b) => b.seq.compareTo(a.seq));
    return list;
  }

  /// 观察一条时间线事件；非消息型/被排除的注入事件静默忽略。
  void observe(
    ChatEvent event, {
    String? Function(String sessionId)? sessionNameOf,
  }) {
    final seq = event.seq;
    if (seq == null) return;
    final d = event.data;
    // 旧宿主/未知投影：team 事件没有可读 data 时不得伪造发送方/接收方/投递状态。
    if ((event.type == 'team/message/queued' ||
            event.type == 'team/message/delivered') &&
        (d == null || d.isEmpty)) {
      return;
    }
    try {
      switch (event.type) {
        case 'user/message':
          _observeUserMessage(seq, event, d ?? const <String, dynamic>{});
        case 'assistant/message':
          _observeAssistantMessage(seq, event, d ?? const <String, dynamic>{});
        case 'team/message/queued':
          _observeTeamQueued(
            seq,
            event,
            d ?? const <String, dynamic>{},
            sessionNameOf,
          );
        case 'team/message/delivered':
          _observeTeamDelivered(
            seq,
            event,
            d ?? const <String, dynamic>{},
            sessionNameOf,
          );
      }
    } catch (_) {
      // fail-open：单条异常消息不得打断整个索引/时间线。
    }
  }

  void _observeUserMessage(int seq, ChatEvent event, Map<String, dynamic> d) {
    final text = _collapse(d['text'] as String?);
    final sourceKind = d['sourceKind'] as String?;
    // 真人发言（含旧内核无 sourceKind）：你 → 主代理。
    if (sourceKind == null || sourceKind == 'user') {
      _bySeq[seq] = MessageIndexEntry(
        seq: seq,
        category: MessageIndexCategory.conversation,
        sender: L10n.t('你', 'You'),
        target: L10n.t('主代理', 'Main agent'),
        text: text,
        time: _timeOf(event),
      );
      return;
    }
    if (sourceKind == 'team-message') {
      final messageId = _nonEmpty(d['sourceMessageId']);
      final existing = _existingByMessageId(messageId);
      _upsertTeam(
        seq: seq,
        messageId: messageId,
        sender:
            _nonEmpty(d['sourceSenderName']) ??
            _shortId(_nonEmpty(d['sourceSenderId'])),
        target: L10n.t('主代理', 'Main agent'),
        text: text,
        time: _timeOf(event),
        deliveryStatus:
            existing?.deliveryStatus ??
            (messageId == null ? null : MessageDeliveryStatus.delivered),
      );
      return;
    }
    if (sourceKind == 'agent-message') {
      _bySeq[seq] = MessageIndexEntry(
        seq: seq,
        category: MessageIndexCategory.agent,
        sender: _shortId(_nonEmpty(d['sourceSenderId'])),
        target: L10n.t('主代理', 'Main agent'),
        text: text,
        time: _timeOf(event),
      );
      return;
    }
    // 其他注入（plugin/tool/model/agent-instructions…）不属于消息索引。
  }

  void _observeAssistantMessage(
    int seq,
    ChatEvent event,
    Map<String, dynamic> d,
  ) {
    final text = _collapse(d['text'] as String?);
    // 与时间线渲染口径一致：正文为空的中间产物不算可见消息（图片仍由时间线呈现）。
    if (text.isEmpty) return;
    _bySeq[seq] = MessageIndexEntry(
      seq: seq,
      category: MessageIndexCategory.conversation,
      sender: L10n.t('主代理', 'Main agent'),
      target: L10n.t('你', 'You'),
      text: text,
      time: _timeOf(event),
    );
  }

  void _observeTeamQueued(
    int seq,
    ChatEvent event,
    Map<String, dynamic> d,
    String? Function(String sessionId)? sessionNameOf,
  ) {
    final message = d['message'];
    final nested = message is Map ? message.cast<String, dynamic>() : null;
    final messageId = _nonEmpty(nested?['id'] ?? d['messageId']);
    final senderId = _nonEmpty(nested?['senderId'] ?? d['senderId']);
    final senderName = _nonEmpty(nested?['senderName'] ?? d['senderName']);
    final targetId = _nonEmpty(nested?['targetId'] ?? d['targetId']);
    final text = _collapse(
      (nested?['text'] as String?) ?? (d['text'] as String?),
    );
    _upsertTeam(
      seq: seq,
      messageId: messageId,
      sender: senderName ?? _shortId(senderId),
      target: _targetName(targetId, sessionNameOf),
      text: text,
      time: _timeOf(event),
      deliveryStatus: MessageDeliveryStatus.queued,
    );
  }

  void _observeTeamDelivered(
    int seq,
    ChatEvent event,
    Map<String, dynamic> d,
    String? Function(String sessionId)? sessionNameOf,
  ) {
    final messageId = _nonEmpty(d['messageId']);
    if (messageId == null) return;
    final existingSeq = _seqByMessageId[messageId];
    final existing = existingSeq == null ? null : _bySeq[existingSeq];
    if (existing != null) {
      _bySeq[existing.seq] = existing.copyWith(
        deliveryStatus: MessageDeliveryStatus.delivered,
      );
      return;
    }
    // 只见到 delivered（queued 在已加载窗口之外）：保留一行，正文/发送方如实留空。
    _bySeq[seq] = MessageIndexEntry(
      seq: seq,
      category: MessageIndexCategory.team,
      sender: L10n.t('未知', 'Unknown'),
      target: _targetName(_nonEmpty(d['targetId']), sessionNameOf),
      text: '',
      time: _timeOf(event),
      messageId: messageId,
      deliveryStatus: MessageDeliveryStatus.delivered,
    );
    _seqByMessageId[messageId] = seq;
  }

  MessageIndexEntry? _existingByMessageId(String? messageId) {
    if (messageId == null) return null;
    final seq = _seqByMessageId[messageId];
    return seq == null ? null : _bySeq[seq];
  }

  /// queued 与 delivered 按 messageId 合并：同一消息只保留一行，delivered 只更新状态。
  void _upsertTeam({
    required int seq,
    required String? messageId,
    required String sender,
    required String target,
    required String text,
    required DateTime? time,
    required MessageDeliveryStatus? deliveryStatus,
  }) {
    final existing = _existingByMessageId(messageId);
    if (existing != null) {
      _bySeq[existing.seq] = MessageIndexEntry(
        seq: existing.seq,
        category: MessageIndexCategory.team,
        sender: existing.sender == L10n.t('未知', 'Unknown')
            ? sender
            : existing.sender,
        target: existing.target == L10n.t('未知', 'Unknown')
            ? target
            : existing.target,
        text: existing.text.isEmpty ? text : existing.text,
        time: existing.time ?? time,
        messageId: messageId,
        deliveryStatus: deliveryStatus ?? existing.deliveryStatus,
      );
      return;
    }
    _bySeq[seq] = MessageIndexEntry(
      seq: seq,
      category: MessageIndexCategory.team,
      sender: sender,
      target: target,
      text: text,
      time: time,
      messageId: messageId,
      deliveryStatus: deliveryStatus,
    );
    if (messageId != null) _seqByMessageId[messageId] = seq;
  }

  DateTime? _timeOf(ChatEvent event) {
    final ms = event.time;
    if (ms == null) return null;
    return DateTime.fromMillisecondsSinceEpoch(ms);
  }
}

String _targetName(
  String? targetId,
  String? Function(String sessionId)? sessionNameOf,
) {
  if (targetId == null) return L10n.t('未知', 'Unknown');
  final name = sessionNameOf?.call(targetId);
  final trimmed = name?.trim();
  if (trimmed != null && trimmed.isNotEmpty) return trimmed;
  return _shortId(targetId);
}

String _shortId(String? id) {
  final value = id?.trim();
  if (value == null || value.isEmpty) return L10n.t('未知', 'Unknown');
  if (value.length <= 10) return value;
  return '${value.substring(0, 10)}…';
}

String? _nonEmpty(Object? value) {
  if (value is! String) return null;
  final trimmed = value.trim();
  return trimmed.isEmpty ? null : trimmed;
}

String _collapse(String? raw) =>
    (raw ?? '').replaceAll(RegExp(r'\s+'), ' ').trim();

/// 日期分隔标题：今天 / 昨天 / MM-DD；缺时间时明确「时间未知」。
String messageDateLabel(DateTime? time, {DateTime? now}) {
  if (time == null) return L10n.t('时间未知', 'Unknown date');
  final current = (now ?? DateTime.now()).toLocal();
  final local = time.toLocal();
  final today = DateTime(current.year, current.month, current.day);
  final day = DateTime(local.year, local.month, local.day);
  final diff = today.difference(day).inDays;
  if (diff == 0) return L10n.t('今天', 'Today');
  if (diff == 1) return L10n.t('昨天', 'Yesterday');
  return '${_two(local.month)}-${_two(local.day)}';
}

/// 消息行时间 HH:mm；缺时间显示占位（不伪造当前时间）。
String messageClockLabel(DateTime? time) {
  if (time == null) return '--:--';
  final local = time.toLocal();
  return '${_two(local.hour)}:${_two(local.minute)}';
}

/// 分组键（只用于同一天合并分隔标题）。
String messageDateKey(DateTime? time) {
  if (time == null) return 'none';
  final local = time.toLocal();
  return '${local.year}-${local.month}-${local.day}';
}

String _two(int value) => value.toString().padLeft(2, '0');
