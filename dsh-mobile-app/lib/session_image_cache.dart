// issue #157：会话文件图片字节缓存。
//
// 键 = 当前连接 profile（无 profileId 时用 hostIdentity/baseUrl）+ sessionId +
// cwd 相对路径；ETag 随条目保存并在请求时通过 If-None-Match 复核。只缓存已成功
// 读取的字节，失败不缓存；列表不预加载，只有打开查看器才写入。
import 'dart:collection';
import 'dart:typed_data';

import 'api.dart';

class CachedSessionImage {
  const CachedSessionImage({
    required this.bytes,
    required this.contentType,
    required this.etag,
    required this.relativePath,
  });

  final Uint8List bytes;
  final String? contentType;
  final String? etag;
  final String relativePath;
}

class SessionImageCache {
  SessionImageCache({this.maxEntries = 12, this.maxBytes = 32 * 1024 * 1024});

  static final SessionImageCache instance = SessionImageCache();

  final int maxEntries;
  final int maxBytes;
  final LinkedHashMap<String, CachedSessionImage> _entries =
      LinkedHashMap<String, CachedSessionImage>();

  static String keyOf(Api api, String sessionId, String relativePath) {
    final profile = api.profileId.isNotEmpty
        ? api.profileId
        : (api.hostIdentity.isNotEmpty ? api.hostIdentity : api.baseUrl);
    return '$profile\u0000$sessionId\u0000$relativePath';
  }

  CachedSessionImage? lookup(Api api, String sessionId, String relativePath) {
    final key = keyOf(api, sessionId, relativePath);
    final hit = _entries.remove(key);
    if (hit != null) {
      // 命中后放到最新位，实现简单 LRU。
      _entries[key] = hit;
    }
    return hit;
  }

  void put(
    Api api,
    String sessionId,
    String relativePath,
    CachedSessionImage entry,
  ) {
    final key = keyOf(api, sessionId, relativePath);
    _entries.remove(key);
    _entries[key] = entry;
    _trim();
  }

  void clear() => _entries.clear();

  int get length => _entries.length;

  void _trim() {
    var bytes = 0;
    for (final entry in _entries.values) {
      bytes += entry.bytes.length;
    }
    while (_entries.length > maxEntries ||
        (bytes > maxBytes && _entries.isNotEmpty)) {
      final removedKey = _entries.keys.first;
      final removed = _entries.remove(removedKey)!;
      bytes -= removed.bytes.length;
    }
  }
}
