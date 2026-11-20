// issue #144：当前会话消息索引的纯逻辑回归。
//
// 覆盖：消息型事件分类（对话/团队/代理）、排除工具/过程/注入/空回复、
// queued+delivered 按 messageId 合并、时间排序、正文折叠、日期/时间标签、
// 旧宿主缺字段不伪造。
import 'package:dsh_mobile_app/l10n.dart';
import 'package:dsh_mobile_app/message_index.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:flutter_test/flutter_test.dart';

ChatEvent _event(
  int seq,
  String type,
  Map<String, dynamic> data, {
  int? time,
}) => ChatEvent(seq: seq, type: type, data: data, time: time);

void main() {
  setUp(() => L10n.lang = 'zh');
  tearDown(() => L10n.lang = 'zh');

  test('对话：真人 user 与正文非空 assistant；注入/空回复/工具不进索引', () {
    final index = MessageIndexBuilder()
      ..observe(_event(1, 'user/message', {'text': '先按只读范围实现'}))
      ..observe(_event(2, 'assistant/message', {'text': '明白，任务板只保留展开详情'}))
      ..observe(
        _event(3, 'user/message', {
          'text': '系统提示词注入',
          'sourceKind': 'agent-instructions',
        }),
      )
      ..observe(_event(4, 'assistant/message', {'text': '   '}))
      ..observe(_event(5, 'tool/call', {'name': 'shell'}))
      ..observe(_event(6, 'turn/start', {'turn': 1}))
      ..observe(_event(7, 'assistant/message', {'text': '工具阶段空正文'}));

    final entries = index.entries;
    // 第 7 条正文非空（虽然语义上是阶段消息，但按契约只看正文），计入对话。
    expect(entries.map((e) => e.seq), [7, 2, 1]);
    expect(
      entries.every((e) => e.category == MessageIndexCategory.conversation),
      isTrue,
    );
    expect(entries.last.sender, '你');
    expect(entries.last.target, '主代理');
    expect(entries[1].sender, '主代理');
    expect(entries[1].target, '你');
  });

  test('团队入站消息：发送方名称/短 id、messageId 关联投递状态', () {
    final index = MessageIndexBuilder()
      ..observe(
        _event(10, 'user/message', {
          'text': '收到，正在补 320 宽的截图。',
          'sourceKind': 'team-message',
          'sourceSenderName': '前端审计',
          'sourceSenderId': 'session-c',
          'sourceMessageId': 'tm-2',
        }),
      );

    final entry = index.entries.single;
    expect(entry.category, MessageIndexCategory.team);
    expect(entry.sender, '前端审计');
    expect(entry.target, '主代理');
    expect(entry.messageId, 'tm-2');
    expect(entry.deliveryStatus, MessageDeliveryStatus.delivered);
  });

  test('代理入站消息：无发送方名称时回退短 id，不伪造投递状态', () {
    final index = MessageIndexBuilder()
      ..observe(
        _event(11, 'user/message', {
          'text': '收到，已加入回归清单。',
          'sourceKind': 'agent-message',
          'sourceSenderId': 'session-very-long-id',
        }),
      );

    final entry = index.entries.single;
    expect(entry.category, MessageIndexCategory.agent);
    expect(entry.sender, 'session-ve…');
    expect(entry.deliveryStatus, isNull);
  });

  test('queued + delivered 合并一行：seq 保持 queued，状态变已投递', () {
    final index = MessageIndexBuilder()
      ..observe(
        _event(20, 'team/message/queued', {
          'messageId': 'tm-1',
          'senderId': 'session-a',
          'senderName': '发布协调员',
          'targetId': 'session-b',
          'text': '插件清单的第二列改成来源渠道',
        }),
      )
      ..observe(
        _event(21, 'team/message/delivered', {
          'messageId': 'tm-1',
          'targetId': 'session-b',
        }),
      );

    final entry = index.entries.single;
    expect(entry.seq, 20);
    expect(entry.category, MessageIndexCategory.team);
    expect(entry.sender, '发布协调员');
    expect(entry.target, 'session-b');
    expect(entry.deliveryStatus, MessageDeliveryStatus.delivered);
    expect(index.entries.length, 1, reason: 'delivered 不得再生成第二行');
  });

  test('只有 queued：已排队；只有 delivered：已投递且正文如实留空', () {
    final queuedOnly = MessageIndexBuilder()
      ..observe(
        _event(30, 'team/message/queued', {
          'messageId': 'tm-q',
          'senderName': '发布协调员',
          'targetId': 'session-b',
          'text': '下载断点恢复补一条',
        }),
      );
    expect(
      queuedOnly.entries.single.deliveryStatus,
      MessageDeliveryStatus.queued,
    );

    final deliveredOnly = MessageIndexBuilder()
      ..observe(
        _event(31, 'team/message/delivered', {
          'messageId': 'tm-d',
          'targetId': 'session-b',
        }),
      );
    final entry = deliveredOnly.entries.single;
    expect(entry.deliveryStatus, MessageDeliveryStatus.delivered);
    expect(entry.text, '');
    expect(entry.sender, '未知');
  });

  test('会话名解析：团队消息接收方优先显示会话标题，否则短 id', () {
    final index = MessageIndexBuilder()
      ..observe(
        _event(40, 'team/message/queued', {
          'messageId': 'tm-3',
          'senderName': '发布协调员',
          'targetId': 'session-b',
          'text': '请补截图',
        }),
        sessionNameOf: (id) => id == 'session-b' ? '前端审计' : null,
      );
    expect(index.entries.single.target, '前端审计');
  });

  test('正文折叠空白并保持新→旧顺序', () {
    final index = MessageIndexBuilder()
      ..observe(_event(50, 'user/message', {'text': '第一行\n\n第二行\t结尾'}))
      ..observe(_event(51, 'assistant/message', {'text': '回复 1'}))
      ..observe(_event(52, 'user/message', {'text': '最新'}));

    expect(index.entries.map((e) => e.seq), [52, 51, 50]);
    expect(index.entries.last.text, '第一行 第二行 结尾');
  });

  test('时间：排序不依赖 time；日期标签今天/昨天/MM-DD/未知，时钟 HH:mm', () {
    final now = DateTime(2026, 11, 20, 18, 30);
    final today = DateTime(2026, 11, 20, 14, 5);
    final yesterday = DateTime(2026, 11, 19, 9, 7);
    final older = DateTime(2026, 11, 3, 23, 59);

    expect(messageDateLabel(today, now: now), '今天');
    expect(messageDateLabel(yesterday, now: now), '昨天');
    expect(messageDateLabel(older, now: now), '11-03');
    expect(messageDateLabel(null, now: now), '时间未知');
    expect(messageClockLabel(today), '14:05');
    expect(messageClockLabel(null), '--:--');
    expect(messageDateKey(today), '2026-11-20');
  });

  test('旧宿主缺投影：team 事件没有 data 时跳过，不伪造发送方/状态', () {
    final index = MessageIndexBuilder()
      ..observe(_event(60, 'team/message/queued', const {}))
      ..observe(_event(61, 'team/message/delivered', const {}));
    expect(index.entries, isEmpty);
  });

  test('clear 清空当前会话索引', () {
    final index = MessageIndexBuilder()
      ..observe(_event(70, 'user/message', {'text': '你好'}));
    expect(index.entries, hasLength(1));
    index.clear();
    expect(index.entries, isEmpty);
  });
}
