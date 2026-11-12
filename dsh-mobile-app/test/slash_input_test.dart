import 'package:dsh_mobile_app/slash_input.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('slashTokenAt 触发边界', () {
    test('开头 / 触发，scope=leading', () {
      final t = slashTokenAt('/');
      expect(t, isNotNull);
      expect(t!.query, '');
      expect(t.start, 0);
      expect(t.scope, SlashMenuScope.leading);
    });

    test('空白/标点后触发；词内不触发', () {
      expect(slashTokenAt('hello /gr')!.query, 'gr');
      expect(slashTokenAt('hello /gr')!.scope, SlashMenuScope.inline);
      expect(slashTokenAt('（/gr')!.query, 'gr');
      expect(slashTokenAt('x/name'), isNull);
      expect(slashTokenAt('_/name'), isNull);
      expect(slashTokenAt('1/name'), isNull);
    });

    test('// 与 https:/ 豁免', () {
      expect(slashTokenAt('//'), isNull);
      expect(slashTokenAt('https:/'), isNull);
      expect(slashTokenAt('see https:/exa'), isNull);
      expect(slashTokenAt('http:/x'), isNull);
    });

    test('行内 /tmp 仍识别为行内 token（是否高亮由目录决定）', () {
      final t = slashTokenAt('请打开 /tmp');
      expect(t, isNotNull);
      expect(t!.query, 'tmp');
      expect(t.scope, SlashMenuScope.inline);
    });

    test('光标在 token 中间：query 截至光标；删除 / 后关闭', () {
      final t = slashTokenAt('/grill-me rest', 6);
      expect(t!.query, 'grill');
      expect(slashTokenAt('grill-me'), isNull);
      expect(slashTokenAt(''), isNull);
    });

    test('cursor 越界安全 clamp', () {
      expect(slashTokenAt('/x', 999)!.query, 'x');
      expect(slashTokenAt('/x', -1), isNull);
    });
  });

  group('slashTextTokens 高亮 token', () {
    test('开头/空白后的 /name；忽略词内与 URL', () {
      final tokens = slashTextTokens(
        '/compact 然后 /grill-me 和 x/name、https:/foo、//bar /tmp/foo',
      );
      expect(tokens.map((t) => t.name).toList(), ['compact', 'grill-me']);
      expect(tokens.first.scope, SlashMenuScope.leading);
      expect(tokens[1].scope, SlashMenuScope.inline);
    });

    test('token 后必须空白/结束：/tmp/foo 不算 /tmp', () {
      expect(slashTextTokens('/tmp/foo').where((t) => t.name == 'tmp'), isEmpty);
    });

    test('标点边界与中文标点', () {
      final tokens = slashTextTokens('（/compact），/grill-me\n/plan');
      expect(tokens.map((t) => t.name).toList(), ['compact', 'grill-me', 'plan']);
    });

    test('空文本/无 token', () {
      expect(slashTextTokens(''), isEmpty);
      expect(slashTextTokens('普通消息'), isEmpty);
    });
  });

  group('slashItemMatches', () {
    test('名称/描述大小写不敏感子串；空 query 全匹配', () {
      expect(slashItemMatches('', 'compact', 'x'), isTrue);
      expect(slashItemMatches('COM', 'compact', 'x'), isTrue);
      expect(slashItemMatches('历史', 'compact', '压缩历史'), isTrue);
      expect(slashItemMatches('zzz', 'compact', 'x'), isFalse);
    });
  });
}
