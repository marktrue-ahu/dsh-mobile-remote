import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/git_models.dart';
import 'package:dsh_mobile_app/git_write_models.dart';

class FakeGitApi implements GitApi, GitWriteApi {
  final Map<String, GitOperation> operationMap = {};
  List<GitFileSelection> lastSelections = const [];
  GitPreflight? lastSubmittedPreflight;
  String? lastHandoffTarget;
  bool unsafeSwitch = false;
  bool noopSwitch = false;
  int branchSubmitCount = 0;
  int sequence = 0;

  GitOperation _operation(String kind, {String status = 'queued'}) {
    final id = 'operation-${++sequence}';
    final operation = GitOperation(
      operationId: id,
      requestId: 'request-$sequence',
      repositoryId: 'repo-1',
      kind: kind,
      status: status,
      revision: 1,
      canCancel: status == 'queued' || status == 'running',
    );
    operationMap[id] = operation;
    return operation;
  }

  GitAcceptedOperation _accepted(String kind) =>
      GitAcceptedOperation(accepted: true, operation: _operation(kind));

  @override
  Future<GitCapability> gitCapabilities() async => const GitCapability(
    available: true,
    read: true,
    writes: true,
    features: {
      'stage': true,
      'commit': true,
      'branchSwitch': true,
      'remoteSync': true,
    },
  );

  @override
  Future<GitContext> gitContext({String? sessionId, String? cwd}) async =>
      const GitContext(
        repositoryId: 'repo-1',
        root: '/redacted',
        name: 'fixture',
        capabilities: GitCapability(available: true, read: true, writes: true),
      );

  @override
  Future<GitStatus> gitStatus(String repositoryId) async => const GitStatus(
    branch: 'main',
    counts: {'total': 2, 'staged': 1, 'unstaged': 1},
  );

  @override
  Future<List<GitBranch>> gitBranches(String repositoryId) async => const [
    GitBranch(name: 'refs/heads/main', displayName: 'main', oid: 'aabbccdd'),
    GitBranch(
      name: 'refs/heads/feature',
      displayName: 'feature',
      oid: 'bbccddaa',
    ),
    GitBranch(
      name: 'refs/remotes/origin/topic',
      displayName: 'origin/topic',
      oid: 'ccddeeaa',
      remote: true,
    ),
  ];

  @override
  Future<GitChangeSet> createGitChangeSet(
    String repositoryId,
    String kind,
  ) async => GitChangeSet(
    changeSetId: '$kind-set',
    repositoryId: repositoryId,
    kind: kind,
    stateVersion: '$kind-version',
    preconditionToken: '$kind-token',
    files: [
      GitChangeFile(
        fileId: '$kind-file',
        path: 'lib/example.dart',
        index: kind == 'staged' ? 'M' : ' ',
        worktree: kind == 'working' ? 'M' : ' ',
        hunks: const [
          GitHunkSelection(
            hunkId: 'hunk-1',
            header: '@@ -1 +1 @@',
            additions: 1,
            deletions: 1,
          ),
        ],
      ),
    ],
  );

  @override
  Future<GitAcceptedOperation> submitGitSelection({
    required String repositoryId,
    required GitChangeSet changeSet,
    required List<GitFileSelection> selections,
    required String requestId,
    bool unstage = false,
  }) async {
    lastSelections = selections;
    return _accepted(unstage ? 'git.unstage' : 'git.stage');
  }

  @override
  Future<GitPreflight> gitCommitPreflight(
    String repositoryId,
    String message,
  ) async => GitPreflight.fromJson({
    'operationKind': 'git.commit',
    'repositoryId': repositoryId,
    'message': message,
    'headOid': '111111111111',
    'stagedTreeOid': '222222222222',
    'branch': 'main',
    'identity': {'name': 'Alice', 'email': 'alice@example.com'},
    'mobileCommitPolicy': 'no-hooks',
    'preconditionToken': 'commit-token',
  });

  @override
  Future<GitAcceptedOperation> submitGitCommit({
    required String repositoryId,
    required GitPreflight preflight,
    required String message,
    required String requestId,
  }) async {
    lastSubmittedPreflight = preflight;
    return _accepted('git.commit');
  }

  @override
  Future<GitPreflight> gitBranchPreflight(
    String repositoryId, {
    required String action,
    String? name,
    String? oldName,
    String? startOid,
    String? remoteRef,
    String? targetBranch,
    String? targetRef,
    String? localName,
  }) async => GitPreflight.fromJson({
    'operationKind': 'git.branch-$action',
    'repositoryId': repositoryId,
    'safe': action == 'switch' ? !unsafeSwitch : true,
    if (action == 'switch' && noopSwitch) 'noop': true,
    if (unsafeSwitch) 'allowedActions': ['commit', 'computer', 'cancel'],
    'targetBranch': targetBranch ?? localName,
    'name': name,
    'stateVersion': 'branch-version',
    if (!unsafeSwitch)
      'params': {
        if (name != null) 'name': name,
        if (oldName != null) 'oldName': oldName,
        if (startOid != null) 'startOid': startOid,
        if (targetBranch != null) 'targetBranch': targetBranch,
        if (targetRef != null) 'targetRef': targetRef,
        if (localName != null) 'localName': localName,
      },
    if (!unsafeSwitch) 'preconditionToken': 'branch-token',
  });

