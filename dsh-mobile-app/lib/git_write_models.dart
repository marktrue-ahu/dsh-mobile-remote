import 'dart:collection';

Map<String, dynamic> _stringMap(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};

List<String> _strings(Object? value) =>
    value is List ? value.map((item) => item.toString()).toList() : const [];

int? _intValue(Object? value) =>
    value is num ? value.toInt() : int.tryParse(value?.toString() ?? '');

class GitHunkSelection {
  final String hunkId;
  final String header;
  final int additions;
  final int deletions;

  const GitHunkSelection({
    required this.hunkId,
    this.header = '',
    this.additions = 0,
    this.deletions = 0,
  });

  factory GitHunkSelection.fromJson(Map<String, dynamic> json) =>
      GitHunkSelection(
        hunkId: json['hunkId']?.toString() ?? '',
        header: json['header']?.toString() ?? '',
        additions: _intValue(json['additions']) ?? 0,
        deletions: _intValue(json['deletions']) ?? 0,
      );
}

class GitChangeFile {
  final String fileId;
  final String path;
  final String? oldPath;
  final String index;
  final String worktree;
  final bool rename;
  final bool binary;
  final List<GitHunkSelection> hunks;

  const GitChangeFile({
    required this.fileId,
    required this.path,
    this.oldPath,
    this.index = ' ',
    this.worktree = ' ',
    this.rename = false,
    this.binary = false,
    this.hunks = const [],
  });

  factory GitChangeFile.fromJson(Map<String, dynamic> json) => GitChangeFile(
    fileId: json['fileId']?.toString() ?? '',
    path: json['path']?.toString() ?? '',
    oldPath: json['oldPath']?.toString(),
    index: json['index']?.toString() ?? ' ',
    worktree: json['worktree']?.toString() ?? ' ',
    rename: json['rename'] == true,
    binary: json['binary'] == true,
    hunks: (json['hunks'] as List? ?? const [])
        .whereType<Map>()
        .map(
          (item) => GitHunkSelection.fromJson(Map<String, dynamic>.from(item)),
        )
        .toList(growable: false),
  );
}

class GitChangeSet {
  final String changeSetId;
  final String repositoryId;
  final String kind;
  final String stateVersion;
  final String? headOid;
  final String? indexTreeOid;
  final String preconditionToken;
  final int? expiresAt;
  final List<GitChangeFile> files;

  const GitChangeSet({
    required this.changeSetId,
    required this.repositoryId,
    required this.kind,
    required this.stateVersion,
    required this.preconditionToken,
    this.headOid,
    this.indexTreeOid,
    this.expiresAt,
    this.files = const [],
  });

  factory GitChangeSet.fromJson(Map<String, dynamic> json) => GitChangeSet(
    changeSetId: json['changeSetId']?.toString() ?? '',
    repositoryId: json['repositoryId']?.toString() ?? '',
    kind: json['kind']?.toString() ?? '',
    stateVersion: json['stateVersion']?.toString() ?? '',
    headOid: json['headOid']?.toString(),
    indexTreeOid: json['indexTreeOid']?.toString(),
    preconditionToken: json['preconditionToken']?.toString() ?? '',
    expiresAt: _intValue(json['expiresAt']),
    files: (json['files'] as List? ?? const [])
        .whereType<Map>()
        .map((item) => GitChangeFile.fromJson(Map<String, dynamic>.from(item)))
        .toList(growable: false),
  );
}

class GitFileSelection {
  final String fileId;
  final List<String> hunkIds;

  const GitFileSelection({required this.fileId, this.hunkIds = const []});

  Map<String, dynamic> toJson() => {
    'fileId': fileId,
    if (hunkIds.isNotEmpty) 'hunkIds': hunkIds,
  };
}

class GitPreflight {
  final String operationKind;
  final String repositoryId;
  final Map<String, dynamic> params;
  final String? stateVersion;
  final String? preconditionToken;
  final bool safe;
  final bool noop;
  final bool requiresConfirmation;
  final String? summary;
  final Map<String, dynamic> impact;
  final Map<String, dynamic> expected;
  final Map<String, dynamic> target;
  final Map<String, dynamic> identity;
  final List<String> allowedActions;
  final Map<String, dynamic> data;

  const GitPreflight({
    required this.operationKind,
    required this.repositoryId,
    required this.params,
    this.stateVersion,
    this.preconditionToken,
    this.safe = true,
    this.noop = false,
    this.requiresConfirmation = false,
    this.summary,
    this.impact = const {},
    this.expected = const {},
    this.target = const {},
    this.identity = const {},
    this.allowedActions = const [],
    this.data = const {},
  });

