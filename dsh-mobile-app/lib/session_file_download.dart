// GitLab #138：会话文件浏览页的单活动下载控制器。
//
// 只负责一个下载任务的状态机 + 断点续传；UI 负责行/预览按钮、下载条与对话框。
// 路径规则：本地断点键用绝对路径，请求用会话 cwd 相对路径 + sessionId（#16），
// 服务端再次做 realpath/fd 校验，客户端不能凭路径绕过。
import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'api.dart';
import 'download.dart';
import 'download_error.dart';
import 'download_foreground.dart';
import 'resumable_download.dart';
import 'session_files_logic.dart';

enum SessionFileDownloadPhase { idle, downloading, paused, saving, failed, done }

class SessionFileDownloadController extends ChangeNotifier {
  SessionFileDownloadController({
    required this.api,
    required this.sessionId,
    required this.root,
    required ResumableDownloads downloads,
    required Future<String?> Function(File file, String name) saveFile,
    DownloadForeground? foreground,
    http.Client? downloadClient,
  }) : _downloads = downloads,
       _saveFile = saveFile,
       _foreground = foreground,
       _downloadClient = downloadClient;

  final Api api;
  final String sessionId;
  String root;
  final ResumableDownloads _downloads;
  final Future<String?> Function(File file, String name) _saveFile;
  final DownloadForeground? _foreground;
  final http.Client? _downloadClient;

  SessionFileDownloadPhase phase = SessionFileDownloadPhase.idle;
  String? absolutePath;
  String? relativePath;
  String? name;
  DownloadProgress progress = const DownloadProgress(received: 0);
  DownloadFailure? failure;
  String? savedPath;

  DownloadCancelToken? _cancel;
  DownloadForegroundLease? _lease;
  int _runId = 0;
  bool _disposed = false;

  ResumableDownloads get downloads => _downloads;

  bool get busy =>
      phase == SessionFileDownloadPhase.downloading ||
      phase == SessionFileDownloadPhase.saving;

  bool isCurrent(String path) => absolutePath == path;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  void _resetTask() {
    absolutePath = null;
    relativePath = null;
    name = null;
    progress = const DownloadProgress(received: 0);
    failure = null;
    savedPath = null;
  }

  /// 检查是否可接受新任务；返回 false 时调用方应提示“正在下载另一个文件”。
  bool canStart(String path) {
    if (!busy) return true;
    return absolutePath == path;
  }

  Future<bool> start(
    String absolute, {
    void Function(String message)? onBackgroundUnavailable,
  }) async {
    if (busy && absolutePath != absolute) return false;
    final relative = relativePathWithinRoot(root, absolute);
    if (relative == null) {
      _resetTask();
      absolutePath = absolute;
      name = _nameOf(absolute);
      phase = SessionFileDownloadPhase.failed;
      failure = DownloadFailure(
        summary: '路径不在当前会话工作目录内',
        hint: '只允许下载会话工作目录内的真实文件。',
        detail: 'refused: path outside session cwd',
      );
      _notify();
      return true;
    }
    // 同一文件暂停后再次点击 = 续传；新文件先取消旧任务（单活动）。
    if (busy || phase == SessionFileDownloadPhase.saving) {
      _cancel?.cancel();
    }
    final run = ++_runId;
    _resetTask();
    absolutePath = absolute;
    relativePath = relative;
    name = _nameOf(absolute);
    phase = SessionFileDownloadPhase.downloading;
    progress = const DownloadProgress(received: 0);
    _notify();

    final cancel = DownloadCancelToken();
    _cancel = cancel;
    DownloadForegroundLease? lease;
    try {
      final foreground = _foreground;
      if (foreground != null) {
        lease = await foreground.start(cancel);
        _lease = lease;
        if (!lease.backgroundActive &&
            lease.unavailableReason != null &&
            onBackgroundUnavailable != null) {
          onBackgroundUnavailable(
            lease.unavailableReason == 'service-unavailable'
                ? '后台下载不可用，本次保持前台下载'
                : '后台下载不可用，本次保持前台下载',
          );
        }
      }
      final result = await _downloads.download(
        absolute,
        requestPath: relative,
        sessionId: sessionId,
        cancel: cancel,
        downloadClient: _downloadClient,
        onProgress: (p) {
          if (run != _runId) return;
          progress = p;
          _notify();
          lease?.progress(p);
        },
      );
      if (run != _runId) return true;
      if (cancel.cancelled) throw const DownloadCancelled();
      phase = SessionFileDownloadPhase.saving;
      _notify();
      final saved = await _saveFile(result.file, name ?? _nameOf(absolute));
      if (run != _runId) return true;
      savedPath = saved;
      // 已完成并保存：清掉私有断点，避免下次 pending 列表把已完成任务当未完成。
      try {
        await _downloads.discard(absolute);
      } catch (_) {
        // 保存完成但断点清理失败不影响完成态。
      }
      phase = SessionFileDownloadPhase.done;
      _notify();
    } on DownloadCancelled {
      if (run != _runId) return true;
      // 暂停：断点记录已由 ResumableDownloads 保留；不显示失败。
      phase = SessionFileDownloadPhase.paused;
      failure = null;
      _notify();
    } catch (e) {
      if (run != _runId) return true;
      phase = SessionFileDownloadPhase.failed;
      failure = describeDownloadError(e);
      _notify();
    } finally {
      await lease?.close();
      if (identical(_lease, lease)) _lease = null;
      if (identical(_cancel, cancel)) _cancel = null;
    }
    return true;
  }

  /// 暂停（取消当前传输但保留断点）；不等待底层抛出，由 start 的 catch 收尾。
  void pause() {
    if (phase == SessionFileDownloadPhase.downloading) {
      _cancel?.cancel();
    }
  }

  Future<void> retry() async {
    final path = absolutePath;
    if (path == null) return;
    await start(path);
  }

  /// 完成后清空下载条（UI 已展示完成对话框）。
  void dismissDone() {
    if (phase != SessionFileDownloadPhase.done) return;
    _resetTask();
    phase = SessionFileDownloadPhase.idle;
    _notify();
  }

  /// 丢弃当前文件的断点；进行中的任务先暂停。
  Future<void> discard() async {
    final path = absolutePath;
    if (path == null) return;
    _cancel?.cancel();
    _runId++;
    await _lease?.close();
    _lease = null;
    try {
      await _downloads.discard(path);
    } catch (_) {
      // 下载刚结束/正在收尾时丢弃失败：保留断点更安全。
    }
    _resetTask();
    phase = SessionFileDownloadPhase.idle;
    _notify();
  }

  Future<List<PendingDownload>> pending() => _downloads.pending();

  /// 恢复指定断点（UI 从未完成 banner / picker 返回的绝对路径调用）。
  Future<bool> resumePending(String path) => start(path);

  static String _nameOf(String path) {
    final parts = path.split(RegExp(r'[\\/]')).where((s) => s.isNotEmpty);
    return parts.isEmpty ? 'file' : parts.last;
  }

  @override
  void dispose() {
    _disposed = true;
    _runId++;
    _cancel?.cancel();
    unawaited(_lease?.close() ?? Future<void>.value());
    super.dispose();
  }
}
