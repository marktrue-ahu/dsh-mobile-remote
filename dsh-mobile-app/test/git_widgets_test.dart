import 'package:dsh_mobile_app/git_write_models.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/widgets/git_write_widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'git_test_fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  Future<AppStore> makeStore(FakeGitApi fake) async {
    final store = AppStore(apiClient: fake, gitWriteApi: fake)
      ..sessionId = 'session-1';
    await store.refreshGit(notify: false);
    return store;
  }

  Widget harness(Widget child) => MaterialApp(home: Scaffold(body: child));

  test('branch noop is handled locally without a submit request', () async {
    final fake = FakeGitApi()..noopSwitch = true;
    final store = await makeStore(fake);
    addTearDown(store.dispose);

    final preflight = await store.prepareGitBranch(
      action: 'switch',
      targetBranch: 'main',
    );
    expect(preflight.noop, isTrue);
    expect(await store.submitGitBranch(preflight), isNull);
    expect(fake.branchSubmitCount, 0);
  });

  test('commit message changes are rejected before submit', () async {
    final fake = FakeGitApi();
    final store = await makeStore(fake);
    addTearDown(store.dispose);

    final preflight = await store.prepareGitCommit('original message');
    expect(
      () => store.submitGitCommit(preflight, 'edited after confirmation'),
      throwsA(isA<StateError>()),
    );
  });

  testWidgets('status sheet stages selected durable file id', (tester) async {
    await tester.binding.setSurfaceSize(const Size(800, 1100));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final fake = FakeGitApi();
    final store = await makeStore(fake);
    addTearDown(store.dispose);

    await tester.pumpWidget(harness(GitStatusWriteSheet(store: store)));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('git-status-sheet')), findsOneWidget);
    expect(find.text('lib/example.dart'), findsOneWidget);
    expect(find.byKey(const ValueKey('git-stage-submit')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('git-file-working-file')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('git-stage-submit')));
    await tester.pump(const Duration(milliseconds: 500));

    expect(fake.lastSelections, hasLength(1));
    expect(fake.lastSelections.single.fileId, 'working-file');
    expect(fake.lastSelections.single.hunkIds, isEmpty);
    expect(store.gitOperations.operations.values.single.kind, 'git.stage');
  });

  testWidgets('diff sheet stages only selected hunk id', (tester) async {
    await tester.binding.setSurfaceSize(const Size(800, 1100));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final fake = FakeGitApi();
    final store = await makeStore(fake);
    addTearDown(store.dispose);

    await tester.pumpWidget(
      harness(GitStatusWriteSheet(store: store, showDiff: true)),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('@@ -1 +1 @@'));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('git-stage-submit')));
    await tester.pump(const Duration(milliseconds: 500));

    expect(fake.lastSelections.single.fileId, 'working-file');
    expect(fake.lastSelections.single.hunkIds, ['hunk-1']);
  });

  testWidgets(
    'commit requires preflight and explicit staged facts confirmation',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(800, 1100));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final fake = FakeGitApi();
      final store = await makeStore(fake);
      addTearDown(store.dispose);

      await tester.pumpWidget(harness(GitStatusWriteSheet(store: store)));
      await tester.pumpAndSettle();
      await tester.tap(find.text('已暂存'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('git-commit-open')));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField), 'feat: mobile commit');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('git-commit-preflight')));
      await tester.pumpAndSettle();

      expect(find.textContaining('Staged tree：2222222222'), findsOneWidget);
      expect(find.textContaining('Alice <alice@example.com>'), findsOneWidget);
      expect(find.text('移动端提交策略：不运行 hooks'), findsOneWidget);
      final submit = tester.widget<FilledButton>(
        find.byKey(const ValueKey('git-commit-submit')),
      );
      expect(submit.onPressed, isNull);

      await tester.tap(find.text('我已核对 staged tree、身份和提交消息'));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('git-commit-submit')));
      await tester.pump(const Duration(milliseconds: 500));

      expect(fake.lastSubmittedPreflight?.data['branch'], 'main');
      expect(
        store.gitOperations.operations.values.any(
          (operation) => operation.kind == 'git.commit',
        ),
        isTrue,
      );
    },
  );

  testWidgets('local branch switch opens confirmation and submits', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(800, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final fake = FakeGitApi();
    final store = await makeStore(fake);
    addTearDown(store.dispose);

    await tester.pumpWidget(harness(GitBranchWriteSheet(store: store)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('feature'));
    await tester.pumpAndSettle();

    expect(find.text('切换分支？'), findsOneWidget);
    await tester.tap(find.text('确认'));
    await tester.pump(const Duration(milliseconds: 500));

    expect(fake.lastSubmittedPreflight?.params['targetBranch'], 'feature');
    expect(
      store.gitOperations.operations.values.any(
        (operation) => operation.kind == 'git.branch-switch',
      ),
      isTrue,
    );
  });

  testWidgets('protected branch switch offers no force action', (tester) async {
    await tester.binding.setSurfaceSize(const Size(800, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final fake = FakeGitApi()..unsafeSwitch = true;
    final store = await makeStore(fake);
    addTearDown(store.dispose);

    await tester.pumpWidget(harness(GitBranchWriteSheet(store: store)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('feature'));
    await tester.pumpAndSettle();

    expect(find.text('无法安全切换'), findsOneWidget);
    expect(find.textContaining('commit / computer / cancel'), findsOneWidget);
    expect(find.textContaining('不会 force'), findsOneWidget);
    expect(find.textContaining('强制切换'), findsNothing);
  });

  testWidgets('branch create uses signed preflight params', (tester) async {
    await tester.binding.setSurfaceSize(const Size(800, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final fake = FakeGitApi();
    final store = await makeStore(fake);
    addTearDown(store.dispose);

    await tester.pumpWidget(harness(GitBranchWriteSheet(store: store)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('git-branch-create')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'feature/mobile');
    await tester.tap(find.text('下一步'));
    await tester.pumpAndSettle();
    expect(find.text('创建分支？'), findsOneWidget);
    await tester.tap(find.text('确认'));
    await tester.pump(const Duration(milliseconds: 500));

    expect(fake.lastSubmittedPreflight?.params['name'], 'feature/mobile');
    expect(
      store.gitOperations.operations.values.any(
        (operation) => operation.kind == 'git.branch-create',
      ),
      isTrue,
    );
  });

  testWidgets(
    'sync requires explicit remote and branch then tracks operation',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(800, 1100));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final fake = FakeGitApi();
      final store = await makeStore(fake);
      addTearDown(store.dispose);

      await tester.pumpWidget(harness(GitSyncSheet(store: store)));
      await tester.pumpAndSettle();
      FilledButton submit() => tester.widget<FilledButton>(
        find.byKey(const ValueKey('git-sync-submit')),
      );
      expect(submit().onPressed, isNull);

      await tester.tap(find.byKey(const ValueKey('git-sync-remote')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('origin').last);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('git-sync-branch')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('main').last);
      await tester.pumpAndSettle();
      expect(submit().onPressed, isNotNull);

      await tester.tap(find.byKey(const ValueKey('git-sync-submit')));
      await tester.pumpAndSettle();
      expect(find.textContaining('远端：origin'), findsOneWidget);
      expect(find.textContaining('整合策略：merge'), findsOneWidget);
      await tester.tap(find.text('开始同步'));
      await tester.pump(const Duration(milliseconds: 500));

      expect(fake.lastSubmittedPreflight?.params['remote'], 'origin');
      expect(fake.lastSubmittedPreflight?.params['branch'], 'main');
      expect(
        store.gitOperations.operations.values.any(
          (operation) => operation.kind == 'git.sync',
        ),
        isTrue,
      );
    },
  );

  testWidgets('conflict handoff and abort are separate explicit actions', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(800, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final fake = FakeGitApi();
    final store = await makeStore(fake);
    addTearDown(store.dispose);
    const conflicted = GitOperation(
      operationId: 'conflict-1',
      requestId: 'request-conflict',
      repositoryId: 'repo-1',
      kind: 'git.pull',
      status: 'conflicted',
      revision: 4,
      recoveryBlocked: true,
    );
    store.gitOperations.merge(conflicted);

    await tester.pumpWidget(
      harness(GitOperationCard(store: store, operation: conflicted)),
    );
    await tester.pumpAndSettle();
    expect(find.text('取消任务（不回滚）'), findsNothing);
    expect(find.text('转电脑处理'), findsOneWidget);
    expect(find.text('交给模型'), findsOneWidget);

    await tester.tap(find.text('交给模型'));
    await tester.pumpAndSettle();
    expect(fake.lastHandoffTarget, 'model');

    await tester.tap(find.byKey(const ValueKey('git-conflict-abort')));
    await tester.pumpAndSettle();
    expect(find.text('放弃当前冲突操作？'), findsOneWidget);
    expect(find.textContaining('一次性确认挑战'), findsOneWidget);
    await tester.tap(find.text('放弃并恢复'));
    await tester.pumpAndSettle();
    expect(
      store.gitOperations.operations.values.any(
        (operation) => operation.kind == 'git.abort',
      ),
      isTrue,
    );
  });
}
