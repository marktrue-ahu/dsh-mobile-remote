import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/git_operation_store.dart';
import 'package:dsh_mobile_app/git_write_models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'git_test_fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('Git operation DTO preserves terminal errors and sync stage facts', () {
    final operation = GitOperation.fromJson({
      'operationId': 'op-1',
      'requestId': 'req-1',
      'repositoryId': 'repo-1',
      'kind': 'git.sync',
      'status': 'unknown-result',
      'revision': 7,
      'recoveryBlocked': true,
      'error': {
        'errorCode': 'network-error',
        'detail': 'result cannot be proved',
        'requiresRefresh': true,
        'nextActions': ['refresh', 'computer'],
      },
      'stages': [
        {
          'id': 'fetch',
          'kind': 'fetch',
          'status': 'succeeded',
          'sideEffects': ['remote-tracking-ref-updated'],
          'postFacts': {'oid': 'abc'},
        },
        {
          'id': 'push',
          'kind': 'push',
          'status': 'failed',
          'errorCode': 'remote-rejected',
        },
      ],
    });

    expect(operation.terminal, isTrue);
    expect(operation.needsRecovery, isTrue);
    expect(operation.errorCode, 'network-error');
    expect(operation.requiresRefresh, isTrue);
    expect(operation.stages.first.sideEffects, ['remote-tracking-ref-updated']);
    expect(operation.stages.last.errorCode, 'remote-rejected');
  });

  test('preflight executable state excludes noop and unsafe decisions', () {
    final noop = GitPreflight.fromJson({
      'operationKind': 'git.branch-switch',
      'repositoryId': 'repo-1',
      'noop': true,
      'safe': true,
      'preconditionToken': null,
    });
    final unsafe = GitPreflight.fromJson({
      'operationKind': 'git.branch-switch',
      'repositoryId': 'repo-1',
      'safe': false,
      'allowedActions': ['computer', 'cancel'],
    });
    final safe = GitPreflight.fromJson({
      'operationKind': 'git.branch-create',
      'repositoryId': 'repo-1',
      'params': {'name': 'feature/mobile'},
      'preconditionToken': 'signed-token',
    });

    expect(noop.canSubmit, isFalse);
    expect(unsafe.canSubmit, isFalse);
    expect(safe.canSubmit, isTrue);
  });

  test('operation reducer ignores duplicate and old SSE revisions', () async {
    final fake = FakeGitApi();
    final store = GitOperationStore(api: fake);
    addTearDown(store.dispose);

    bool apply(int revision, String status) => store.applyFrame({
      'operation': {
        'operationId': 'op-1',
        'requestId': 'req-1',
        'repositoryId': 'repo-1',
        'kind': 'git.sync',
        'status': status,
        'revision': revision,
      },
    });

    expect(apply(1, 'queued'), isTrue);
    expect(apply(1, 'running'), isFalse);
    expect(apply(0, 'failed'), isFalse);
    expect(store.byId('op-1')?.status, 'queued');
    expect(apply(3, 'running'), isTrue);
    await pumpEventQueue();
    expect(store.byId('op-1')?.revision, 3);
    expect(store.byId('op-1')?.status, 'running');
  });

  test('controller never resubmits after a lost accepted response', () async {
    final fake = _LostResponseApi();
    final store = GitOperationStore(api: fake);
    addTearDown(store.dispose);

    final operation = await store.submit(
      'repo-1',
      (requestId) => fake.sendLost(requestId),
      requestId: 'stable-request-id',
    );

    expect(fake.submitCount, 1);
    expect(operation.requestId, 'stable-request-id');
    expect(operation.status, 'queued');
  });

  test('B3 write carries contract header and accepts HTTP 202', () async {
    late http.Request captured;
    final client = MockClient((request) async {
      captured = request;
      return http.Response(
        jsonEncode({
          'accepted': true,
          'operationId': 'op-sync',
          'requestId': 'req-sync',
          'status': 'queued',
          'operation': {
            'operationId': 'op-sync',
            'requestId': 'req-sync',
            'repositoryId': 'repo-1',
            'kind': 'git.sync',
            'status': 'queued',
            'revision': 1,
          },
        }),
        202,
        headers: {'content-type': 'application/json'},
      );
    });
    final api = Api(client: client)
      ..baseUrl = 'http://localhost:3080'
      ..path = '/m';
    final preflight = GitPreflight.fromJson({
      'operationKind': 'git.sync',
      'repositoryId': 'repo-1',
      'params': {'remote': 'origin', 'branch': 'main', 'strategy': 'merge'},
      'preconditionToken': 'signed-token',
    });

    final accepted = await api.submitGitRemote(
      repositoryId: 'repo-1',
      preflight: preflight,
      requestId: 'req-sync',
    );

    expect(captured.url.path, '/m/api/git/sync');
    expect(captured.headers['x-dsh-git-contract'], '2.0');
    final body = jsonDecode(captured.body) as Map<String, dynamic>;
    expect(body.keys, {
      'repositoryId',
      'requestId',
      'params',
      'preconditionToken',
    });
    expect(jsonEncode(body), isNot(contains('refspec')));
    expect(jsonEncode(body), isNot(contains('command')));
    expect(jsonEncode(body), isNot(contains('path')));
    expect(accepted.operation.status, 'queued');
  });

  test('branch preflight fills service-owned context fields', () async {
    final client = MockClient((request) async {
      expect(request.url.path, '/m/api/git/branch-switch/preflight');
      return http.Response(
        jsonEncode({
          'preflight': {
            'action': 'switch',
            'safe': true,
            'noop': true,
            'targetBranch': 'main',
            'targetOid': 'deadbeef',
            'stateVersion': 'state-1',
            'preconditionToken': null,
          },
        }),
        200,
      );
    });
    final api = Api(client: client)
      ..baseUrl = 'http://localhost:3080'
      ..path = '/m';

    final preflight = await api.gitBranchPreflight(
      'repo-1',
      action: 'switch',
      targetBranch: 'main',
    );

    expect(preflight.repositoryId, 'repo-1');
    expect(preflight.operationKind, 'git.branch-switch');
    expect(preflight.noop, isTrue);
  });

  test('remote preflight preserves implicit upstream omission', () async {
    late Map<String, dynamic> captured;
    final client = MockClient((request) async {
      captured = jsonDecode(request.body) as Map<String, dynamic>;
      return http.Response(
        jsonEncode({
          'preflight': {
            'operationKind': 'git.fetch',
            'repositoryId': 'repo-1',
            'params': {'remote': 'origin', 'branch': 'main'},
            'preconditionToken': 'signed-token',
          },
        }),
        200,
      );
    });
    final api = Api(client: client)
      ..baseUrl = 'http://localhost:3080'
      ..path = '/m';

    final preflight = await api.gitRemotePreflight('repo-1', kind: 'fetch');

    expect(captured.keys, {'repositoryId'});
    expect(preflight.canSubmit, isTrue);
  });

  test(
    'stage payload contains only durable ids and signed precondition',
    () async {
      late Map<String, dynamic> captured;
      late http.Request request;
      final client = MockClient((value) async {
        request = value;
        captured = jsonDecode(value.body) as Map<String, dynamic>;
        return http.Response(
          jsonEncode({
            'accepted': true,
            'operation': {
              'operationId': 'op-stage',
              'requestId': 'req-stage',
              'repositoryId': 'repo-1',
              'kind': 'git.stage',
              'status': 'queued',
              'revision': 1,
            },
          }),
          202,
        );
      });
      final api = Api(client: client)
        ..baseUrl = 'http://localhost:3080'
        ..path = '/m';
      const set = GitChangeSet(
        changeSetId: 'set-1',
        repositoryId: 'repo-1',
        kind: 'working',
        stateVersion: 'v1',
        preconditionToken: 'signed-token',
      );

      await api.submitGitSelection(
        repositoryId: 'repo-1',
        changeSet: set,
        selections: const [
          GitFileSelection(fileId: 'file-1', hunkIds: ['hunk-1']),
        ],
        requestId: 'req-stage',
      );

      expect(request.headers['x-dsh-git-contract'], '2.0');
      expect(captured.keys, {
        'repositoryId',
        'requestId',
        'changeSetId',
        'selections',
        'preconditionToken',
      });
      expect(captured['selections'], [
        {
          'fileId': 'file-1',
          'hunkIds': ['hunk-1'],
        },
      ]);
    },
  );

  test('structured Git API errors expose refresh and retry policy', () async {
    final client = MockClient(
      (_) async => http.Response(
        jsonEncode({
          'error': 'state-changed',
          'detail': 'refresh required',
          'retryable': false,
          'requiresRefresh': true,
          'nextActions': ['refresh'],
        }),
        409,
      ),
    );
    final api = Api(client: client)
      ..baseUrl = 'http://localhost:3080'
      ..path = '/m';

    await expectLater(
      api.createGitChangeSet('repo-1', 'working'),
      throwsA(
        isA<ApiException>()
            .having((error) => error.code, 'code', 'state-changed')
            .having((error) => error.statusCode, 'statusCode', 409)
            .having((error) => error.requiresRefresh, 'requiresRefresh', isTrue)
            .having((error) => error.retryable, 'retryable', isFalse),
      ),
    );
  });
}

class _LostResponseApi extends FakeGitApi {
  int submitCount = 0;

  Future<GitAcceptedOperation> sendLost(String requestId) async {
    submitCount += 1;
    operationMap['lost-op'] = GitOperation(
      operationId: 'lost-op',
      requestId: requestId,
      repositoryId: 'repo-1',
      kind: 'git.push',
      status: 'queued',
      revision: 1,
      canCancel: true,
    );
    throw ApiException('connection lost');
  }
}
