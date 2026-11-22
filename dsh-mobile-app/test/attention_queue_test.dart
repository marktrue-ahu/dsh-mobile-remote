// GitLab #152：通知账本写者队列的档案代际隔离。
import 'dart:async';

import 'package:dsh_mobile_app/attention_write_queue.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('旧 A 任务切换 B 后释放：不保存到 B', () async {
    var currentScope = 'A';
    final saves = <String>[];
    var actionEntered = false;
    final gate = Completer<void>();
    final queue = AttentionWriteQueue();

    final oldTask = queue.enqueue(
      scope: 'A',
      currentScope: () => currentScope,
      action: () async {
        actionEntered = true;
        await gate.future;
      },
      save: (scope) async => saves.add(scope),
    );
    await Future<void>.delayed(Duration.zero);
    expect(actionEntered, isTrue);

    currentScope = 'B';
    gate.complete();
    await oldTask;
    expect(saves, isEmpty, reason: 'A 的旧任务不得把 A 账本写入 B');

    await queue.enqueue(
      scope: 'B',
      currentScope: () => currentScope,
      action: () async {},
      save: (scope) async => saves.add(scope),
    );
    expect(saves, ['B']);

    currentScope = 'A';
    await queue.enqueue(
      scope: 'A',
      currentScope: () => currentScope,
      action: () async {},
      save: (scope) async => saves.add(scope),
    );
    expect(saves, ['B', 'A']);
  });
}
