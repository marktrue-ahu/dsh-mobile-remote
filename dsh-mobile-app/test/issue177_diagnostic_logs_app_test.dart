// issue #177：App 侧**反向诊断**日志。
//
// 目的：区分两种完全不同的断点——
//   A. 帧根本没到 App（宿主 `broadcast` 日志的 connections=0 / written=0 可证）
//   B. 帧到了但 `sessionId` 缺失/异常 → 卡片无法归属任何会话（页面按 session 过滤
//      → 用户看不到卡）
//
// 原先只有 `[120-debug] question pending stored` 一条（debug 级），它记录的是
// **已归属**的情况，B 类断点在默认日志级别下完全不可见。本文件钉住新增的 warn。
//
// 同时断言：告警只含标识字段，**不含题干/选项**。
import 'package:dsh_mobile_app/logger.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await AppLog.instance.clear();
    // warn 是默认级别就可见的；这里设 debug 只为同时收齐 debug 行做对照断言。
    await AppLog.instance.setLevel(AppLogLevel.debug);
  });

  tearDown(() async {
    await AppLog.instance.setLevel(AppLogLevel.info);
  });

  String logs() => AppLog.instance.lines.join('\n');

  test('#177 收到 question/requested 但 sessionId 缺失 → warn，且说明无法归属',
      () {
    final store = AppStore();
    store.injectFrame({
      'type': 'mobile/frame',
      'frame': {
        'type': 'question/requested',
        'rpcId': 'ev-q-nosession',
        'questionId': 'q-phone-1',
        // 故意不给 sessionId
        'questions': [
          {
            'id': 'cleanup',
            'question': 'SECRET-QUESTION-TEXT',
            'options': [
              {'label': 'SECRET-OPTION'},
            ],
          },
        ],
      },
    });

    final text = logs();
    expect(
      text,
      contains('[177] question/requested 帧到达但 sessionId 缺失'),
      reason: '必须打出反向诊断 warn',
    );
    expect(text, contains('rpcId=ev-q-nosession'));
    expect(text, contains('questionId=q-phone-1'));
    expect(text, contains('无法归属会话'));

    // 隐私：告警不得带题干/选项
    expect(text, isNot(contains('SECRET-QUESTION-TEXT')));
    expect(text, isNot(contains('SECRET-OPTION')));
  });

  test('#177 sessionId 为空白字符串也算缺失 → warn', () {
    final store = AppStore();
    store.injectFrame({
      'type': 'mobile/frame',
      'frame': {
        'type': 'question/requested',
        'rpcId': 'ev-q-blank',
        'questionId': 'q-phone-2',
        'sessionId': '   ',
        'questions': [
          {'id': 'q1', 'question': 'SECRET-TEXT', 'options': [{'label': 'A'}]},
        ],
      },
    });

    final text = logs();
    expect(text, contains('[177] question/requested 帧到达但 sessionId 缺失'));
    expect(text, contains('rpcId=ev-q-blank'));
  });

  test('#177 sessionId 正常时不打该 warn（避免误报淹没日志）', () {
    final store = AppStore()..sessionId = 'session-A';
    store.injectFrame({
      'type': 'mobile/frame',
      'frame': {
        'type': 'question/requested',
        'rpcId': 'ev-q-ok',
        'questionId': 'q-phone-3',
        'sessionId': 'session-A',
        'questions': [
          {'id': 'q1', 'question': 'text', 'options': [{'label': 'A'}]},
        ],
      },
    });

    final text = logs();
    expect(
      text,
      isNot(contains('[177] question/requested 帧到达但 sessionId 缺失')),
      reason: '正常帧不该触发反向诊断 warn',
    );
    // 原有 debug 日志仍应存在（行为未变）
    expect(text, contains('question pending stored'));
    expect(store.pendingQuestionCount, 1);
  });

  test('#177 反向日志不改变行为：帧仍按原逻辑入 pending', () {
    final store = AppStore();
    store.injectFrame({
      'type': 'mobile/frame',
      'frame': {
        'type': 'question/requested',
        'rpcId': 'ev-q-behavior',
        'questionId': 'q-phone-4',
        'questions': [
          {'id': 'q1', 'question': 'x', 'options': [{'label': 'A'}]},
        ],
      },
    });
    // 缺 sessionId 时沿用原回退（store 当前会话/空串），条目数仍为 1
    expect(store.pendingQuestionCount, 1);
  });
}
