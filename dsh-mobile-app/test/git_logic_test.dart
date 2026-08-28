import 'dart:async';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/git_graph_logic.dart' as graph;
import 'package:dsh_mobile_app/git_models.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeGitApi implements GitApi {
  final Map<String, Future<GitContext>> contexts;
  _FakeGitApi(this.contexts);
  @override
  Future<GitCapability> gitCapabilities() async =>
      const GitCapability(available: true, read: true);
  @override
  Future<GitContext> gitContext({String? sessionId, String? cwd}) =>
      contexts[sessionId] ?? Future.error('missing');
  @override
  Future<GitStatus> gitStatus(String id) async =>
      const GitStatus(branch: 'main');
  @override
  Future<List<GitBranch>> gitBranches(String id) async => const [];
}

void main() {
  test(
    'graph logic keeps lanes and switches selected ancestor color at node',
    () {
      const commits = [
        GitCommit(oid: 'tip', parents: ['ancestor']),
        GitCommit(oid: 'ancestor', parents: ['root']),
      ];
      const selected = [
        GitBranch(name: 'tip', displayName: 'tip', oid: 'tip'),
        GitBranch(name: 'main', displayName: 'main', oid: 'ancestor'),
      ];
      final rows = graph.layoutGraph(commits, selected).rows;
      expect(rows[0].parentColorSlots.single, rows[0].colorSlot);
      expect(rows[1].incomingColorSlot, isNot(rows[1].colorSlot));
    },
  );

  test('graph logic models merge two parent lanes and shared tip colors', () {
    const commits = [
      GitCommit(oid: 'merge', parents: ['a', 'b']),
    ];
    const selected = [
      GitBranch(name: 'one', displayName: 'one', oid: 'merge'),
      GitBranch(name: 'two', displayName: 'two', oid: 'merge'),
      GitBranch(name: 'three', displayName: 'three', oid: 'merge'),
      GitBranch(name: 'four', displayName: 'four', oid: 'merge'),
      GitBranch(name: 'five', displayName: 'five', oid: 'merge'),
    ];
    final row = graph.layoutGraph(commits, selected).rows.single;
    expect(row.parentLanes, [0, 1]);
    expect(row.tipColorSlots, [0, 1, 2, 3, 4]);
    expect(row.tipColorSlots.take(graph.maxNodeColorSegments).length, 3);
  });

  test('graph layout preserves continuation and peak lane count', () {
    const commits = [
      GitCommit(oid: 'merge', parents: ['a', 'b']),
      GitCommit(oid: 'b', parents: ['root']),
    ];
    final layout = graph.layoutGraph(commits, const []);
    expect(layout.laneCount, 2);
    expect(layout.rows[1].continuations, isNotEmpty);
    expect(layout.rows[1].continuations.first.from, 0);
    expect(layout.rows[1].continuations.first.to, 0);
  });

  test('graph labels prioritize current and compact overflow', () {
    const tips = [
      GitBranch(name: 'feature', displayName: 'feature', oid: '1'),
      GitBranch(name: 'main', displayName: 'main', oid: '1'),
    ];
    expect(graph.compactGraphLabels([], []), isEmpty);
    expect(graph.compactGraphLabels([tips[1]], ['v1']).map((x) => x.kind), [
      'branch',
      'tag',
    ]);
    final labels = graph.compactGraphLabels(tips, ['v1'], current: 'main');
    expect(labels.length, 2);
    expect(labels.first.branchName, 'main');
    expect(labels.first.current, isTrue);
    expect(labels.last.kind, 'overflow');
    expect(labels.last.hiddenCount, 2);
  });
  test('refreshGit clears repository state when context fails', () async {
    final pending = Completer<GitContext>();
    final api = _FakeGitApi({'A': pending.future});
    final store = AppStore(apiClient: api)..sessionId = 'A';
    store.gitContext = const GitContext(
      repositoryId: 'old',
      root: 'old',
      name: 'old',
      capabilities: GitCapability(),
    );
    store.gitStatus = const GitStatus(branch: 'old');
    store.gitBranches = [
      const GitBranch(name: 'old', displayName: 'old', oid: '1'),
    ];
    final refresh = store.refreshGit();
    pending.completeError('offline');
    await refresh;
    expect(store.gitContext, isNull);
    expect(store.gitStatus, isNull);
    expect(store.gitBranches, isEmpty);
  });

  test('late session A refresh cannot overwrite session B', () async {
    final a = Completer<GitContext>();
    final b = Completer<GitContext>();
    final api = _FakeGitApi({'A': a.future, 'B': b.future});
    final store = AppStore(apiClient: api)..sessionId = 'A';
    final first = store.refreshGit();
    store.sessionId = 'B';
    final second = store.refreshGit();
    b.complete(
      const GitContext(
        repositoryId: 'B',
        root: 'B',
        name: 'B',
        capabilities: GitCapability(),
      ),
    );
    await second;
    a.complete(
      const GitContext(
        repositoryId: 'A',
        root: 'A',
        name: 'A',
        capabilities: GitCapability(),
      ),
    );
    await first;
    expect(store.gitContext?.repositoryId, 'B');
  });
  test('Git quickbar always resolves to three unique supported slots', () {
    expect(AppStore.normalizeGitSlots(['graph', 'graph', 'unknown']), [
      'graph',
      'current-branch',
      'sync-status',
    ]);
    expect(
      AppStore.normalizeGitSlots(['status', 'diff', 'graph', 'current-branch']),
      ['status', 'diff', 'graph'],
    );
  });

  test('Git capability preserves unavailable reason and write boundary', () {
    final c = GitCapability.fromJson({
      'available': false,
      'read': false,
      'writes': false,
      'reason': 'git-provider-unavailable',
    });
    expect(c.available, isFalse);
    expect(c.writes, isFalse);
    expect(c.reason, 'git-provider-unavailable');
  });

  test('Git branches place local branches before remote branches', () {
    final branches = [
      const GitBranch(
        name: 'origin/main',
        displayName: 'origin/main',
        oid: '3',
        remote: true,
      ),
      const GitBranch(name: 'feature', displayName: 'feature', oid: '1'),
      const GitBranch(name: 'main', displayName: 'main', oid: '2'),
      const GitBranch(
        name: 'origin/feature',
        displayName: 'origin/feature',
        oid: '4',
        remote: true,
      ),
    ];

    expect(
      AppStore.sortGitBranches(branches).map((b) => b.displayName).toList(),
      ['feature', 'main', 'origin/main', 'origin/feature'],
    );
  });

  test('Git branch model cleans provider record line endings', () {
    final branch = GitBranch.fromJson({
      'name': '\nrefs/remotes/origin/main',
      'displayName': '\nrefs/remotes/origin/main',
      'oid': '1',
      'remote': false,
    });

    expect(branch.name, 'refs/remotes/origin/main');
    expect(branch.displayName, 'origin/main');
    expect(branch.remote, isTrue);
  });

  test('Git graph page keeps snapshot and pagination metadata', () {
    final page = GitGraphPage.fromJson({
      'snapshotId': 'snapshot-1',
      'nextCursor': 'cursor-2',
      'tips': [
        {'name': 'refs/heads/main', 'tipOid': 'abc'},
      ],
      'commits': [
        {
          'oid': 'abc',
          'parents': ['def', 'ghi'],
          'author': 'Alice',
          'timestamp': 1700000000,
          'subject': 'merge',
          'refs': ['HEAD -> refs/heads/main'],
        },
      ],
    });

    expect(page.snapshotId, 'snapshot-1');
    expect(page.nextCursor, 'cursor-2');
    expect(page.tips.single.name, 'refs/heads/main');
    expect(page.commits.single.parents, ['def', 'ghi']);
  });
}
