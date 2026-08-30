import 'dart:async';
import 'dart:collection';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'git_write_models.dart';

class GitOperationStore extends ChangeNotifier {
  static const _trackedKey = 'git_tracked_operation_ids_v1';
  static const _maxTracked = 50;

  final GitWriteApi api;
  final FutureOr<void> Function(GitOperation operation)? onTerminal;
  final Map<String, GitOperation> _operations = {};
  final Map<String, int> _arrivalOrder = {};
  final LinkedHashSet<String> _tracked = LinkedHashSet<String>();
  final Set<String> _refreshingRepositories = {};
  bool _loaded = false;
  int _arrivalSequence = 0;
  int _persistGeneration = 0;
  bool _disposed = false;

  bool get refreshing => _refreshingRepositories.isNotEmpty;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  GitOperationStore({required this.api, this.onTerminal});

  Map<String, GitOperation> get operations => UnmodifiableMapView(_operations);

  GitOperation? byId(String operationId) => _operations[operationId];

  List<GitOperation> forRepository(String repositoryId) {
    final values = _operations.values
        .where((operation) => operation.repositoryId == repositoryId)
        .toList();
    values.sort((left, right) {
      final created = (right.createdAt ?? -1).compareTo(left.createdAt ?? -1);
      if (created != 0) return created;
      final arrival = (_arrivalOrder[right.operationId] ?? 0).compareTo(
        _arrivalOrder[left.operationId] ?? 0,
      );
      return arrival != 0
          ? arrival
          : right.operationId.compareTo(left.operationId);
    });
    return values;
  }

  GitOperation? latestFor(String repositoryId) {
    final values = forRepository(repositoryId);
    return values.isEmpty ? null : values.first;
  }

  GitOperation? activeFor(String repositoryId) {
    for (final operation in forRepository(repositoryId)) {
      if (operation.running || operation.needsRecovery) return operation;
    }
    return null;
  }

  Future<void> loadTracked() async {
    if (_loaded || _disposed) return;
    _loaded = true;
    try {
      final preferences = await SharedPreferences.getInstance();
      if (_disposed) return;
      for (final id in preferences.getStringList(_trackedKey) ?? const []) {
        if (id.isNotEmpty) _tracked.add(id);
      }
      final ids = _tracked.toList(growable: false);
      await Future.wait(ids.map(reconcile).toList(growable: false));
    } catch (_) {
      // Persistence is a recovery aid, not a reason to break the Git read path.
    }
  }

  Future<void> _persistTracked() async {
    if (_disposed) return;
    try {
      while (_tracked.length > _maxTracked) {
        _tracked.remove(_tracked.first);
      }
      final generation = ++_persistGeneration;
      final ids = _tracked.toList(growable: false);
      final preferences = await SharedPreferences.getInstance();
      if (_disposed || generation != _persistGeneration) return;
      await preferences.setStringList(_trackedKey, ids);
    } catch (_) {
      // A failed local preference write must not affect an already accepted task.
    }
  }

  bool merge(GitOperation operation, {bool fromFrame = false}) {
    if (_disposed || operation.operationId.isEmpty) return false;
    final current = _operations[operation.operationId];
    if (current != null && operation.revision <= current.revision) return false;
    final jumped = current != null && operation.revision > current.revision + 1;
    final becameTerminal =
        operation.terminal && (current == null || !current.terminal);
    _operations[operation.operationId] = operation;
    _arrivalOrder.putIfAbsent(operation.operationId, () => ++_arrivalSequence);
    _tracked
      ..remove(operation.operationId)
      ..add(operation.operationId);
    unawaited(_persistTracked());
    _notify();
    if (jumped && fromFrame) {
      unawaited(
        reconcile(operation.operationId, minimumRevision: operation.revision),
      );
    }
    if (becameTerminal && !_disposed) {
      unawaited(Future.sync(() => onTerminal?.call(operation)));
    }
    return true;
  }

  bool applyFrame(Map<String, dynamic> frame) {
    final raw = frame['operation'];
    if (raw is! Map) return false;
    return merge(
      GitOperation.fromJson(Map<String, dynamic>.from(raw)),
      fromFrame: true,
    );
  }

  Future<GitOperation?> reconcile(
    String operationId, {
    int? minimumRevision,
  }) async {
    for (var attempt = 0; attempt < 3 && !_disposed; attempt += 1) {
      try {
        final operation = await api.gitOperation(operationId);
        if (_disposed) return _operations[operationId];
        merge(operation);
        if (minimumRevision == null || operation.revision >= minimumRevision) {
          return _operations[operationId];
        }
      } catch (_) {
        if (attempt == 2) return _operations[operationId];
      }
      await Future<void>.delayed(Duration(milliseconds: 40 * (attempt + 1)));
    }
    return _operations[operationId];
  }

  Future<void> refreshRepository(String repositoryId) async {
    if (repositoryId.isEmpty ||
        _refreshingRepositories.contains(repositoryId)) {
      return;
    }
    _refreshingRepositories.add(repositoryId);
    _notify();
    try {
      String? cursor;
      var pages = 0;
      do {
        final page = await api.gitOperations(
          repositoryId: repositoryId,
          cursor: cursor,
          limit: 100,
        );
        if (_disposed) return;
        for (final operation in page.operations) {
          merge(operation);
        }
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor != null && pages < 5);
      for (final id in _tracked.toList(growable: false)) {
        final known = _operations[id];
        if (known == null || !known.terminal) await reconcile(id);
      }
    } catch (_) {
      // Reconnect/foreground reconciliation is best-effort. The tracked ids stay
      // persisted and will be queried on the next hello or explicit refresh.
    } finally {
      _refreshingRepositories.remove(repositoryId);
      _notify();
    }
  }

  Future<GitOperation> submit(
    String repositoryId,
    Future<GitAcceptedOperation> Function(String requestId) send, {
    String? requestId,
  }) async {
    final id = requestId ?? genRequestId();
    try {
      final accepted = await send(id);
      merge(accepted.operation);
      return accepted.operation;
    } catch (_) {
      // The HTTP result can be lost after the durable request was accepted. Query
      // by the same requestId before surfacing the failure; never resubmit here.
      try {
        String? cursor;
        var pages = 0;
        do {
          final page = await api.gitOperations(
            repositoryId: repositoryId,
            cursor: cursor,
            limit: 100,
          );
          if (_disposed) rethrow;
          for (final operation in page.operations) {
            merge(operation);
            if (operation.requestId == id) return operation;
          }
          cursor = page.nextCursor;
          pages += 1;
        } while (cursor != null && pages < 10);
      } catch (_) {}
      rethrow;
    }
  }

  Future<GitOperation> cancel(GitOperation operation) async {
    final accepted = await api.cancelGitOperation(
      operation,
      requestId: genRequestId(),
    );
    merge(accepted.operation);
    return accepted.operation;
  }

  Future<GitOperation> handoff(GitOperation operation, String target) async {
    final result = await api.handoffGitOperation(
      operation,
      target: target,
      requestId: genRequestId(),
    );
    merge(result);
    return result;
  }

  Future<GitOperation> acknowledge(
    GitOperation operation,
    String stateVersion,
  ) async {
    final result = await api.acknowledgeGitRecovery(
      operation,
      stateVersion: stateVersion,
      requestId: genRequestId(),
    );
    merge(result);
    return result;
  }

  @override
  void dispose() {
    _disposed = true;
    _persistGeneration += 1;
    super.dispose();
  }
}
