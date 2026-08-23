// 热修 07 逻辑单测：草稿恢复决策（不覆盖新输入）+ 草稿签名（会话/模式/文本/图片任一变化换新 id）。
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_mobile_app/screens/chat_screen.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('draftAfterFailure（发送异常后的草稿恢复决策）', () {
    test('输入框仍为空 → 回填旧草稿', () {
      expect(draftAfterFailure('', '旧草稿'), '旧草稿');
      expect(draftAfterFailure('   ', '旧草稿'), '旧草稿');
    });

    test('发送期间用户已输入新内容 → 绝不覆盖', () {
      expect(draftAfterFailure('新输入', '旧草稿'), '新输入');
      expect(draftAfterFailure('  新输入  ', '旧草稿'), '  新输入  ');
    });
  });

  group('composerSignature（requestId 签名）', () {
    test('相同输入 → 相同签名（重试复用同一 requestId，幂等）', () {
      final a = composerSignature('s1', 'followup', '文本', ['/a.png']);
      final b = composerSignature('s1', 'followup', '文本', ['/a.png']);
      expect(a, b);
    });

    test('模式变化（排队→插队）→ 新签名（新 requestId，插队真正执行而非回放旧结果）', () {
      expect(
        composerSignature('s1', 'followup', '文本', ['/a.png']),
        isNot(composerSignature('s1', 'steer', '文本', ['/a.png'])),
      );
    });

    test('会话变化 → 新签名', () {
      expect(
        composerSignature('s1', 'followup', '文本', const []),
        isNot(composerSignature('s2', 'followup', '文本', const [])),
      );
    });

    test('文本或图片变化 → 新签名', () {
      expect(
        composerSignature('s1', 'followup', '文本A', const []),
        isNot(composerSignature('s1', 'followup', '文本B', const [])),
      );
      expect(
        composerSignature('s1', 'followup', '文本', ['/a.png']),
        isNot(composerSignature('s1', 'followup', '文本', ['/b.png'])),
      );
      expect(
        composerSignature('s1', 'followup', '文本', ['/a.png']),
        isNot(composerSignature('s1', 'followup', '文本', const [])),
      );
    });
  });
}
