// issue #117：文件内容预览「自动换行」开关。
//
// 覆盖：默认开启、关闭后长行横滚 + 行号固定、重新开启保持顶部行、复制不变、
// Markdown 渲染/diff/二进制隐藏、320/深色/1.5× 工具栏折叠，以及轮末预览、
// 会话文件预览两个 content 入口（Git 浏览器当前只有 diff，做负例回归）。
import 'dart:convert';
import 'dart:ui' show Tristate;

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/l10n.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/screens/session_files_screen.dart';
import 'package:dsh_mobile_app/screens/turn_file_preview_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:dsh_mobile_app/turn_tail.dart';
import 'package:dsh_mobile_app/widgets/git_file_viewer.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _viewerKeys = GitFileViewerKeys();
const _turnKeys = GitFileViewerKeys(prefix: 'turn-file-preview');
const _sfKeys = GitFileViewerKeys(prefix: 'sf-preview', modePrefix: 'sf');
const _gitKeys = GitFileViewerKeys(prefix: 'git');

/// 800px 测试面下必然横向溢出的长行（monospace 12 × 1200 字符）。
final _longLine = 'x' * 1200;

/// 每行都长到折行：40 行 × 300 字符，顶部行锚点测试用。
String _wrappedManyLines({int count = 40}) {
  final buffer = StringBuffer();
  for (var i = 0; i < count; i++) {
    buffer.writeln('line $i ${'y' * 300}');
  }
  return buffer.toString().trimRight();
}

Future<void> _pump(
  WidgetTester tester,
  Widget viewer, {
  ThemeData? theme,
  TextScaler? textScaler,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: theme,
      builder: textScaler == null
          ? null
          : (context, child) => MediaQuery(
              data: MediaQuery.of(context).copyWith(textScaler: textScaler),
              child: child!,
            ),
      home: Scaffold(body: viewer),
    ),
  );
  await tester.pumpAndSettle();
}

IconButton _wrapButton(
  WidgetTester tester, [
  GitFileViewerKeys keys = _viewerKeys,
]) => tester.widget<IconButton>(
  find.descendant(
    of: find.byKey(keys.wrapToggle),
    matching: find.byType(IconButton),
  ),
);

Text _lineText(
  WidgetTester tester,
  int index, [
  GitFileViewerKeys keys = _viewerKeys,
]) => tester.widget<Text>(find.byKey(keys.sourceLineText(index)));

double _left(WidgetTester tester, Key key) =>
    tester.getTopLeft(find.byKey(key)).dx;

/// 列表中第一个可见行（按行正文的实际全局矩形判断，忽略 ListView 预构建的缓存行）。
int _firstVisibleLine(
  WidgetTester tester,
  int lineCount, {
  GitFileViewerKeys keys = _viewerKeys,
}) {
  final listTop = tester.getTopLeft(find.byKey(keys.sourceList)).dy;
  for (var i = 0; i < lineCount; i++) {
    final finder = find.byKey(keys.sourceLineText(i));
    if (finder.evaluate().isEmpty) continue;
    if (tester.getRect(finder).bottom > listTop) return i;
  }
  return -1;
}

