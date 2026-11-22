// issue #151：提问卡 debug 取证日志——字段齐全、无题干/选项等敏感内容。
import 'package:dsh_mobile_app/logger.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await AppLog.instance.clear();
    await AppLog.instance.setLevel(AppLogLevel.debug);
  });

  tearDown(() async {
    await AppLog.instance.setLevel(AppLogLevel.info);
  });

  test(
    'question/requested 记录 rpcId/questionId/sessionId/pendingAfter，且不含题干/选项',
    () {
      final store = AppStore()..sessionId = 'session-A';
      store.injectFrame({
        'type': 'mobile/frame',
        'frame': {
          'type': 'question/requested',
          'rpcId': 'ev-q',
          'questionId': 'q-phone-1',
          'sessionId': 'session-A',
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

      expect(store.pendingQuestionCount, 1);
      expect(store.questionForSession('session-A')?.questionId, 'q-phone-1');
      final logs = AppLog.instance.lines.join('\n');
      expect(logs, contains('question pending stored'));
      expect(logs, contains('rpcId=ev-q'));
      expect(logs, contains('questionId=q-phone-1'));
      expect(logs, contains('sessionId=session-A'));
      expect(logs, contains('pendingAfter=1'));
      expect(logs, isNot(contains('SECRET-QUESTION-TEXT')));
      expect(logs, isNot(contains('SECRET-OPTION')));
    },
  );

  test('question/resolved 记录 rpcId/questionId/pendingAfter，且清除 pending', () {
    final store = AppStore()..sessionId = 'session-A';
    store.injectFrame({
      'type': 'mobile/frame',
      'frame': {
        'type': 'question/requested',
        'rpcId': 'ev-q',
        'questionId': 'q-phone-1',
        'sessionId': 'session-A',
        'questions': [],
      },
    });
    store.injectFrame({
      'type': 'mobile/frame',
      'frame': {
        'type': 'question/resolved',
        'questionRpcId': 'ev-q',
        'questionId': 'q-phone-1',
        'sessionId': 'session-A',
      },
    });
    expect(store.pendingQuestionCount, 0);
    final logs = AppLog.instance.lines.join('\n');
    expect(logs, contains('question/resolved rpcId=ev-q'));
    expect(logs, contains('questionId=q-phone-1'));
    expect(logs, contains('hadPending=true'));
    expect(logs, contains('pendingAfter=0'));
  });

  test('hello 的 pending snapshot 清理记录数量，不记录 question 内容', () {
    final store = AppStore()..sessionId = 'session-A';
    store.injectFrame({
      'type': 'mobile/frame',
      'frame': {
        'type': 'question/requested',
        'rpcId': 'ev-q',
        'questionId': 'q-phone-1',
        'sessionId': 'session-A',
        'questions': [
          {'id': 'q1', 'question': 'SECRET-QUESTION-TEXT'},
        ],
      },
    });
    expect(store.pendingQuestionCount, 1);
    store.injectFrame({
      'type': 'hello',
      'hostId': 'host-1',
      'capabilities': <String, dynamic>{},
    });
    expect(store.pendingQuestionCount, 0);
    final logs = AppLog.instance.lines.join('\n');
    expect(logs, contains('pending snapshot clearing questions=1'));
    expect(logs, isNot(contains('SECRET-QUESTION-TEXT')));
  });

  test('hello 记录 SSE 连接代/待答数，不记录 question 内容', () {
    final store = AppStore()..sessionId = 'session-A';
    store.injectFrame({
      'type': 'hello',
      'hostId': 'host-1',
      'capabilities': {'eventTimeline': true, 'turnOutline': true},
    });
    final logs = AppLog.instance.lines.join('\n');
    expect(logs, contains('SSE: hello'));
    expect(logs, contains('pendingQuestions=0'));
    expect(logs, isNot(contains('SECRET')));
  });
}