  @override
  Future<GitAcceptedOperation> submitGitBranch({
    required String repositoryId,
    required GitPreflight preflight,
    required String requestId,
  }) async {
    branchSubmitCount += 1;
    lastSubmittedPreflight = preflight;
    return _accepted('git.branch-${preflight.action}');
  }

  @override
  Future<GitRemotes> gitRemotes(String repositoryId) async => GitRemotes(
    repositoryId: repositoryId,
    stateVersion: 'remote-version',
    remotes: const [
      GitRemoteTarget(
        name: 'origin',
        fetchUrl: '[redacted]',
        pushUrl: '[redacted]',
        branches: [GitRemoteBranch(branch: 'main', oid: '1234')],
      ),
    ],
    localBranches: const [
      GitLocalRemoteBranch(name: 'main', oid: '1234', upstream: 'origin/main'),
    ],
  );

  @override
  Future<GitPreflight> gitRemotePreflight(
    String repositoryId, {
    required String kind,
    String? remote,
    String? branch,
    String? localBranch,
    String? strategy,
    bool? setUpstream,
  }) async => GitPreflight.fromJson({
    'operationKind': 'git.$kind',
    'repositoryId': repositoryId,
    'params': {
      'remote': remote,
      'branch': branch,
      if (localBranch != null) 'localBranch': localBranch,
      if (strategy != null) 'strategy': strategy,
    },
    'preconditionToken': 'remote-token',
  });

  @override
  Future<GitAcceptedOperation> submitGitRemote({
    required String repositoryId,
    required GitPreflight preflight,
    required String requestId,
  }) async {
    lastSubmittedPreflight = preflight;
    return _accepted('git.${preflight.action}');
  }

  @override
  Future<GitPreflight> gitAbortPreflight(String repositoryId) async =>
      GitPreflight.fromJson({
        'operationKind': 'git.abort',
        'repositoryId': repositoryId,
        'summary': 'Abort merge',
        'params': {'kind': 'merge'},
        'preconditionToken': 'abort-token',
      });

  @override
  Future<GitConfirmation> issueGitConfirmation({
    required String repositoryId,
    required GitPreflight preflight,
    required String confirmationRequestId,
  }) async => const GitConfirmation(
    challengeId: 'challenge-1',
    expiresAt: 9999999999999,
    summary: 'Abort merge',
  );

  @override
  Future<GitAcceptedOperation> submitGitAbort({
    required String repositoryId,
    required GitPreflight preflight,
    required GitConfirmation confirmation,
    required String requestId,
  }) async => _accepted('git.abort');

  @override
  Future<GitOperation> gitOperation(String operationId) async =>
      operationMap[operationId] ??
      GitOperation(
        operationId: operationId,
        requestId: 'recovered-request',
        repositoryId: 'repo-1',
        kind: 'git.sync',
        status: 'running',
        revision: 2,
        canCancel: true,
      );

  @override
  Future<GitOperationPage> gitOperations({
    String? repositoryId,
    String? status,
    String? cursor,
    int limit = 100,
  }) async => GitOperationPage(operations: operationMap.values.toList());

  @override
  Future<GitAcceptedOperation> cancelGitOperation(
    GitOperation operation, {
    required String requestId,
  }) async {
    final cancelled = GitOperation(
      operationId: operation.operationId,
      requestId: operation.requestId,
      repositoryId: operation.repositoryId,
      kind: operation.kind,
      status: 'cancelled',
      revision: operation.revision + 1,
    );
    operationMap[operation.operationId] = cancelled;
    return GitAcceptedOperation(accepted: true, operation: cancelled);
  }

  @override
  Future<GitOperation> handoffGitOperation(
    GitOperation operation, {
    required String target,
    required String requestId,
  }) async {
    lastHandoffTarget = target;
    return GitOperation(
      operationId: operation.operationId,
      requestId: operation.requestId,
      repositoryId: operation.repositoryId,
      kind: operation.kind,
      status: operation.status,
      revision: operation.revision + 1,
      recoveryBlocked: operation.recoveryBlocked,
    );
  }

  @override
  Future<GitOperation> acknowledgeGitRecovery(
    GitOperation operation, {
    required String stateVersion,
    required String requestId,
  }) async => GitOperation(
    operationId: operation.operationId,
    requestId: operation.requestId,
    repositoryId: operation.repositoryId,
    kind: operation.kind,
    status: operation.status,
    revision: operation.revision + 1,
  );
}
