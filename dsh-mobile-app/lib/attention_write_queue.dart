// GitLab #152：通知账本单写者队列（按捕获的 profile scope 丢弃旧任务）。
//
// 所有 restore/handle/cancel/save 都串到同一 tail；任务执行前与保存前都校验当前
// scope 未变化，避免切换宿主后旧任务把 A 账本写进 B。
import 'dart:async';

typedef ScopeReader = String Function();

class AttentionWriteQueue {
  Future<void> _tail = Future<void>.value();

  /// 返回该任务的完成 Future；旧 scope 任务会被跳过（不执行 action/save）。
  Future<void> enqueue({
    required String scope,
    required ScopeReader currentScope,
    required Future<void> Function() action,
    required Future<void> Function(String scope) save,
  }) {
    final task = _tail.then((_) async {
      if (currentScope() != scope) return;
      await action();
      if (currentScope() != scope) return;
      await save(scope);
    });
    // 失败不能卡死后续队列；错误由调用方日志处理。
    _tail = task.catchError((Object _) {});
    return task;
  }
}
