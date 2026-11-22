// issue #157：会话图片字节缓存（SessionImageCache）单测。
//
// 覆盖：键 = profile/hostIdentity/baseUrl + sessionId + cwd 相对路径（不同会话/路径/
// 连接不串图）、LRU 命中提升与 maxEntries 淘汰、maxBytes 淘汰、clear、
// 以及「只缓存成功字节」的调用方约定（put 后 lookup 命中）。

import 'dart:typed_data';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/session_image_cache.dart';
import 'package:flutter_test/flutter_test.dart';

Api _api({
  String baseUrl = 'http://host.test',
  String profileId = '',
  String hostIdentity = '',
}) => Api()
  ..baseUrl = baseUrl
  ..profileId = profileId
  ..hostIdentity = hostIdentity;

CachedSessionImage _entry(int size, {String? etag, String? contentType}) =>
    CachedSessionImage(
      bytes: Uint8List(size),
      contentType: contentType ?? 'image/png',
      etag: etag,
      relativePath: 'pics/a.png',
    );

void main() {
  test('键：同一 profile/session/path 命中；不同 session 或 path 不串', () {
    final cache = SessionImageCache();
    final api = _api(profileId: 'p1');

    cache.put(api, 's1', 'pics/a.png', _entry(3, etag: '"e1"'));
    expect(cache.lookup(api, 's1', 'pics/a.png')?.bytes.length, 3);
    expect(cache.lookup(api, 's1', 'pics/a.png')?.etag, '"e1"');

    expect(cache.lookup(api, 's2', 'pics/a.png'), isNull, reason: '会话隔离');
    expect(cache.lookup(api, 's1', 'pics/b.png'), isNull, reason: '路径隔离');
    expect(cache.length, 1);
  });

  test('键：profile 缺失时用 hostIdentity，再退到 baseUrl（不同连接不串图）', () {
    final cache = SessionImageCache();
    final byHost = _api(hostIdentity: 'host-a');
    final byHostOther = _api(hostIdentity: 'host-b');
    cache.put(byHost, 's1', 'a.png', _entry(1));
    expect(cache.lookup(byHostOther, 's1', 'a.png'), isNull);
    expect(
      SessionImageCache.keyOf(byHost, 's1', 'a.png'),
      'host-a\u0000s1\u0000a.png',
    );

    final byBase = _api(baseUrl: 'http://x.test');
    expect(
      SessionImageCache.keyOf(byBase, 's1', 'a.png'),
      'http://x.test\u0000s1\u0000a.png',
    );
    // profileId 优先级最高（切换连接 profile 后旧缓存不误命中）
    final withProfile = _api(profileId: 'p9', hostIdentity: 'host-a');
    expect(
      SessionImageCache.keyOf(withProfile, 's1', 'a.png'),
      'p9\u0000s1\u0000a.png',
    );
  });

  test('LRU：命中提升为最近，超 maxEntries 淘汰最久未用', () {
    final cache = SessionImageCache(maxEntries: 2, maxBytes: 1 << 20);
    final api = _api(profileId: 'p1');
    cache.put(api, 's', 'a.png', _entry(1));
    cache.put(api, 's', 'b.png', _entry(1));

    // 命中 a → a 变成最近使用；再放 c 应淘汰 b。
    expect(cache.lookup(api, 's', 'a.png'), isNotNull);
    cache.put(api, 's', 'c.png', _entry(1));

    expect(cache.lookup(api, 's', 'a.png'), isNotNull);
    expect(cache.lookup(api, 's', 'b.png'), isNull, reason: 'b 最久未用被淘汰');
    expect(cache.lookup(api, 's', 'c.png'), isNotNull);
    expect(cache.length, 2);
  });

  test('LRU：重复 put 同一键不重复占位，并更新内容/ETag', () {
    final cache = SessionImageCache(maxEntries: 2);
    final api = _api(profileId: 'p1');
    cache.put(api, 's', 'a.png', _entry(1, etag: '"old"'));
    cache.put(api, 's', 'a.png', _entry(2, etag: '"new"'));
    expect(cache.length, 1);
    expect(cache.lookup(api, 's', 'a.png')?.bytes.length, 2);
    expect(cache.lookup(api, 's', 'a.png')?.etag, '"new"');
  });

  test('maxBytes：超字节上限时从最旧开始淘汰', () {
    final cache = SessionImageCache(maxEntries: 10, maxBytes: 10);
    final api = _api(profileId: 'p1');
    cache.put(api, 's', 'a.png', _entry(6));
    cache.put(api, 's', 'b.png', _entry(6)); // 6+6 > 10 → 淘汰 a

    expect(cache.lookup(api, 's', 'a.png'), isNull);
    expect(cache.lookup(api, 's', 'b.png'), isNotNull);

    // 单图自身就超过 maxBytes：插入后必须自我淘汰，缓存不无限增长。
    cache.put(api, 's', 'huge.png', _entry(11));
    expect(cache.lookup(api, 's', 'huge.png'), isNull);
    expect(cache.length, 0);
  });

  test('maxBytes：连续写入多张小图时总能收敛到上限内', () {
    final cache = SessionImageCache(maxEntries: 100, maxBytes: 20);
    final api = _api(profileId: 'p1');
    for (var i = 0; i < 20; i++) {
      cache.put(api, 's', 'p$i.png', _entry(3));
    }
    var total = 0;
    for (var i = 0; i < 20; i++) {
      final hit = cache.lookup(api, 's', 'p$i.png');
      if (hit != null) total += hit.bytes.length;
    }
    expect(total, lessThanOrEqualTo(20));
    expect(cache.length, lessThanOrEqualTo(6));
  });

  test('clear：清空所有键（连接切换/退出会话时使用）', () {
    final cache = SessionImageCache();
    final api = _api(profileId: 'p1');
    cache.put(api, 's', 'a.png', _entry(1));
    cache.put(api, 's', 'b.png', _entry(1));
    expect(cache.length, 2);
    cache.clear();
    expect(cache.length, 0);
    expect(cache.lookup(api, 's', 'a.png'), isNull);
  });

  test('缓存条目保留 contentType/relativePath（元信息条直接复用）', () {
    final cache = SessionImageCache();
    final api = _api(profileId: 'p1');
    cache.put(
      api,
      's',
      'pics/a.png',
      CachedSessionImage(
        bytes: Uint8List(2),
        contentType: 'image/webp',
        etag: '"x"',
        relativePath: 'pics/a.png',
      ),
    );
    final hit = cache.lookup(api, 's', 'pics/a.png')!;
    expect(hit.contentType, 'image/webp');
    expect(hit.relativePath, 'pics/a.png');
  });
}