  factory GitPreflight.fromJson(Map<String, dynamic> json) => GitPreflight(
    operationKind:
        json['operationKind']?.toString() ?? json['action']?.toString() ?? '',
    repositoryId: json['repositoryId']?.toString() ?? '',
    params: UnmodifiableMapView(_stringMap(json['params'])),
    stateVersion: json['stateVersion']?.toString(),
    preconditionToken: json['preconditionToken']?.toString(),
    safe: json['safe'] != false,
    noop: json['noop'] == true,
    requiresConfirmation: json['requiresConfirmation'] == true,
    summary: json['summary']?.toString(),
    impact: UnmodifiableMapView(_stringMap(json['impact'])),
    expected: UnmodifiableMapView(_stringMap(json['expected'])),
    target: UnmodifiableMapView(_stringMap(json['target'])),
    identity: UnmodifiableMapView(_stringMap(json['identity'])),
    allowedActions: _strings(json['allowedActions']),
    data: UnmodifiableMapView(Map<String, dynamic>.from(json)),
  );

  String get action {
    if (operationKind.startsWith('git.branch-')) {
      return operationKind.substring('git.branch-'.length);
    }
    if (operationKind.startsWith('git.')) return operationKind.substring(4);
    return operationKind;
  }

  /// Only safe, token-bearing preflights may be submitted. `noop` and unsafe
  /// switch preflights are read-only decisions with no executable token.
  bool get canSubmit =>
      !noop && safe && (preconditionToken?.isNotEmpty ?? false);
}

class GitRemoteBranch {
  final String branch;
  final String oid;

  const GitRemoteBranch({required this.branch, required this.oid});

  factory GitRemoteBranch.fromJson(Map<String, dynamic> json) =>
      GitRemoteBranch(
        branch: json['branch']?.toString() ?? '',
        oid: json['oid']?.toString() ?? '',
      );
}

class GitRemoteTarget {
  final String name;
  final String? fetchUrl;
  final String? pushUrl;
  final List<GitRemoteBranch> branches;

  const GitRemoteTarget({
    required this.name,
    this.fetchUrl,
    this.pushUrl,
    this.branches = const [],
  });

  factory GitRemoteTarget.fromJson(Map<String, dynamic> json) =>
      GitRemoteTarget(
        name: json['name']?.toString() ?? '',
        fetchUrl: json['fetchUrl']?.toString(),
        pushUrl: json['pushUrl']?.toString(),
        branches: (json['branches'] as List? ?? const [])
            .whereType<Map>()
            .map(
              (item) =>
                  GitRemoteBranch.fromJson(Map<String, dynamic>.from(item)),
            )
            .toList(growable: false),
      );
}

class GitLocalRemoteBranch {
  final String name;
  final String oid;
  final String? upstream;

  const GitLocalRemoteBranch({
    required this.name,
    required this.oid,
    this.upstream,
  });

  factory GitLocalRemoteBranch.fromJson(Map<String, dynamic> json) =>
      GitLocalRemoteBranch(
        name: json['name']?.toString() ?? '',
        oid: json['oid']?.toString() ?? '',
        upstream: json['upstream']?.toString(),
      );
}

class GitRemotes {
  final String repositoryId;
  final String stateVersion;
  final List<GitRemoteTarget> remotes;
  final List<GitLocalRemoteBranch> localBranches;

  const GitRemotes({
    required this.repositoryId,
    required this.stateVersion,
    this.remotes = const [],
    this.localBranches = const [],
  });

  factory GitRemotes.fromJson(Map<String, dynamic> json) => GitRemotes(
    repositoryId: json['repositoryId']?.toString() ?? '',
    stateVersion: json['stateVersion']?.toString() ?? '',
    remotes: (json['remotes'] as List? ?? const [])
        .whereType<Map>()
        .map(
          (item) => GitRemoteTarget.fromJson(Map<String, dynamic>.from(item)),
        )
        .toList(growable: false),
    localBranches: (json['localBranches'] as List? ?? const [])
        .whereType<Map>()
        .map(
          (item) =>
              GitLocalRemoteBranch.fromJson(Map<String, dynamic>.from(item)),
        )
        .toList(growable: false),
  );
}

class GitOperationStage {
  final String id;
  final String kind;
  final String status;
  final int phaseIndex;
  final String? skipReason;
  final String? errorCode;
  final List<String> sideEffects;
  final Map<String, dynamic> preFacts;
  final Map<String, dynamic> postFacts;

  const GitOperationStage({
    required this.id,
    required this.kind,
    required this.status,
    this.phaseIndex = 0,
    this.skipReason,
    this.errorCode,
    this.sideEffects = const [],
    this.preFacts = const {},
    this.postFacts = const {},
  });

  factory GitOperationStage.fromJson(Map<String, dynamic> json) =>
      GitOperationStage(
        id: json['id']?.toString() ?? '',
        kind: json['kind']?.toString() ?? '',
        status: json['status']?.toString() ?? 'pending',
        phaseIndex: _intValue(json['phaseIndex']) ?? 0,
        skipReason: json['skipReason']?.toString(),
        errorCode: json['errorCode']?.toString(),
        sideEffects: _strings(json['sideEffects']),
        preFacts: UnmodifiableMapView(_stringMap(json['preFacts'])),
        postFacts: UnmodifiableMapView(_stringMap(json['postFacts'])),
      );
}