void main() {
  setUp(() {
    L10n.lang = 'en';
    SharedPreferences.setMockInitialValues({});
  });
  tearDown(() => L10n.lang = 'zh');

  testWidgets('content mode shows an enabled wrap toggle by default', (
    tester,
  ) async {
    await _pump(
      tester,
      const GitFileViewer(
        mode: GitFileViewerMode.content,
        path: 'a.txt',
        content: 'line one\nline two',
      ),
    );

    final button = _wrapButton(tester);
    expect(button.isSelected, isTrue);
    expect(button.tooltip, 'Wrap lines (on)');
    expect(find.byTooltip('Wrap lines (on)'), findsOneWidget);
    // 命中区 ≥44×44；图标 20。
    final size = tester.getSize(find.byKey(_viewerKeys.wrapToggle));
    expect(size.width, greaterThanOrEqualTo(44));
    expect(size.height, greaterThanOrEqualTo(44));
    expect((button.icon as Icon).icon, Icons.wrap_text);
    expect(tester.getSize(find.byIcon(Icons.wrap_text)), const Size(20, 20));
    // 默认仍折行（没有显式关掉 softWrap）。
    expect(_lineText(tester, 0).softWrap, isNot(false));

    // 读屏语义：toggled 状态随开关变化。
    final semantics = tester.ensureSemantics();
    expect(
      tester
          .getSemantics(find.byKey(_viewerKeys.wrapToggle))
          .flagsCollection
          .isToggled,
      Tristate.isTrue,
    );
    await tester.tap(find.byKey(_viewerKeys.wrapToggle));
    await tester.pumpAndSettle();
    expect(
      tester
          .getSemantics(find.byKey(_viewerKeys.wrapToggle))
          .flagsCollection
          .isToggled,
      Tristate.isFalse,
    );
    semantics.dispose();
  });

  testWidgets('wrap off: long line does not wrap, body scrolls, gutter fixed', (
    tester,
  ) async {
    await _pump(
      tester,
      GitFileViewer(
        mode: GitFileViewerMode.content,
        path: 'long.txt',
        content: 'L0 $_longLine\nL1 short',
      ),
    );

    final gutterLeft = _left(tester, _viewerKeys.sourceLineNumber(0));
    final textLeft = _left(tester, _viewerKeys.sourceLineText(0));

    await tester.tap(find.byKey(_viewerKeys.wrapToggle));
    await tester.pumpAndSettle();

    expect(_wrapButton(tester).isSelected, isFalse);
    expect(_wrapButton(tester).tooltip, 'Wrap lines (off)');
    expect(_lineText(tester, 0).softWrap, isFalse);
    // 关闭换行不产生布局溢出。
    expect(tester.takeException(), isNull);
    // 行号列宽度在切换前后不变。
    expect(_left(tester, _viewerKeys.sourceLineNumber(0)), gutterLeft);

    await tester.drag(
      find.byKey(_viewerKeys.sourceScrollSurface),
      const Offset(-260, 0),
    );
    await tester.pumpAndSettle();

    // 正文整体平移，行号列钉住。
    expect(_left(tester, _viewerKeys.sourceLineNumber(0)), gutterLeft);
    expect(
      _left(tester, _viewerKeys.sourceLineText(0)),
      lessThan(textLeft - 60),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('wrap on again: folds, resets offset, keeps top line and copy', (
    tester,
  ) async {
    final calls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        calls.add(call);
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    final content = _wrappedManyLines();
    await _pump(
      tester,
      GitFileViewer(
        mode: GitFileViewerMode.content,
        path: 'many.txt',
        content: content,
      ),
    );

    // 先滚到文件中段，记录顶部行。
    await tester.drag(
      find.byKey(_viewerKeys.sourceList),
      const Offset(0, -600),
    );
    await tester.pumpAndSettle();
    final anchor = _firstVisibleLine(tester, 40);
    expect(anchor, greaterThan(2));
    final onLeft = _left(tester, _viewerKeys.sourceLineText(anchor));

    // 关闭换行：顶部行保持（±1），行宽变大后不再折行。
    await tester.tap(find.byKey(_viewerKeys.wrapToggle));
    await tester.pumpAndSettle();
    expect(
      _firstVisibleLine(tester, 40),
      inInclusiveRange(anchor - 1, anchor + 1),
    );
    expect(_lineText(tester, anchor).softWrap, isFalse);

    // 关闭态先横拖出偏移；重新开启后必须归零、恢复折行、顶部行保持（±1）。
    await tester.drag(
      find.byKey(_viewerKeys.sourceScrollSurface),
      const Offset(-220, 0),
    );
    await tester.pumpAndSettle();
    expect(
      _left(tester, _viewerKeys.sourceLineText(anchor)),
      lessThan(onLeft - 60),
    );
    await tester.tap(find.byKey(_viewerKeys.wrapToggle));
    await tester.pumpAndSettle();
    expect(_wrapButton(tester).isSelected, isTrue);
    expect(_lineText(tester, anchor).softWrap, isNot(false));
    expect(
      _firstVisibleLine(tester, 40),
      inInclusiveRange(anchor - 1, anchor + 1),
    );
    expect(
      _left(tester, _viewerKeys.sourceLineText(anchor)),
      moreOrLessEquals(onLeft, epsilon: 0.01),
      reason: '重新开启换行必须把横向偏移归零',
    );
    expect(tester.takeException(), isNull);

    // 复制始终是原始文本，与换行状态无关。
    await tester.tap(find.byKey(_viewerKeys.copy));
    await tester.pumpAndSettle();
    final clipboard = calls.where((call) => call.method == 'Clipboard.setData');
    expect(clipboard, hasLength(1));
    expect((clipboard.single.arguments as Map)['text'], content);
  });

  testWidgets('markdown rendered, diff and binary hide the wrap toggle', (
    tester,
  ) async {
    // Markdown 默认渲染态：不显示；切到源码后显示。
    await _pump(
      tester,
      const GitFileViewer(
        mode: GitFileViewerMode.content,
        path: 'README.md',
        content: '# Title\n\nbody',
      ),
    );
    expect(find.byKey(_viewerKeys.wrapToggle), findsNothing);
    await tester.tap(find.byKey(_viewerKeys.modeButton(rendered: false)));
    await tester.pumpAndSettle();
    expect(find.byKey(_viewerKeys.wrapToggle), findsOneWidget);

    // diff：不显示（diff 行为保持不变）。
    await _pump(
      tester,
      const GitFileViewer(
        mode: GitFileViewerMode.diff,
        path: 'a.txt',
        diff: 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-old\n+new\n',
      ),
    );
    expect(find.byKey(_viewerKeys.wrapToggle), findsNothing);

    // 二进制/不可预览：不显示。
    await _pump(
      tester,
      const GitFileViewer(
        mode: GitFileViewerMode.content,
        path: 'photo.png',
        binary: true,
      ),
    );
    expect(find.byKey(_viewerKeys.wrapToggle), findsNothing);
  });

  testWidgets('opening another file restores default wrap on', (tester) async {
    await _pump(
      tester,
      const GitFileViewer(
        mode: GitFileViewerMode.content,
        path: 'a.txt',
        content: 'line one\nline two',
      ),
    );
    await tester.tap(find.byKey(_viewerKeys.wrapToggle));
    await tester.pumpAndSettle();
    expect(_wrapButton(tester).isSelected, isFalse);

    await _pump(
      tester,
      const GitFileViewer(
        mode: GitFileViewerMode.content,
        path: 'b.txt',
        content: 'other file',
      ),
    );
    // 新文件恢复默认开启，不跨文件记忆。
    expect(_wrapButton(tester).isSelected, isTrue);
    expect(find.text('other file'), findsOneWidget);
  });

  testWidgets('rapid double toggle settles without jumping or exceptions', (
    tester,
  ) async {
    await _pump(
      tester,
      GitFileViewer(
        mode: GitFileViewerMode.content,
        path: 'many.txt',
        content: _wrappedManyLines(),
      ),
    );
    await tester.drag(
      find.byKey(_viewerKeys.sourceList),
      const Offset(0, -600),
    );
    await tester.pumpAndSettle();
    final anchor = _firstVisibleLine(tester, 40);

    // 同一帧内连点两次：两次切换都记录下来，但只允许最后一次帧末恢复。
    await tester.tap(find.byKey(_viewerKeys.wrapToggle));
    await tester.tap(find.byKey(_viewerKeys.wrapToggle));
    await tester.pumpAndSettle();

    expect(_wrapButton(tester).isSelected, isTrue);
    expect(
      _firstVisibleLine(tester, 40),
      inInclusiveRange(anchor - 1, anchor + 1),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('truncation notice survives wrap toggling', (tester) async {
    await _pump(
      tester,
      GitFileViewer(
        mode: GitFileViewerMode.content,
        path: 'big.txt',
        content: 'prefix $_longLine',
        truncated: true,
        truncatedMessage: 'File is large: showing first 10 KiB',
      ),
    );
    expect(find.byKey(_viewerKeys.truncated), findsOneWidget);
    await tester.tap(find.byKey(_viewerKeys.wrapToggle));
    await tester.pumpAndSettle();
    expect(find.byKey(_viewerKeys.truncated), findsOneWidget);
    expect(find.text('File is large: showing first 10 KiB'), findsOneWidget);
    expect(_wrapButton(tester).isSelected, isFalse);
  });

  testWidgets('empty file keeps the toggle usable and stable', (tester) async {
    await _pump(
      tester,
      const GitFileViewer(
        mode: GitFileViewerMode.content,
        path: 'empty.txt',
        content: '',
      ),
    );
    expect(find.byKey(_viewerKeys.wrapToggle), findsOneWidget);
    await tester.tap(find.byKey(_viewerKeys.wrapToggle));
    await tester.pumpAndSettle();
    expect(_wrapButton(tester).isSelected, isFalse);
    expect(tester.takeException(), isNull);
    await tester.tap(find.byKey(_viewerKeys.wrapToggle));
    await tester.pumpAndSettle();
    expect(_wrapButton(tester).isSelected, isTrue);
  });

  testWidgets('320 / dark / 1.5x toolbar folds without overflow', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    var historyTaps = 0;

    await _pump(
      tester,
      GitFileViewer(
        mode: GitFileViewerMode.content,
        path: 'README.md',
        content: '# Title\n\n${'z' * 300}',
        encodingLabel: 'UTF-8',
        leading: IconButton(
          key: const Key('viewer-back'),
          tooltip: 'Back',
          onPressed: () {},
          icon: const Icon(Icons.arrow_back),
        ),
        topActions: [
          IconButton(
            key: const Key('viewer-history'),
            tooltip: 'Commit history',
            onPressed: () => historyTaps++,
            icon: const Icon(Icons.history),
          ),
        ],
        keys: _gitKeys,
      ),
      theme: DshTheme.dark(),
      textScaler: const TextScaler.linear(1.5),
    );

    expect(tester.takeException(), isNull);
    // 编码隐藏；Markdown 预览/源码改为图标按钮；topActions 收进 ⋮。
    expect(find.text('UTF-8'), findsNothing);
    expect(find.byKey(_gitKeys.modeButton(rendered: true)), findsOneWidget);
    expect(find.byKey(_gitKeys.modeButton(rendered: false)), findsOneWidget);
    expect(find.text('Preview'), findsNothing);
    expect(find.byKey(const Key('viewer-history')), findsNothing);
    expect(find.byKey(_gitKeys.overflowActions), findsOneWidget);

    // 渲染态不显示换行按钮；切到源码后出现且 44 命中。
    expect(find.byKey(_gitKeys.wrapToggle), findsNothing);
    await tester.tap(find.byKey(_gitKeys.modeButton(rendered: false)));
    await tester.pumpAndSettle();
    expect(find.byKey(_gitKeys.wrapToggle), findsOneWidget);
    final size = tester.getSize(find.byKey(_gitKeys.wrapToggle));
    expect(size.width, greaterThanOrEqualTo(44));
    expect(size.height, greaterThanOrEqualTo(44));

    // 窄屏关闭换行：正文横滚而不是整页/工具栏溢出。
    await tester.tap(find.byKey(_gitKeys.wrapToggle));
    await tester.pumpAndSettle();
    expect(_wrapButton(tester, _gitKeys).isSelected, isFalse);
    expect(find.byKey(_gitKeys.sourceScrollSurface), findsOneWidget);
    expect(tester.takeException(), isNull);

    // 折叠菜单保留原动作。
    await tester.tap(find.byKey(_gitKeys.overflowActions));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('viewer-history')), findsOneWidget);
    await tester.tap(find.byKey(const Key('viewer-history')));
    await tester.pumpAndSettle();
    expect(historyTaps, 1);
  });

  testWidgets('1.5x keeps a 5-digit gutter readable and equal in both states', (
    tester,
  ) async {
    final content = List<String>.generate(10000, (i) => 'l$i').join('\n');
    await _pump(
      tester,
      GitFileViewer(
        mode: GitFileViewerMode.content,
        path: 'big.txt',
        content: content,
      ),
      textScaler: const TextScaler.linear(1.5),
    );
    final onWidth = tester
        .getSize(find.byKey(_viewerKeys.sourceLineNumber(0)))
        .width;
    expect(onWidth, 64, reason: '1.5× 下 5 位行号按测量增长，封顶 64');

    await tester.tap(find.byKey(_viewerKeys.wrapToggle));
    await tester.pumpAndSettle();
    final offWidth = tester
        .getSize(find.byKey(_viewerKeys.sourceLineNumber(0)))
        .width;
    expect(offWidth, onWidth, reason: '换行开/关行号列宽度必须相同');
    expect(tester.takeException(), isNull);
  });

  testWidgets('turn-end file preview gets the toggle and does not re-request', (
    tester,
  ) async {
    var calls = 0;
    final api =
        Api(
            client: MockClient((request) async {
              calls++;
              return http.Response.bytes(
                utf8.encode('const a = 1;\nconst b = $_longLine\n'),
                200,
                headers: {'content-type': 'text/plain'},
              );
            }),
          )
          ..baseUrl = 'http://preview.test'
          ..path = '/m'
          ..token = '';

    await tester.pumpWidget(
      MaterialApp(
        home: TurnFilePreviewScreen(
          api: api,
          coordinate: const TurnFileCoordinate(
            sessionId: 's1',
            kind: TurnFileKind.presented,
            seq: 3,
            index: 0,
          ),
          display: 'src/a.txt',
          name: 'a.txt',
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(calls, 1);
    expect(find.byKey(const Key('turn-file-preview')), findsOneWidget);
    expect(find.byKey(_turnKeys.wrapToggle), findsOneWidget);
    expect(_wrapButton(tester, _turnKeys).isSelected, isTrue);

    await tester.tap(find.byKey(_turnKeys.wrapToggle));
    await tester.pumpAndSettle();
    expect(_wrapButton(tester, _turnKeys).isSelected, isFalse);
    expect(calls, 1, reason: '切换自动换行不得重新请求内容');
    expect(_lineText(tester, 1, _turnKeys).softWrap, isFalse);
    expect(tester.takeException(), isNull);
  });

  testWidgets('session files preview gets the toggle and does not re-request', (
    tester,
  ) async {
    var fileCalls = 0;
    final api =
        Api(
            client: MockClient((request) async {
              if (request.url.path == '/m/api/directories') {
                return http.Response(
                  jsonEncode({
                    'ok': true,
                    'path': '/work',
                    'dirs': <String>[],
                    'files': ['main.dart'],
                  }),
                  200,
                );
              }
              if (request.url.path == '/m/api/files') {
                fileCalls++;
                return http.Response.bytes(
                  utf8.encode('void main() {\n  final s = $_longLine\n}\n'),
                  200,
                );
              }
              return http.Response('unexpected ${request.url}', 500);
            }),
          )
          ..baseUrl = 'http://sf.test'
          ..path = '/m'
          ..token = '';
    final store = AppStore()
      ..sessions = [Session(id: 's1', title: 'S', cwd: '/work', createdAt: 1)];

    await tester.pumpWidget(
      MaterialApp(
        home: SessionFilesScreen(store: store, sessionId: 's1', apiClient: api),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('main.dart'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('sf-preview')), findsOneWidget);
    expect(find.byKey(_sfKeys.wrapToggle), findsOneWidget);
    expect(_wrapButton(tester, _sfKeys).isSelected, isTrue);
    final callsBefore = fileCalls;

    await tester.tap(find.byKey(_sfKeys.wrapToggle));
    await tester.pumpAndSettle();
    expect(_wrapButton(tester, _sfKeys).isSelected, isFalse);
    expect(fileCalls, callsBefore, reason: '切换自动换行不得重新请求内容');
    expect(_lineText(tester, 1, _sfKeys).softWrap, isFalse);
    expect(tester.takeException(), isNull);
  });
}
