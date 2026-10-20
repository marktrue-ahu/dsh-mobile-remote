// 更新决策纯逻辑单测（update_core.dart）——覆盖 spec「版本比较/防降级/manifest 与 release 解析」。
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_mobile_app/update_core.dart';

void main() {
  group('parseAppVersion', () {
    test('标准版本', () {
      final v = parseAppVersion('3.0.0');
      expect(v, isNotNull);
      expect(v!.major, 3);
      expect(v.minor, 0);
      expect(v.patch, 0);
      expect(v.build, 0);
    });

    test('v 前缀 + build 后缀', () {
      final v = parseAppVersion('v3.0.0+8');
      expect(v!.toString(), '3.0.0+8');
    });

    test('仅 build 后缀', () {
      expect(parseAppVersion('3.1.2+7')!.build, 7);
    });

    test('显式 +0 仍保留 build 语义', () {
      final v = parseAppVersion('3.1.2+0')!;
      expect(v.build, 0);
      expect(v.buildSet, isTrue);
      expect(v.toString(), '3.1.2+0');
    });

    test('非法输入返回 null', () {
      expect(parseAppVersion(''), isNull);
      expect(parseAppVersion('abc'), isNull);
      expect(parseAppVersion('3.0'), isNull);
      expect(parseAppVersion('3.0.0.1'), isNull);
      expect(parseAppVersion('3.-1.0'), isNull);
      expect(parseAppVersion('3.0.0+'), isNull);
    });
  });

  group('verdictFor 版本判定', () {
    test('同版本不提示（本地 3.0.0+7 vs release v3.0.0 无 build）', () {
      final local = parseAppVersion('3.0.0+7')!;
      final remote = parseAppVersion('v3.0.0')!;
      expect(verdictFor(local: local, remote: remote), UpdateVerdict.upToDate);
    });

    test('同版本 build 更大 → 更新', () {
      final local = parseAppVersion('3.0.0+7')!;
      final remote = parseAppVersion('3.0.0+8')!;
      expect(verdictFor(local: local, remote: remote), UpdateVerdict.updateAvailable);
    });

    test('小版本升级 → 更新', () {
      final local = parseAppVersion('3.0.0+999')!;
      final remote = parseAppVersion('3.1.0')!;
      expect(verdictFor(local: local, remote: remote), UpdateVerdict.updateAvailable);
    });

    test('远端低于本地 → 异常（防降级）', () {
      final local = parseAppVersion('3.1.0')!;
      final remote = parseAppVersion('3.0.0+1')!;
      expect(verdictFor(local: local, remote: remote), UpdateVerdict.remoteOlder);
    });
  });

  group('ReleasePointer / ReleaseHealth（§5.3 三角色与健康确认）', () {
    const hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    Map<String, dynamic> releaseJson({String appUrl = 'https://desktop.example/m/api/update/apk?release=r1'}) => {
          'schema': 1,
          'manifestUrl': 'https://desktop.example/m/api/update/manifest',
          'app': {'version': '3.3.0+55', 'file': 'a.apk', 'size': 4, 'sha256': hash, 'url': appUrl},
          'plugin': {'version': '3.3.0', 'file': 'p.tgz', 'size': 8, 'sha256': hash, 'contentSha256': hash,
            'url': 'https://desktop.example/m/api/update/plugin?release=r1'},
        };

    test('releaseId + 完整快照往返；缺 releaseId 或快照不合法 → null', () {
      final p = ReleasePointer.fromJson({'releaseId': 'r1', 'release': releaseJson()});
      expect(p, isNotNull);
      expect(p!.releaseId, 'r1');
      expect(ReleasePointer.fromJson(p.toJson())!.releaseId, 'r1');
      expect(ReleasePointer.fromJson({'releaseId': '', 'release': releaseJson()}), isNull);
      expect(ReleasePointer.fromJson({'release': releaseJson()}), isNull);
      expect(ReleasePointer.fromJson({'releaseId': 'r1', 'release': {'schema': 1}}), isNull);
      expect(ReleasePointer.fromJson(null), isNull);
    });

    test('当前发布健康：state/runningContentSha256/实例/事务代际解析', () {
      final h = ReleaseHealth.fromJson({
        'state': 'confirmed',
        'runningContentSha256': hash.toUpperCase(),
        'instanceId': 'inst-1',
        'transaction': {'opId': 'op-1', 'generation': 7},
      })!;
      expect(h.confirmed, isTrue);
      expect(h.runningContentSha256, hash, reason: '统一小写');
      expect(h.instanceId, 'inst-1');
      expect(h.transactionOpId, 'op-1');
      expect(h.transactionGeneration, 7);
      expect(ReleaseHealth.fromJson({'state': 'waiting'})!.waiting, isTrue);
      expect(ReleaseHealth.fromJson({'state': 'failed'})!.failed, isTrue);
      expect(ReleaseHealth.fromJson(null), isNull);
      expect(ReleaseHealth.fromJson({}), isNull);
    });

    test('appArtifact 三态诊断解析', () {
      expect(AppArtifactDiagnostic.fromJson({'state': 'ok'})!.ok, isTrue);
      final missing = AppArtifactDiagnostic.fromJson({'state': 'missing', 'reason': 'app-artifact-not-ready'})!;
      expect(missing.missing, isTrue);
      expect(missing.reason, 'app-artifact-not-ready');
      expect(AppArtifactDiagnostic.fromJson({'state': 'mismatch'})!.mismatch, isTrue);
      expect(AppArtifactDiagnostic.fromJson({'state': ''}), isNull);
      expect(AppArtifactDiagnostic.fromJson(null), isNull);
    });

    test('来源接线守卫：外部 GitHub 资产地址不再可用，宿主固定地址通过', () {
      final hostFixed = ReleaseSnapshot.fromJson(releaseJson())!;
      expect(fixedArtifactUrlIssue(hostFixed), isNull);
      expect(
        fixedArtifactUrlIssue(ReleaseSnapshot.fromJson(releaseJson(
          appUrl: 'https://github.com/201222-L/dsh-mobile-remote/releases/download/v3.3.0/DSH-Remote-v3.3.0.apk',
        ))!),
        contains('固定目标'),
      );
      expect(
        fixedArtifactUrlIssue(ReleaseSnapshot.fromJson(releaseJson(
          appUrl: 'https://objects.githubusercontent.com/abc/app.apk',
        ))!),
        contains('固定目标'),
      );
      expect(
        fixedArtifactUrlIssue(ReleaseSnapshot.fromJson(releaseJson(
          appUrl: 'http://192.168.1.5:3080/m/api/update/apk',
        ))!),
        isNull,
        reason: '局域网宿主固定地址是合法来源',
      );
    });
  });

  group('candidateFromHostManifest', () {
    test('字段全映射 + baseUrl 去尾斜杠', () {
      final c = candidateFromHostManifest(
        {
          'version': '3.0.0+8',
          'apk': 'DSH-Remote-v3.0.0.apk',
          'sha256': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'notes': '修复若干问题',
        },
        baseUrl: 'http://192.168.1.10:3080/m/',
      );
      expect(c!.version, '3.0.0+8');
      expect(c.downloadUrl, 'http://192.168.1.10:3080/m/api/update/apk');
      expect(c.sha256, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(c.notes, '修复若干问题');
      expect(c.source, '主机');
    });

    test('缺少 sha256 → null（主机源必须完整性校验）', () {
      expect(
        candidateFromHostManifest({'version': '3.0.0', 'apk': 'a.apk'}, baseUrl: 'http://h/m'),
        isNull,
      );
    });

    test('size 字段映射（确认弹窗显示真实大小）', () {
      final c = candidateFromHostManifest(
        {'version': '3.1.0+8', 'apk': 'a.apk', 'size': 75497472, 'sha256': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'},
        baseUrl: 'http://h/m',
      );
      expect(c!.sizeBytes, 75497472);
    });

    test('非法版本 → null', () {
      expect(
        candidateFromHostManifest({'version': 'x', 'apk': 'a.apk'}, baseUrl: 'http://h/m'),
        isNull,
      );
    });
  });

  group('hostApiBase（检查与下载同 base，挂载路径不硬编码 /m）', () {
    test('默认挂载路径', () {
      expect(hostApiBase(baseUrl: 'http://192.168.1.10:3080', mountPath: '/m'),
          'http://192.168.1.10:3080/m');
    });

    test('自定义挂载路径（bootstrap 权威校正后）', () {
      expect(hostApiBase(baseUrl: 'http://192.168.1.10:3080', mountPath: '/dsh-remote'),
          'http://192.168.1.10:3080/dsh-remote');
    });

    test('空路径回退 /m、baseUrl 去尾斜杠', () {
      expect(hostApiBase(baseUrl: 'http://h:3080/', mountPath: ''), 'http://h:3080/m');
      expect(hostApiBase(baseUrl: 'http://h:3080/', mountPath: '/'), 'http://h:3080/m');
    });
  });
}