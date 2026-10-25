// 两端对齐判定的纯逻辑单测（version_alignment.dart）：
// 判据是版本号且只决定提示文案；比较只看语义版本 X.Y.Z；
// 电脑端没下发判定时（旧插件）本地要能自己算——那正是"插件旧于 App"能被检出的原因。
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_mobile_app/version_alignment.dart';

void main() {
  group('semanticVersion', () {
    test('剥离 build 与空白', () {
      expect(semanticVersion('3.2.0+44'), '3.2.0');
      expect(semanticVersion(' 3.2.0 '), '3.2.0');
      expect(semanticVersion('3.2.0'), '3.2.0');
    });

    test('不可解析返回空串', () {
      expect(semanticVersion('3.2'), '');
      expect(semanticVersion('v3.2.0'), '');
      expect(semanticVersion(''), '');
      expect(semanticVersion('abc'), '');
    });

    test('去掉前导零，保证比较一致', () {
      expect(semanticVersion('03.02.00'), '3.2.0');
    });
  });

  group('compareSemanticVersion', () {
    test('逐段比较', () {
      expect(compareSemanticVersion('3.2.0', '3.2.0'), 0);
      expect(compareSemanticVersion('3.2.0', '3.1.9'), 1);
      expect(compareSemanticVersion('3.1.9', '3.2.0'), -1);
      expect(compareSemanticVersion('3.2.0+44', '3.2.0+23'), 0, reason: 'build 不参与配对');
    });

    test('任一不可解析返回 null（不猜）', () {
      expect(compareSemanticVersion('3.2.0', 'bad'), isNull);
      expect(compareSemanticVersion('', ''), isNull);
    });
  });

  group('computeAlignment', () {
    test('电脑端下发的判定优先采用', () {
      final a = computeAlignment(
        pluginVersion: '3.2.0',
        appVersion: '3.2.0+44',
        server: {
          'state': 'plugin-outdated',
          'reason': 'plugin-older-than-app',
          'appVersion': '3.2.0+44',
          'pluginVersion': '3.1.5',
        },
      );
      expect(a.state, AlignmentState.pluginOutdated);
      expect(a.reason, 'plugin-older-than-app');
      expect(a.pluginVersion, '3.1.5');
    });

    test('旧插件没下发判定时本地自算：插件旧 → pluginOutdated', () {
      final a = computeAlignment(pluginVersion: '3.1.5', appVersion: '3.2.0+44');
      expect(a.state, AlignmentState.pluginOutdated);
      expect(a.reason, 'plugin-older-than-app');
    });

    test('本地自算：App 旧 → appOutdated', () {
      final a = computeAlignment(pluginVersion: '3.2.0', appVersion: '3.1.5+40');
      expect(a.state, AlignmentState.appOutdated);
      expect(a.reason, 'app-older-than-plugin');
    });

    test('语义版本一致 → ok（同一周期内 build 不同不误报）', () {
      for (final app in ['3.2.0', '3.2.0+1', '3.2.0+44']) {
        expect(computeAlignment(pluginVersion: '3.2.0', appVersion: app).state, AlignmentState.ok,
            reason: app);
      }
    });

    test('拿不到版本 → unknown（不猜）', () {
      expect(computeAlignment(pluginVersion: '', appVersion: '3.2.0').state, AlignmentState.unknown);
      expect(computeAlignment(pluginVersion: '3.2.0', appVersion: '').state, AlignmentState.unknown);
      expect(computeAlignment(pluginVersion: '3.2.0', appVersion: 'bad').state, AlignmentState.unknown);
    });
  });

  group('prerelease（插件 3.2.1-alpha.1 / App 3.2.1+24）', () {
    test('插件 prerelease 与 App build 版本按 core 3.2.1 判 aligned', () {
      final a = computeAlignment(pluginVersion: '3.2.1-alpha.1', appVersion: '3.2.1+24');
      expect(a.state, AlignmentState.ok);
      expect(a.reason, 'aligned');
      expect(a.pluginVersion, '3.2.1-alpha.1', reason: '插件版本串原样保留，不因比较而改写');
    });

    test('semanticVersion 剥离 prerelease 与 build', () {
      expect(semanticVersion('3.2.1-alpha.1'), '3.2.1');
      expect(semanticVersion('3.2.1-alpha.1+24'), '3.2.1');
      expect(semanticVersion('3.2.1+build.5'), '3.2.1');
      expect(semanticVersion('3.2.1-alpha'), '3.2.1');
    });

    test('compareSemanticVersion 只比 core：alpha 不参与两端配对', () {
      expect(compareSemanticVersion('3.2.1-alpha.1', '3.2.1+24'), 0);
      expect(compareSemanticVersion('3.2.1-alpha.2', '3.2.1-alpha.1'), 0);
      expect(compareSemanticVersion('3.2.2-alpha.1', '3.2.1+24'), 1);
      expect(compareSemanticVersion('3.2.0-alpha.1', '3.2.1+24'), -1);
    });

    test('core 不同仍能判出该动哪一端（不回退成 unknown）', () {
      expect(
        computeAlignment(pluginVersion: '3.2.2-alpha.1', appVersion: '3.2.1+24').state,
        AlignmentState.appOutdated,
      );
      expect(
        computeAlignment(pluginVersion: '3.2.0-alpha.1', appVersion: '3.2.1+24').state,
        AlignmentState.pluginOutdated,
      );
    });
  });

  group('AppAlignment', () {
    test('needsAttention 只在对齐时为假', () {
      expect(const AppAlignment.unknown().needsAttention, isTrue);
      expect(
        computeAlignment(pluginVersion: '3.2.0', appVersion: '3.2.0+9').needsAttention,
        isFalse,
      );
    });

    test('signature 随状态或版本变化（用于"已忽略"的记忆）', () {
      final a = computeAlignment(pluginVersion: '3.2.0', appVersion: '3.1.5');
      final b = computeAlignment(pluginVersion: '3.2.0', appVersion: '3.1.6');
      expect(a.signature, isNot(b.signature));
      expect(a.signature, a.signature);
    });

    test('线上取值映射：无法识别一律归到 unknown', () {
      expect(AppAlignment.stateFromWire('ok'), AlignmentState.ok);
      expect(AppAlignment.stateFromWire('app-outdated'), AlignmentState.appOutdated);
      expect(AppAlignment.stateFromWire('plugin-outdated'), AlignmentState.pluginOutdated);
      expect(AppAlignment.stateFromWire('whatever'), AlignmentState.unknown);
      expect(AppAlignment.stateFromWire(null), AlignmentState.unknown);
    });

    test('缺字段的服务器响应按未知处理', () {
      final a = AppAlignment.fromServerJson({'reason': 'x'});
      expect(a.state, AlignmentState.unknown);
      expect(a.appVersion, '');
      expect(a.pluginVersion, '');
    });
  });
}
