class GitCapability {
  final bool available;
  final bool read;
  final bool writes;
  final String? reason;
  final Map<String, bool> features;
  const GitCapability({
    this.available = false,
    this.read = false,
    this.writes = false,
    this.reason,
    this.features = const {},
  });
  factory GitCapability.fromJson(Map<String, dynamic>? json) {
    final f =
        (json?['features'] as Map?)?.map(
          (k, v) => MapEntry(k.toString(), v == true),
        ) ??
        <String, bool>{};
    return GitCapability(
      available: json?['available'] == true,
      read: json?['read'] == true,
      writes: json?['writes'] == true,
      reason: json?['reason']?.toString(),
      features: f,
    );
  }
}

class GitContext {
  final String repositoryId;
  final String root;
  final String name;
  final GitCapability capabilities;
  const GitContext({
    required this.repositoryId,
    required this.root,
    required this.name,
    required this.capabilities,
  });
  factory GitContext.fromJson(Map<String, dynamic> j) => GitContext(
    repositoryId: j['repositoryId']?.toString() ?? '',
    root: j['root']?.toString() ?? '',
    name: j['name']?.toString() ?? '',
    capabilities: GitCapability.fromJson(
      j['capabilities'] as Map<String, dynamic>?,
    ),
  );
}

class GitStatus {
  final String branch;
  final int ahead;
  final int behind;
  final List<Map<String, dynamic>> entries;
  final Map<String, dynamic> counts;
  const GitStatus({
    this.branch = 'HEAD',
    this.ahead = 0,
    this.behind = 0,
    this.entries = const [],
    this.counts = const {},
  });
  factory GitStatus.fromJson(Map<String, dynamic> j) => GitStatus(
    branch: j['branch']?.toString() ?? 'HEAD',
    ahead: (j['ahead'] as num?)?.toInt() ?? 0,
    behind: (j['behind'] as num?)?.toInt() ?? 0,
    entries: (j['entries'] as List? ?? [])
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList(),
    counts: Map<String, dynamic>.from((j['counts'] as Map?) ?? {}),
  );
}

class GitBranch {
  final String name;
  final String displayName;
  final String oid;
  final bool remote;
  final String? upstream;
  const GitBranch({
    required this.name,
    required this.displayName,
    required this.oid,
    this.remote = false,
    this.upstream,
  });
  factory GitBranch.fromJson(Map<String, dynamic> j) {
    String cleanRecord(String value) => value
        .replaceFirst(RegExp(r'^[\r\n]+'), '')
        .replaceFirst(RegExp(r'[\r\n]+$'), '');
    String cleanRef(String value) =>
        cleanRecord(value).replaceFirst(RegExp(r'^refs/(heads|remotes)/'), '');
    final name = cleanRecord(j['name']?.toString() ?? '');
    final rawDisplayName = j['displayName']?.toString();
    final displayName = cleanRef(
      rawDisplayName == null || rawDisplayName.isEmpty ? name : rawDisplayName,
    );
    return GitBranch(
      name: name,
      displayName: displayName,
      oid: j['oid']?.toString() ?? '',
      remote: j['remote'] == true || name.startsWith('refs/remotes/'),
      upstream: j['upstream']?.toString(),
    );
  }
}

class GitCommit {
  final String oid;
  final List<String> parents;
  final String author;
  final int timestamp;
  final String subject;
  final List<String> refs;
  const GitCommit({
    required this.oid,
    this.parents = const [],
    this.author = '',
    this.timestamp = 0,
    this.subject = '',
    this.refs = const [],
  });
  factory GitCommit.fromJson(Map<String, dynamic> j) => GitCommit(
    oid: j['oid']?.toString() ?? '',
    parents: (j['parents'] as List? ?? []).map((e) => e.toString()).toList(),
    author: j['author']?.toString() ?? '',
    timestamp: (j['timestamp'] as num?)?.toInt() ?? 0,
    subject: j['subject']?.toString() ?? '',
    refs: (j['refs'] as List? ?? []).map((e) => e.toString()).toList(),
  );
}

class GitGraphTip {
  final String name;
  final String tipOid;
  const GitGraphTip({required this.name, required this.tipOid});
  factory GitGraphTip.fromJson(Map<String, dynamic> j) => GitGraphTip(
    name: j['name']?.toString() ?? '',
    tipOid: j['tipOid']?.toString() ?? '',
  );
}

class GitGraphPage {
  final List<GitCommit> commits;
  final String? snapshotId;
  final String? nextCursor;
  final List<GitGraphTip> tips;
  const GitGraphPage({
    this.commits = const [],
    this.snapshotId,
    this.nextCursor,
    this.tips = const [],
  });
  factory GitGraphPage.fromJson(Map<String, dynamic> j) => GitGraphPage(
    commits: (j['commits'] as List? ?? [])
        .whereType<Map>()
        .map((e) => GitCommit.fromJson(Map<String, dynamic>.from(e)))
        .toList(),
    snapshotId: j['snapshotId']?.toString(),
    nextCursor: j['nextCursor']?.toString(),
    tips: (j['tips'] as List? ?? [])
        .whereType<Map>()
        .map((e) => GitGraphTip.fromJson(Map<String, dynamic>.from(e)))
        .toList(),
  );
}

class GitDiff {
  final String text;
  final bool truncated;
  const GitDiff({this.text = '', this.truncated = false});
  factory GitDiff.fromJson(Map<String, dynamic> j) => GitDiff(
    text: j['text']?.toString() ?? '',
    truncated: j['truncated'] == true,
  );
}

const gitQuickbarSlots = <String>[
  'current-branch',
  'graph',
  'sync-status',
  'status',
  'diff',
];
const defaultGitQuickbar = <String>['current-branch', 'graph', 'sync-status'];
String gitSlotTitle(String slot) =>
    const {
      'current-branch': '当前分支',
      'graph': '分支图',
      'sync-status': '同步状态',
      'status': '工作区状态',
      'diff': '差异',
    }[slot] ??
    slot;
