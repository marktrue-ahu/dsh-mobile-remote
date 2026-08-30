import 'package:dsh_mobile_app/git_write_models.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/widgets/git_widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../test/git_test_fakes.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Slice B stage then explicit remote sync user flow', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});
    final fake = FakeGitApi();
    final store = AppStore(apiClient: fake, gitWriteApi: fake)
      ..sessionId = 'session-1'
      ..gitQuickbar = ['status', 'current-branch', 'sync-status'];
    addTearDown(store.dispose);
    await store.refreshGit(notify: false);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.bottomCenter,
            child: GitQuickbar(store: store),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('工作区状态'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('git-file-working-file')));
    await tester.tap(find.byKey(const ValueKey('git-stage-submit')));
    await tester.pump(const Duration(milliseconds: 500));
    expect(fake.lastSelections.single.fileId, 'working-file');

    final stage = store.gitOperations.operations.values.single;
    store.gitOperations.merge(
      GitOperation(
        operationId: stage.operationId,
        requestId: stage.requestId,
        repositoryId: stage.repositoryId,
        kind: stage.kind,
        status: 'succeeded',
        revision: stage.revision + 1,
      ),
    );
    await tester.pageBack();
    await tester.pumpAndSettle();

    await tester.tap(find.text('同步'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('git-sync-remote')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('origin').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('git-sync-branch')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('main').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('git-sync-submit')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('开始同步'));
    await tester.pump(const Duration(milliseconds: 500));

    expect(fake.lastSubmittedPreflight?.params['remote'], 'origin');
    expect(fake.lastSubmittedPreflight?.params['branch'], 'main');
  });
}
