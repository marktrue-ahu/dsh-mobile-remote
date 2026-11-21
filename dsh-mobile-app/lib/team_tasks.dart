// GitLab #143：只读任务板数据模型（与 DSH `agentTeam` 投影的 TeamTaskView 对齐）。
//
// 字段只保留移动端展示所需：id/subject/status/ownerId/ownerName/blockedBy/ready。
// 不透出 description、writeScopes、revision；已删除任务由服务端/客户端双重过滤。

enum TeamTaskStatus { pending, inProgress, completed }

TeamTaskStatus? teamTaskStatusOf(String raw) => switch (raw) {
  'pending' => TeamTaskStatus.pending,
  'in_progress' => TeamTaskStatus.inProgress,
  'completed' => TeamTaskStatus.completed,
  _ => null,
};

class TeamTask {
  const TeamTask({
    required this.id,
    required this.subject,
    required this.status,
    required this.blockedBy,
    required this.ready,
    this.ownerId,
    this.ownerName,
  });

  final String id;
  final String subject;
  final TeamTaskStatus status;
  final List<String> blockedBy;
  final bool ready;
  final String? ownerId;
  final String? ownerName;

  /// 派生状态：pending 且存在未完成依赖（服务端 ready=false 时同样成立）。
  bool get blocked => status == TeamTaskStatus.pending && !ready;

  String get ownerLabel =>
      (ownerName?.isNotEmpty ?? false)
      ? ownerName!
      : ((ownerId?.isNotEmpty ?? false) ? ownerId! : '');

  static TeamTask? fromJson(Object? value) {
    if (value is! Map) return null;
    final id = value['id'];
    final subject = value['subject'];
    final status = teamTaskStatusOf(value['status']?.toString() ?? '');
    if (id is! String ||
        id.isEmpty ||
        subject is! String ||
        subject.trim().isEmpty ||
        status == null) {
      return null;
    }
    final blockedBy = <String>[];
    final rawBlocked = value['blockedBy'];
    if (rawBlocked is List) {
      for (final entry in rawBlocked) {
        if (entry is String && entry.isNotEmpty && !blockedBy.contains(entry)) {
          blockedBy.add(entry);
        }
      }
    }
    final ownerId = value['ownerId'];
    final ownerName = value['ownerName'];
    return TeamTask(
      id: id,
      subject: subject.trim(),
      status: status,
      blockedBy: blockedBy,
      ready: value['ready'] == true,
      ownerId: ownerId is String && ownerId.isNotEmpty ? ownerId : null,
      ownerName: ownerName is String && ownerName.isNotEmpty ? ownerName : null,
    );
  }
}

/// 服务端只读任务板响应：
/// `{ok, supported, enabled, tasks, failure?, unavailable?}`。
class TeamTaskBoard {
  const TeamTaskBoard({
    required this.supported,
    required this.enabled,
    required this.tasks,
    this.failure,
    this.unavailable = false,
  });

  final bool supported;
  final bool enabled;
  final List<TeamTask> tasks;
  final String? failure;

  /// 会话存在但没有活 agent（服务 API 不可调用）：显式降级，不冒充“无任务”。
  final bool unavailable;

  static const unsupported = TeamTaskBoard(
    supported: false,
    enabled: false,
    tasks: [],
  );

  factory TeamTaskBoard.fromJson(Map<String, dynamic> json) {
    final supported = json['supported'] != false;
    if (!supported) return unsupported;
    final tasks = <TeamTask>[];
    final rawTasks = json['tasks'];
    if (rawTasks is List) {
      for (final raw in rawTasks) {
        final task = TeamTask.fromJson(raw);
        // 已删除任务即使服务端误发也不显示（状态枚举本身不含 deleted）。
        if (task != null) tasks.add(task);
      }
    }
    final failure = json['failure'];
    return TeamTaskBoard(
      supported: true,
      enabled: json['enabled'] == true,
      tasks: tasks,
      failure: failure is String && failure.isNotEmpty ? failure : null,
      unavailable: json['unavailable'] == true,
    );
  }
}