class GitOperation {
  static const terminalStatuses = {
    'succeeded',
    'failed',
    'cancelled',
    'conflicted',
    'unknown-result',
  };

  final String operationId;
  final String requestId;
  final String repositoryId;
  final String kind;
  final String status;
  final int revision;
  final String? phase;
  final int phaseIndex;
  final int phaseCount;
  final bool canCancel;
  final bool recoveryBlocked;
  final int? createdAt;
  final int? updatedAt;
  final String? errorCode;
  final String? detail;
  final bool retryable;
  final bool requiresRefresh;
  final List<String> nextActions;
  final List<GitOperationStage> stages;
  final Map<String, dynamic> result;

  const GitOperation({
    required this.operationId,
    required this.requestId,
    required this.repositoryId,
    required this.kind,
    required this.status,
    required this.revision,
    this.phase,
    this.phaseIndex = 0,
    this.phaseCount = 1,
    this.canCancel = false,
    this.recoveryBlocked = false,
    this.createdAt,
    this.updatedAt,
    this.errorCode,
    this.detail,
    this.retryable = false,
    this.requiresRefresh = false,
    this.nextActions = const [],
    this.stages = const [],
    this.result = const {},
  });

  factory GitOperation.fromJson(Map<String, dynamic> json) {
    final error = _stringMap(json['error']);
    return GitOperation(
      operationId: json['operationId']?.toString() ?? '',
      requestId: json['requestId']?.toString() ?? '',
      repositoryId: json['repositoryId']?.toString() ?? '',
      kind: json['kind']?.toString() ?? '',
      status: json['status']?.toString() ?? 'unknown-result',
      revision: _intValue(json['revision']) ?? 0,
      phase: json['phase']?.toString(),
      phaseIndex: _intValue(json['phaseIndex']) ?? 0,
      phaseCount: _intValue(json['phaseCount']) ?? 1,
      canCancel: json['cancellable'] == true || json['canCancel'] == true,
      recoveryBlocked: json['recoveryBlocked'] == true,
      createdAt: _intValue(json['createdAt']),
      updatedAt: _intValue(json['updatedAt']),
      errorCode:
          json['errorCode']?.toString() ?? error['errorCode']?.toString(),
      detail: json['detail']?.toString() ?? error['detail']?.toString(),
      retryable: json['retryable'] == true || error['retryable'] == true,
      requiresRefresh:
          json['requiresRefresh'] == true || error['requiresRefresh'] == true,
      nextActions: _strings(json['nextActions'] ?? error['nextActions']),
      stages: (json['stages'] as List? ?? const [])
          .whereType<Map>()
          .map(
            (item) =>
                GitOperationStage.fromJson(Map<String, dynamic>.from(item)),
          )
          .toList(growable: false),
      result: UnmodifiableMapView(_stringMap(json['result'])),
    );
  }

  bool get terminal => terminalStatuses.contains(status);
  bool get running => status == 'queued' || status == 'running';
  bool get needsRecovery =>
      status == 'conflicted' || status == 'unknown-result';
  bool get succeeded => status == 'succeeded';
}

class GitAcceptedOperation {
  final bool accepted;
  final bool deduplicated;
  final String? queryUrl;
  final GitOperation operation;

  const GitAcceptedOperation({
    required this.accepted,
    required this.operation,
    this.deduplicated = false,
    this.queryUrl,
  });

  factory GitAcceptedOperation.fromJson(Map<String, dynamic> json) {
    final operationJson = _stringMap(json['operation']);
    operationJson.putIfAbsent(
      'operationId',
      () => json['operationId']?.toString() ?? '',
    );
    operationJson.putIfAbsent(
      'requestId',
      () => json['requestId']?.toString() ?? '',
    );
    operationJson.putIfAbsent(
      'status',
      () => json['status']?.toString() ?? 'queued',
    );
    return GitAcceptedOperation(
      accepted: json['accepted'] == true,
      deduplicated: json['deduplicated'] == true,
      queryUrl: json['queryUrl']?.toString(),
      operation: GitOperation.fromJson(operationJson),
    );
  }
}

class GitOperationPage {
  final List<GitOperation> operations;
  final String? nextCursor;

  const GitOperationPage({this.operations = const [], this.nextCursor});

  factory GitOperationPage.fromJson(Map<String, dynamic> json) =>
      GitOperationPage(
        operations: (json['operations'] as List? ?? const [])
            .whereType<Map>()
            .map(
              (item) => GitOperation.fromJson(Map<String, dynamic>.from(item)),
            )
            .toList(growable: false),
        nextCursor: json['nextCursor']?.toString(),
      );
}

class GitConfirmation {
  final String challengeId;
  final int expiresAt;
  final String summary;

  const GitConfirmation({
    required this.challengeId,
    required this.expiresAt,
    required this.summary,
  });

  factory GitConfirmation.fromJson(Map<String, dynamic> json) =>
      GitConfirmation(
        challengeId: json['challengeId']?.toString() ?? '',
        expiresAt: _intValue(json['expiresAt']) ?? 0,
        summary: json['summary']?.toString() ?? '',
      );
}
