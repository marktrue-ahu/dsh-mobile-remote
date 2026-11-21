// issue #142：代理面板「团队」数据模型（插件 `/api/team`）。
//
// 契约（docs/03-api.md §6.16）：
//   supported/root/agentLive/enabled/pending/locked/modelSelected/canToggle/
//   unavailableReason/lead/members/membersAvailable/tasks/tasksAvailable。
// 旧宿主无团队投影时 supported=false；不伪造成员/任务。

class TeamMember {
  final String id;
  final String? name;
  final String? title;
  final String kind; // child | diagnostic
  final String
  status; // running | inactive | unsupported | corrupt | unavailable
  final int? depth;
  final String? parentSessionId;

  const TeamMember({
    required this.id,
    required this.name,
    required this.title,
    required this.kind,
    required this.status,
    this.depth,
    this.parentSessionId,
  });

  bool get isDiagnostic => kind == 'diagnostic';
  bool get isRunning => status == 'running';

  factory TeamMember.fromJson(Map<String, dynamic> j) => TeamMember(
    id: (j['id'] ?? '').toString(),
    name: j['name'] as String?,
    title: j['title'] as String?,
    kind: (j['kind'] ?? 'child').toString(),
    status: (j['status'] ?? 'inactive').toString(),
    depth: (j['depth'] as num?)?.toInt(),
    parentSessionId: j['parentSessionId'] as String?,
  );
}

class TeamTaskSummary {
  final int total;
  final int completed;
  final int inProgress;
  final int pending;

  const TeamTaskSummary({
    this.total = 0,
    this.completed = 0,
    this.inProgress = 0,
    this.pending = 0,
  });

  factory TeamTaskSummary.fromJson(Map<String, dynamic>? j) => TeamTaskSummary(
    total: (j?['total'] as num?)?.toInt() ?? 0,
    completed: (j?['completed'] as num?)?.toInt() ?? 0,
    inProgress: (j?['inProgress'] as num?)?.toInt() ?? 0,
    pending: (j?['pending'] as num?)?.toInt() ?? 0,
  );
}

class TeamStatus {
  final String sessionId;
  final bool supported;
  final bool root;
  final bool agentLive;
  final bool enabled;
  final bool modeKnown;
  final bool modelSelected;
  final bool pending;
  final bool locked;
  final bool lockedKnown;
  final bool canToggle;
  final String? unavailableReason;
  final String leadTitle;
  final String leadStatus;
  final List<TeamMember> members;
  final bool membersAvailable;
  final bool membersDegraded;
  final TeamTaskSummary tasks;
  final bool tasksAvailable;

  const TeamStatus({
    required this.sessionId,
    required this.supported,
    required this.root,
    required this.agentLive,
    required this.enabled,
    required this.modeKnown,
    required this.modelSelected,
    required this.pending,
    required this.locked,
    required this.lockedKnown,
    required this.canToggle,
    required this.unavailableReason,
    required this.leadTitle,
    required this.leadStatus,
    required this.members,
    required this.membersAvailable,
    required this.membersDegraded,
    required this.tasks,
    required this.tasksAvailable,
  });

  /// 旧插件没有 `/api/team` 路由（404 非 session-not-found）时的显式降级形态。
  factory TeamStatus.unsupported(String sessionId) => TeamStatus(
    sessionId: sessionId,
    supported: false,
    root: true,
    agentLive: false,
    enabled: false,
    modeKnown: false,
    modelSelected: false,
    pending: false,
    locked: false,
    lockedKnown: false,
    canToggle: false,
    unavailableReason: 'team-unavailable',
    leadTitle: '',
    leadStatus: 'inactive',
    members: const [],
    membersAvailable: false,
    membersDegraded: true,
    tasks: const TeamTaskSummary(),
    tasksAvailable: false,
  );

  factory TeamStatus.fromJson(Map<String, dynamic> j) {
    final lead = j['lead'] as Map<String, dynamic>? ?? const {};
    final rawMembers = j['members'];
    return TeamStatus(
      sessionId: (j['sessionId'] ?? '').toString(),
      supported: j['supported'] == true,
      root: j['root'] != false,
      agentLive: j['agentLive'] == true,
      enabled: j['enabled'] == true,
      modeKnown: j['modeKnown'] == true,
      modelSelected: j['modelSelected'] != false,
      pending: j['pending'] == true,
      locked: j['locked'] == true,
      // 旧宿主没有该字段：不擅自断言“锁已知”；新宿主显式下发。
      lockedKnown: j['lockedKnown'] == true,
      canToggle: j['canToggle'] == true,
      unavailableReason: j['unavailableReason'] as String?,
      leadTitle: (lead['title'] ?? '').toString(),
      leadStatus: (lead['status'] ?? 'inactive').toString(),
      members: rawMembers is List
          ? rawMembers
                .whereType<Map>()
                .map(
                  (row) => TeamMember.fromJson(Map<String, dynamic>.from(row)),
                )
                .toList()
          : const [],
      membersAvailable: j['membersAvailable'] != false,
      membersDegraded: j['membersDegraded'] == true,
      tasks: TeamTaskSummary.fromJson(j['tasks'] as Map<String, dynamic>?),
      tasksAvailable: j['tasksAvailable'] != false,
    );
  }

  /// 仅正常成员计入「N 名成员」（诊断行不是成员）。
  List<TeamMember> get normalMembers =>
      members.where((member) => !member.isDiagnostic).toList();
}
