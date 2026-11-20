// 统一的 Git 文件/差异查看器（issue #42）。
//
// 背景：文件内容浏览（/api/files）与 git diff 预览（/api/git/preview）原本是
// 两套独立组件、两套交互；本组件把「行号源码 / Markdown 预览切换 / diff 折叠 /
// 横向滚动 / 复制」收敛到一处，两个入口只负责把各自的数据适配成
// [GitFileViewerMode.content] 或 [GitFileViewerMode.diff]。
//
// 行号在两种模式下都提供：content 模式是单侧行号；diff 模式按 hunk header 的
// 起始行解析出旧/新两侧行号（删除行只有旧侧、新增行只有新侧），与 US6
// 「文件内容与 diff 共享行号交互」一致。
//
// 上限沿用既有约定：内容 256 KiB（[kGitFileViewerContentLimit]，由取数侧按
// 前缀读取截断）、差异 512 KiB（[kGitFileViewerDiffLimit]，由宿主返回
// truncated 标记）；组件本身不重新拉取数据。
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart'
    show
        RenderBox,
        RenderObject,
        RenderSliverList,
        SliverMultiBoxAdaptorParentData;
import 'package:flutter/services.dart';

import '../l10n.dart';
import '../md.dart';
import '../session_files_logic.dart';
import '../theme.dart';
import '../toast.dart';

/// 文件内容模式的安全上限（字节）：与取数侧的 `kPreviewByteLimit` 同源，
/// 由调用方按该上限读取前缀并在 [GitFileViewer.truncated] 标记。
const int kGitFileViewerContentLimit = kPreviewByteLimit;

/// diff 模式的安全上限（字节）：宿主侧按该上限截断并返回 `truncated: true`，
/// App 不重新拼接或二次截断已加载的 diff。
const int kGitFileViewerDiffLimit = 512 * 1024;

/// diff 行号区宽度：旧号 34 + 间隔 4 + 新号 34 + 标记 20（issue #71 / Q14）。
///
/// 横滑时行号列固定不动，宽度维持原值——收窄就要合并旧/新为单列，会丢掉
/// 「删除行只有旧侧、新增行只有新侧」的既有契约。
const double _kDiffGutterWidth = 92;

/// 行号区与正文之间的 1px 分隔线（颜色取 [DshColors.line]，不硬编码）。
const double _kDiffGutterDividerWidth = 1;

/// diff 行左右内边距（原 `_diffLine` 的 `horizontal: 10`）。
const double _kDiffLinePadding = 10;

/// diff 行上下内边距。放在行号区/正文内部（而不是最外层 Container），
/// 让 1px 分隔线覆盖整行高度、与相邻行接成连续竖线（Q13）。
const double _kDiffLineVerticalPadding = 2;

/// diff 正文样式：宽度测量与实际渲染必须同源（颜色无关，渲染时再 copyWith）。
const TextStyle _kDiffTextStyle = TextStyle(
  fontFamily: 'monospace',
  fontSize: 12,
);

/// 内容模式源码正文样式（行号与正文共用字号；宽度/高度测量必须与渲染同源）。
const TextStyle _kSourceTextStyle = TextStyle(
  fontFamily: 'monospace',
  fontSize: 12,
);

/// 内容模式行号列与正文之间的间距（原 `SizedBox(width: 10)`）。
const double _kSourceGutterGap = 10;

/// 内容模式行号列宽度：1.0× 沿用 48；大字号按最大行号位数测量，上限 64。
const double _kSourceGutterMinWidth = 48;
const double _kSourceGutterMaxWidth = 64;

/// 内容模式列表上下内边距（原 `EdgeInsets.symmetric(vertical: 6)`）。
const double _kSourceListVerticalPadding = 6;

/// 工具栏图标按钮命中区（issue #117：自动换行等新按钮 ≥44×44）。
const double _kToolbarHitSize = 44;

enum GitFileViewerMode { content, diff }

/// 组件内部可测试的稳定 Key；不同入口用不同 [prefix] 保持既有测试键。
class GitFileViewerKeys {
  const GitFileViewerKeys({this.prefix = 'git-file-viewer', this.modePrefix});

  final String prefix;

  /// 「预览/源码」按钮的键前缀；默认同 [prefix]，适配既有页面测试键。
  final String? modePrefix;

  Key get surface => Key('$prefix-surface');
  Key get sourceList => Key('$prefix-source');
  Key get markdownList => Key('$prefix-md');
  Key get modeToggle => Key('$prefix-mode');
  Key modeButton({required bool rendered}) =>
      Key('${modePrefix ?? prefix}-mode-${rendered ? 'rendered' : 'source'}');
  Key get truncated => Key('$prefix-truncated');
  Key get unavailable => Key('$prefix-unavailable');
  Key get error => Key('$prefix-error');
  Key get retry => Key('$prefix-retry');
  Key get copy => Key('$prefix-copy');
  Key get empty => Key('$prefix-empty');

  /// 内容模式「自动换行」切换（issue #117）。
  Key get wrapToggle => Key('$prefix-wrap');

  /// 关闭换行时承载横向手势的正文表面（行号列固定）。
  Key get sourceScrollSurface => Key('$prefix-source-scroll');

  /// 内容模式第 [index] 行的正文/行号（用于换行开关的行位置与固定列断言）。
  Key sourceLineText(int index) => Key('$prefix-source-text-$index');
  Key sourceLineNumber(int index) => Key('$prefix-source-line-$index');

  /// 窄屏/大字号时 topActions 折叠后的「更多操作」菜单。
  Key get overflowActions => Key('$prefix-overflow-actions');

  /// diff 模式的行（含折叠后仍保持原始行号下标）与旧/新行号列。
  Key diffLine(int index) => Key('$prefix-diff-line-$index');
  Key diffLineOldNumber(int index) => Key('$prefix-old-$index');
  Key diffLineNewNumber(int index) => Key('$prefix-new-$index');

  /// 整块 diff 共用的横向滚动表面（横滑手势挂载点）。
  Key get diffScrollSurface => Key('$prefix-diff-scroll');

  /// diff 行的正文（行号列之外、随共享偏移平移的部分）。
  Key diffLineText(int index) => Key('$prefix-diff-text-$index');

  /// 长段未改动行的折叠/展开按钮。
  Key contextFold(int id) => Key('$prefix-context-fold-$id');
}

/// 只读的 Git 文件内容 / 差异查看器。
///
/// 状态优先级：加载中（无数据）→ 错误（无数据）→ 不可预览（binary/notice）→
/// 正常内容。顶层操作（如「提交历史」）通过 [topActions] 注入；返回按钮等由
/// 调用方通过 [leading] 注入，组件不持有导航职责。
class GitFileViewer extends StatefulWidget {
  const GitFileViewer({
    super.key,
    required this.mode,
    this.title,
    this.path,
    this.oldPath,
    this.content = '',
    this.diff = '',
    this.encodingLabel,
    this.truncated = false,
    this.truncatedMessage,
    this.binary = false,
    this.notice,
    this.emptyMessage,
    this.loading = false,
    this.error,
    this.onRetry,
    this.leading,
    this.topActions = const <Widget>[],
    this.rawAddedContent = false,
    this.keys = const GitFileViewerKeys(),
  });

  final GitFileViewerMode mode;

  /// 标题（无 [path] 时展示）；一般直接用 [path]。
  final String? title;

  /// 当前文件路径（仓库相对或工作区绝对，由调用方决定）。
  final String? path;

  /// 重命名前的旧路径（diff/内容头显示 `old → new`）。
  final String? oldPath;

  /// [GitFileViewerMode.content] 的已加载文本。
  final String content;

  /// [GitFileViewerMode.diff] 的已加载 unified diff 文本。
  final String diff;

  /// 编码提示（如 `UTF-8` / `GB18030`）；为空则不展示。
  final String? encodingLabel;

  /// 内容/差异是否被安全上限截断。
  final bool truncated;

  /// 截断提示文案；为空时按模式给默认提示。
  final String? truncatedMessage;

  /// 二进制文件（无可展示文本）。
  final bool binary;

  /// 自定义不可预览/空态说明（优先于 [binary] 的默认文案）。
  final String? notice;

  /// 正常内容为空时的提示；为空则内容模式保留一个空行（沿用旧预览行为）。
  final String? emptyMessage;

  final bool loading;
  final String? error;
  final VoidCallback? onRetry;

  /// 头栏左侧控件（如返回按钮）。
  final Widget? leading;

  /// 头栏右侧操作（如「提交历史」按钮）。
  final List<Widget> topActions;

  /// diff 是否为「未跟踪文件的原始内容」：每一行按新增行展示，且保留空行与
  /// 看起来像 diff 元数据的普通源码行（与旧工作区预览一致）。
  final bool rawAddedContent;

  final GitFileViewerKeys keys;

  @override
  State<GitFileViewer> createState() => _GitFileViewerState();
}

class _GitFileViewerState extends State<GitFileViewer>
    with SingleTickerProviderStateMixin {
  bool _rendered = true;
  String _cachedContent = '';
  String? _cachedPathKey;
  List<String> _markdownChunks = const [];
  List<String> _sourceLines = const [];
  final Set<int> _expandedContextRuns = <int>{};
  String _diffCacheKey = '';

  /// 内容模式自动换行开关（issue #117）：只属于当前 viewer 实例，默认开启。
  /// 关闭后正文横向滚动、行号列固定；不持久化、不跨文件记忆。
  bool _wrap = true;

  /// 切换代次：快速连点时只让最后一次帧末恢复生效，避免多次 jump 抖动。
  int _wrapToggleToken = 0;

  /// 尚未在帧末恢复的切换锚点。同一帧内连续点击时，第二次点击发生在
  /// `_wrap` 已翻转、折行 UI 尚未重建的过渡态；此时必须复用首次切换前
  /// 从**已渲染布局**采集的锚点，不能从过渡态重采（换行开→关后
  /// `_hScroll` 仍为 0，会把 charOffset 记成 0，最终跳回长行行首）。
  _WrapAnchor? _pendingWrapAnchor;

  /// 内容列表的纵向控制器：换行切换时用它把「顶部行」恢复到原位。
  final ScrollController _vScroll = ScrollController();

  /// 内容模式行号列宽度缓存（行数与 textScaler 不变时复用）。
  double? _gutterWidth;
  int _gutterLineCount = -1;
  double _gutterTextScale = -1;

  /// 关闭换行时最宽正文行宽（TextPainter 实测；缓存键含渲染同源样式）。
  double _cachedSourceMaxWidth = 0;
  String _cachedSourceMeasureKey = '';

  /// 重新开启换行时按行高累计恢复顶部行的增量缓存（只算到锚点）。
  final List<double> _wrappedLineHeights = <double>[];
  String _wrappedHeightKey = '';
  double _wrappedHeightWidth = -1;

  /// 关闭换行时每行（单行不折行，但 emoji/CJK 回退字体可能改变行高）缓存。
  final List<double> _unwrappedLineHeights = <double>[];
  String _unwrappedHeightKey = '';

  /// 最近一次内容正文视口宽（LayoutBuilder 写入），切换时用于估算行位置。
  double _lastContentWidth = 0;

  /// diff 预览的整块横向偏移：所有行共用，行号列不动（issue #71）。
  late final DiffScroll _hScroll;

  /// 惯性滑行：松手后按速度衰减到边界，不做位置估算瞬移（Q20/Q25）。
  late final AnimationController _flingCtrl;

  /// 解析缓存：diff 文本变化时才重新解析/测量，避免每帧 O(n) 重算。
  List<_DiffLineData>? _cachedDiffLines;
  String _cachedDiffLinesKey = '';

  /// 最宽 diff 行（含行号列以外的正文制表宽度），在解析时一次量好。
  double _maxLineWidth = 0;

  /// 最高的 diff 行正文。行号区据此撑到至少同高（CJK 回退字体可能比 ASCII
  /// 更高），1px 分隔线才能覆盖整行、不留行间断口。
  double _maxLineHeight = 0;

  /// 布局期夹取偏移后，帧末只补一次广播。
  bool _extentRefreshScheduled = false;

  bool get _isMarkdown => isMarkdownPath(widget.path ?? widget.title ?? '');

  bool get _hasPayload => widget.mode == GitFileViewerMode.diff
      ? widget.diff.isNotEmpty
      : widget.content.isNotEmpty;

  @override
  void initState() {
    super.initState();
    _syncContentCaches();
    _diffCacheKey = _diffKey();
    _hScroll = DiffScroll();
    _flingCtrl = AnimationController.unbounded(vsync: this)
      ..addListener(_onFlingTick);
  }

  @override
  void dispose() {
    _flingCtrl
      ..removeListener(_onFlingTick)
      ..dispose();
    _hScroll.dispose();
    _vScroll.dispose();
    super.dispose();
  }

  /// 惯性动画每 tick 把模拟位置写回共享偏移；撞到边界立刻停（不越界抖动）。
  void _onFlingTick() {
    final target = _flingCtrl.value;
    _hScroll.jumpTo(target);
    if (_hScroll.value != target) _flingCtrl.stop();
  }

  @override
  void didUpdateWidget(GitFileViewer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.content != widget.content ||
        oldWidget.path != widget.path ||
        oldWidget.title != widget.title ||
        oldWidget.mode != widget.mode) {
      _syncContentCaches();
      _rendered = true;
      // 重新打开/切换文件恢复默认开启（issue #117：不跨文件记忆）。
      // 同时作废旧切换的帧末恢复，避免把旧文件的行号跳到新文件上。
      _wrap = true;
      _wrapToggleToken++;
      _pendingWrapAnchor = null;
      _flingCtrl.stop();
      _hScroll.jumpTo(0);
    }
    final key = _diffKey();
    if (key != _diffCacheKey) {
      _diffCacheKey = key;
      _expandedContextRuns.clear();
      // 换了一份 diff：旧偏移/旧解析结果都不再适用，回到最左侧重新测量。
      // 必须走 jumpTo(0) 的广播路径：ValueListenableBuilder 会缓存 value，
      // 只有 notifier 对象变化或收到通知才重读；父级 rebuild 不会刷新它。
      // 静默改值会让已物化的行停在旧 diff 的偏移、新行读 0，同屏错位。
      // didUpdateWidget 期间监听者都是本 State 的后代，markNeedsBuild 允许。
      _flingCtrl.stop();
      _hScroll.jumpTo(0);
      _cachedDiffLines = null;
      _cachedDiffLinesKey = '';
    }
  }

  String _diffKey() =>
      '${widget.mode}\u0000${widget.path}\u0000${widget.diff.length}\u0000'
      '${widget.diff.hashCode}\u0000${widget.rawAddedContent}';

  /// 内容分片/源码行只在数据变化时算一次：256 KiB 文本每帧重切会卡死 UI。
  void _syncContentCaches() {
    final pathKey = widget.path ?? widget.title;
    if (_cachedContent == widget.content && _cachedPathKey == pathKey) return;
    _cachedContent = widget.content;
    _cachedPathKey = pathKey;
    _sourceLines = previewLines(widget.content);
    _markdownChunks = _isMarkdown
        ? chunkMarkdownText(widget.content)
        : const [];
    _resetContentMeasureCaches();
  }

  /// 内容数据变化后，所有按内容/行数测量的缓存都不再可信。
  void _resetContentMeasureCaches() {
    _gutterWidth = null;
    _gutterLineCount = -1;
    _gutterTextScale = -1;
    _cachedSourceMaxWidth = 0;
    _cachedSourceMeasureKey = '';
    _wrappedLineHeights.clear();
    _wrappedHeightKey = '';
    _wrappedHeightWidth = -1;
    _unwrappedLineHeights.clear();
    _unwrappedHeightKey = '';
  }

  void _copy(BuildContext context) {
    final text = widget.mode == GitFileViewerMode.diff
        ? widget.diff
        : widget.content;
    if (text.isEmpty) return;
    Clipboard.setData(ClipboardData(text: text));
    showToast(context, L10n.t('已复制内容', 'Content copied'));
  }

  @override
  Widget build(BuildContext context) {
    final hasPayload = _hasPayload;
    // 状态 body 也挂在同一 header 下：leading（返回）与 topActions（提交历史）
    // 在任何状态都保持可见，不因加载/错误/二进制而丢失入口。
    final Widget body;
    if (widget.loading && !hasPayload) {
      body = const Center(child: CircularProgressIndicator());
    } else if (widget.error != null && !hasPayload) {
      body = _errorState(context);
    } else if (widget.binary || widget.notice != null) {
      body = _unavailableState(context);
    } else {
      body = _body(context);
    }
    // issue #71 / Q24 由 `_diffBody` 内的嵌套 MediaQuery 实现：横向识别器 4px、
    // 纵向列表还原挂载点环境值。这里不能统一压 4——会把 header/折叠按钮的
    // tap 容差一起压小，也会把纵向 ListView 的阈值一起压低而加剧手势争抢。
    return Column(
      key: widget.keys.surface,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_showHeader) _header(context),
        if (_showHeader) const Divider(height: 1),
        if (widget.truncated && hasPayload) _truncatedBanner(context),
        Expanded(child: body),
      ],
    );
  }

  bool get _showHeader =>
      widget.leading != null ||
      widget.topActions.isNotEmpty ||
      (widget.path ?? widget.title ?? '').isNotEmpty ||
      (widget.encodingLabel ?? '').isNotEmpty ||
      _isMarkdown ||
      _showWrapToggle;

  /// 自动换行开关只在「内容模式、非 Markdown 渲染态、可预览文本」出现。
  /// diff、Markdown 渲染、二进制/不可预览按设计隐藏而不是灰显。
  bool get _showWrapToggle =>
      widget.mode == GitFileViewerMode.content &&
      !(_isMarkdown && _rendered) &&
      !widget.binary &&
      widget.notice == null;

  String get _displayPath {
    final path = widget.path ?? widget.title ?? '';
    final oldPath = widget.oldPath;
    if (oldPath == null || oldPath.isEmpty || oldPath == path) return path;
    return '$oldPath → $path';
  }

  /// 工具栏。顺序按设计 §5：`[返回] [路径] [编码] [预览/源码] [自动换行]
  /// [topActions] [复制]`；窄屏/1.5× 依次隐藏编码、图标化 Markdown 切换、
  /// 折叠 topActions，但不横滚工具栏、不压小 44 命中区。
  Widget _header(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final textScale = MediaQuery.textScalerOf(context).scale(1);
        final compact = constraints.maxWidth <= 360 || textScale >= 1.3;
        final overflowActions = compact
            ? _foldableActions()
            : const <IconButton>[];
        final inlineActions = widget.topActions
            .where((action) => !overflowActions.contains(action))
            .toList(growable: false);
        return Padding(
          padding: const EdgeInsets.fromLTRB(4, 4, 4, 4),
          child: Row(
            children: [
              if (widget.leading != null) widget.leading!,
              Expanded(
                child: Text(
                  _displayPath,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12.5,
                    color: DshColors.ink2(context),
                  ),
                ),
              ),
              if (!compact && (widget.encodingLabel ?? '').isNotEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 6),
                  child: Text(
                    widget.encodingLabel!,
                    style: TextStyle(
                      fontSize: 11,
                      color: DshColors.ink3(context),
                    ),
                  ),
                ),
              if (_isMarkdown)
                compact ? _modeIconToggle(context) : _modeToggle(),
              if (_showWrapToggle) _wrapToggleButton(context),
              ...inlineActions,
              if (overflowActions.isNotEmpty)
                _overflowActionsMenu(context, overflowActions),
              IconButton(
                key: widget.keys.copy,
                tooltip: L10n.t('复制内容', 'Copy content'),
                visualDensity: VisualDensity.compact,
                icon: const Icon(Icons.copy, size: 18),
                onPressed: _hasPayload ? () => _copy(context) : null,
              ),
            ],
          ),
        );
      },
    );
  }

  /// 可折叠进「更多操作」的 topActions。
  ///
  /// 当前各入口注入的都是 `IconButton`（提交历史等）；其它自定义控件保持原样
  /// inline，避免为了折叠去猜未知组件的语义。
  List<IconButton> _foldableActions() => widget.topActions
      .whereType<IconButton>()
      .where((action) => action.onPressed != null)
      .toList(growable: false);

  Widget _overflowActionsMenu(BuildContext context, List<IconButton> actions) {
    return PopupMenuButton<VoidCallback>(
      key: widget.keys.overflowActions,
      tooltip: L10n.t('更多操作', 'More actions'),
      icon: const Icon(Icons.more_vert, size: 20),
      onSelected: (callback) => callback(),
      itemBuilder: (context) => [
        for (final action in actions)
          PopupMenuItem<VoidCallback>(
            key: action.key,
            value: action.onPressed!,
            child: Row(
              children: [
                IconTheme(
                  data: IconThemeData(color: DshColors.ink2(context), size: 20),
                  child: action.icon,
                ),
                const SizedBox(width: 12),
                Expanded(child: Text(action.tooltip ?? '')),
              ],
            ),
          ),
      ],
    );
  }

  /// 内容模式「自动换行」切换（issue #117）。
  ///
  /// 开：brand 图标 + brandSoft 圆底；关：ink2 图标、无底。tooltip 带状态；
  /// 语义合并成单个 `toggled + button` 节点，读屏一次播报状态与动作。
  Widget _wrapToggleButton(BuildContext context) {
    final on = _wrap;
    final tooltip = on
        ? L10n.t('自动换行（已开启）', 'Wrap lines (on)')
        : L10n.t('自动换行（已关闭）', 'Wrap lines (off)');
    // 语义节点合并成一个「toggled + button」：读屏一次播报状态与动作。
    // 视觉/点击仍由 IconButton 负责（isSelected 给出 Material 选中态外观）。
    return Semantics(
      key: widget.keys.wrapToggle,
      button: true,
      toggled: on,
      label: tooltip,
      onTap: _toggleWrap,
      child: ExcludeSemantics(
        child: IconButton(
          tooltip: tooltip,
          isSelected: on,
          iconSize: 20,
          padding: EdgeInsets.zero,
          constraints: const BoxConstraints(
            minWidth: _kToolbarHitSize,
            minHeight: _kToolbarHitSize,
          ),
          style: IconButton.styleFrom(
            foregroundColor: on
                ? DshColors.brand(context)
                : DshColors.ink2(context),
            backgroundColor: on ? DshColors.brandSoft(context) : null,
            minimumSize: const Size(_kToolbarHitSize, _kToolbarHitSize),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
          icon: const Icon(Icons.wrap_text),
          onPressed: _toggleWrap,
        ),
      ),
    );
  }

  /// 「预览 / 源码」切换：仅对 Markdown 内容出现（与旧会话文件页一致）。
  Widget _modeToggle() {
    Widget item({
      required bool rendered,
      required String zh,
      required String en,
    }) {
      final active = _rendered == rendered;
      return TextButton(
        key: widget.keys.modeButton(rendered: rendered),
        onPressed: () {
          if (_rendered == rendered) return;
          setState(() => _rendered = rendered);
        },
        style: TextButton.styleFrom(
          minimumSize: const Size(0, 32),
          padding: const EdgeInsets.symmetric(horizontal: 10),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
        child: Text(
          L10n.t(zh, en),
          style: TextStyle(
            fontSize: 12.5,
            fontWeight: active ? FontWeight.w600 : FontWeight.w400,
            color: active ? DshColors.ink(context) : DshColors.ink3(context),
            decoration: active ? TextDecoration.underline : null,
          ),
        ),
      );
    }

    return Row(
      key: widget.keys.modeToggle,
      mainAxisSize: MainAxisSize.min,
      children: [
        item(rendered: true, zh: '预览', en: 'Preview'),
        item(rendered: false, zh: '源码', en: 'Source'),
      ],
    );
  }

  /// 窄屏/大字号下的「预览 / 源码」图标切换（设计 §5：省出文字宽度）。
  Widget _modeIconToggle(BuildContext context) {
    Widget item({
      required bool rendered,
      required IconData icon,
      required String zh,
      required String en,
    }) {
      final active = _rendered == rendered;
      return IconButton(
        key: widget.keys.modeButton(rendered: rendered),
        tooltip: L10n.t(zh, en),
        isSelected: active,
        iconSize: 20,
        padding: EdgeInsets.zero,
        constraints: const BoxConstraints(
          minWidth: _kToolbarHitSize,
          minHeight: _kToolbarHitSize,
        ),
        style: IconButton.styleFrom(
          foregroundColor: active
              ? DshColors.brand(context)
              : DshColors.ink3(context),
          backgroundColor: active ? DshColors.brandSoft(context) : null,
          minimumSize: const Size(_kToolbarHitSize, _kToolbarHitSize),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
        icon: Icon(icon),
        onPressed: () {
          if (_rendered == rendered) return;
          setState(() => _rendered = rendered);
        },
      );
    }

    return Row(
      key: widget.keys.modeToggle,
      mainAxisSize: MainAxisSize.min,
      children: [
        item(rendered: true, icon: Icons.visibility, zh: '预览', en: 'Preview'),
        item(rendered: false, icon: Icons.code, zh: '源码', en: 'Source'),
      ],
    );
  }

  Widget _truncatedBanner(BuildContext context) {
    final message =
        widget.truncatedMessage ??
        (widget.mode == GitFileViewerMode.diff
            ? L10n.t('差异已截断，仅显示安全上限内的内容', 'Diff truncated at the safety limit.')
            : L10n.t(
                '内容已截断，仅显示安全上限内的部分',
                'Content truncated at the safety limit.',
              ));
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      color: DshColors.brandSoft(context),
      child: Text(
        message,
        key: widget.keys.truncated,
        style: TextStyle(fontSize: 12, color: DshColors.ink2(context)),
      ),
    );
  }

  Widget _errorState(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              widget.error!,
              key: widget.keys.error,
              textAlign: TextAlign.center,
            ),
            if (widget.onRetry != null) ...[
              const SizedBox(height: 12),
              FilledButton.tonalIcon(
                key: widget.keys.retry,
                onPressed: widget.onRetry,
                icon: const Icon(Icons.refresh),
                label: Text(L10n.t('重试', 'Retry')),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _unavailableState(BuildContext context) {
    final message =
        widget.notice ??
        (widget.binary
            ? L10n.t('二进制文件不提供行级预览', 'Binary files have no line preview')
            : L10n.t('没有可显示的内容', 'Nothing to display'));
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Text(
          message,
          key: widget.keys.unavailable,
          textAlign: TextAlign.center,
        ),
      ),
    );
  }

  Widget _body(BuildContext context) {
    if (widget.mode == GitFileViewerMode.diff) return _diffBody(context);
    return _contentBody(context);
  }

  Widget _contentBody(BuildContext context) {
    if (widget.content.isEmpty && widget.emptyMessage != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            widget.emptyMessage!,
            key: widget.keys.empty,
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    if (_isMarkdown && _rendered) {
      return ListView.builder(
        key: widget.keys.markdownList,
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 24),
        itemCount: _markdownChunks.length,
        itemBuilder: (ctx, i) => Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: renderMarkdownBlocks(_markdownChunks[i], ctx),
          ),
        ),
      );
    }
    return LayoutBuilder(
      builder: (context, constraints) {
        _lastContentWidth = constraints.maxWidth;
        final gutterWidth = _sourceGutterWidth(context);
        final textWidth = math.max(
          0.0,
          constraints.maxWidth - gutterWidth - _kSourceGutterGap,
        );
        if (_wrap) {
          _syncContentExtent(0);
        } else {
          _syncContentExtent(
            math.max(0.0, _sourceMaxLineWidth(context) - textWidth),
          );
        }
        final canScroll = !_wrap && _hScroll.canScroll;
        final ambient = MediaQuery.of(context);
        return MediaQuery(
          // 与 diff 相同的非对称阈值：外层横拖 4px，内层纵向 ListView 用
          // 挂载点环境值；略斜横向拖动归横向，纵向滚动不受影响。
          data: ambient.copyWith(
            gestureSettings: const DeviceGestureSettings(touchSlop: 4),
          ),
          child: GestureDetector(
            key: widget.keys.sourceScrollSurface,
            // opaque：行尾空白区域也能接住横拖。
            behavior: HitTestBehavior.opaque,
            onHorizontalDragDown: canScroll ? _onHorizontalDragDown : null,
            onHorizontalDragStart: canScroll ? _onHorizontalDragStart : null,
            onHorizontalDragUpdate: canScroll ? _onHorizontalDragUpdate : null,
            onHorizontalDragEnd: canScroll ? _onHorizontalDragEnd : null,
            child: MediaQuery(
              data: ambient,
              child: ListView.builder(
                key: widget.keys.sourceList,
                controller: _vScroll,
                padding: const EdgeInsets.symmetric(
                  vertical: _kSourceListVerticalPadding,
                ),
                itemCount: _sourceLines.length,
                itemBuilder: (ctx, i) => _sourceLine(ctx, i, gutterWidth),
              ),
            ),
          ),
        );
      },
    );
  }

  /// 内容模式的一行：行号列固定宽；关闭换行时正文随共享横向偏移平移、
  /// 行号列不动（与 diff 相同的「一个横拖面 + 行号钉住」手势语言）。
  Widget _sourceLine(BuildContext context, int index, double gutterWidth) {
    final lineNumber = SizedBox(
      width: gutterWidth,
      child: Text(
        '${index + 1}',
        key: widget.keys.sourceLineNumber(index),
        maxLines: 1,
        softWrap: false,
        overflow: TextOverflow.clip,
        textAlign: TextAlign.right,
        style: TextStyle(
          fontFamily: 'monospace',
          fontSize: 12,
          color: DshColors.ink3(context),
        ),
      ),
    );
    final Widget body;
    if (_wrap) {
      body = Expanded(
        child: Text(
          _sourceLines[index],
          key: widget.keys.sourceLineText(index),
          style: _kSourceTextStyle,
        ),
      );
    } else {
      body = Expanded(
        child: ClipRect(
          child: ValueListenableBuilder<double>(
            valueListenable: _hScroll,
            builder: (context, offset, child) =>
                Transform.translate(offset: Offset(-offset, 0), child: child),
            child: Text(
              _sourceLines[index],
              key: widget.keys.sourceLineText(index),
              softWrap: false,
              overflow: TextOverflow.visible,
              style: _sourceTextStyle(context),
            ),
          ),
        ),
      );
    }
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        lineNumber,
        const SizedBox(width: _kSourceGutterGap),
        body,
      ],
    );
  }

  /// 正文样式：与渲染同源（Text 会 merge DefaultTextStyle 的 height/letterSpacing）。
  TextStyle _sourceTextStyle(BuildContext context) =>
      DefaultTextStyle.of(context).style.merge(_kSourceTextStyle);

  /// 行号列宽度：1.0× 固定 48；大字号按最大行号位数测量（上限 64）。
  /// 换行开/关共用同一宽度，切换时行号列不跳。
  double _sourceGutterWidth(BuildContext context) {
    final textScaler = MediaQuery.textScalerOf(context);
    final scale = textScaler.scale(_kSourceTextStyle.fontSize ?? 12) / 12;
    final lineCount = _sourceLines.length;
    final cached = _gutterWidth;
    if (cached != null &&
        _gutterLineCount == lineCount &&
        (_gutterTextScale - scale).abs() < 0.0001) {
      return cached;
    }
    double width;
    if (scale <= 1.0001) {
      width = _kSourceGutterMinWidth;
    } else {
      final digits = math.max(2, '$lineCount'.length);
      final painter = TextPainter(
        text: TextSpan(text: '9' * digits, style: _kSourceTextStyle),
        textDirection: Directionality.of(context),
        textScaler: textScaler,
        locale: Localizations.maybeLocaleOf(context),
      )..layout();
      // 行号右侧留 10dp 呼吸位，但不小于 48、不超过 64。
      width = (painter.width + 10)
          .clamp(_kSourceGutterMinWidth, _kSourceGutterMaxWidth)
          .toDouble();
      painter.dispose();
    }
    _gutterWidth = width;
    _gutterLineCount = lineCount;
    _gutterTextScale = scale;
    return width;
  }

  /// 关闭换行时最宽正文行宽（TextPainter 实测；CJK/emoji/制表符与实际渲染同源）。
  double _sourceMaxLineWidth(BuildContext context) {
    final style = _sourceTextStyle(context);
    final textScaler = MediaQuery.textScalerOf(context);
    final locale = Localizations.maybeLocaleOf(context);
    final cacheKey =
        '${widget.content.hashCode}\u0000${style.hashCode}\u0000'
        '${textScaler.scale(_kSourceTextStyle.fontSize ?? 12)}\u0000$locale';
    if (_cachedSourceMeasureKey == cacheKey) return _cachedSourceMaxWidth;
    var widest = 0.0;
    final painter = TextPainter(
      textDirection: Directionality.of(context),
      textScaler: textScaler,
      locale: locale,
    );
    try {
      for (final line in _sourceLines) {
        painter.text = TextSpan(text: line, style: style);
        // maxWidth 默认 infinity = 整行固有宽，与 softWrap:false 的渲染一致。
        painter.layout();
        widest = math.max(widest, painter.width);
      }
    } finally {
      painter.dispose();
    }
    _cachedSourceMaxWidth = widest;
    _cachedSourceMeasureKey = cacheKey;
    return widest;
  }

  /// 切换自动换行：记录视口顶部锚点（源行 + 行内字符/偏移）→ 重建 →
  /// 帧末恢复同一行内位置。单行超长内容不能只记行号，否则会跳回行首。
  void _toggleWrap() {
    // [reviewer P2] 同一帧内快速连点：第二次点击时 `_wrap` 已是下一次的目标值，
    // 但布局还是首次切换前的模式。复用首个 pending transition 的已渲染锚点，
    // 整串切换都基于同一份布局；否则会从未重建状态读到 hScroll=0 → charOffset=0。
    final anchor = _pendingWrapAnchor ?? _captureSourceAnchor();
    _pendingWrapAnchor = anchor;
    final token = ++_wrapToggleToken;
    final turningOn = !_wrap;
    if (turningOn) {
      // 恢复折行前先取消横向偏移，避免多留一帧平移。
      _flingCtrl.stop();
      _hScroll.jumpTo(0);
    }
    setState(() => _wrap = !_wrap);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // 快速连点时旧回调不再执行，最终状态只由最后一次切换决定。
      if (!mounted || token != _wrapToggleToken) return;
      _pendingWrapAnchor = null;
      if (_wrap) {
        _flingCtrl.stop();
        _hScroll.jumpTo(0);
      }
      _restoreSourceAnchor(anchor);
    });
  }

  /// 当前内容列表里第一个可见行及其在列表坐标系的行顶；找不到返回 null。
  ({int index, double rowTop})? _firstVisibleSourceRow() {
    final root = context.findRenderObject();
    if (root == null) return null;
    RenderSliverList? sliver;
    void visit(RenderObject child) {
      if (sliver != null) return;
      if (child is RenderSliverList) {
        sliver = child;
        return;
      }
      child.visitChildren(visit);
    }

    root.visitChildren(visit);
    final list = sliver;
    if (list == null) return null;
    final scrollOffset = list.constraints.scrollOffset;
    RenderBox? child = list.firstChild;
    while (child != null) {
      final parentData = child.parentData;
      if (parentData is SliverMultiBoxAdaptorParentData) {
        final index = parentData.index;
        final layoutOffset = parentData.layoutOffset;
        if (index != null &&
            layoutOffset != null &&
            layoutOffset + child.size.height > scrollOffset) {
          return (index: index, rowTop: layoutOffset);
        }
      }
      child = list.childAfter(child);
    }
    return null;
  }

  /// 记录视口顶部的行内锚点。
  ///
  /// - 换行开：按折行布局取「顶部可见字符」及其在视觉行内的像素偏移；
  /// - 换行关：按共享横向偏移取视口左缘的字符，供重新开启时定位到同一段。
  _WrapAnchor _captureSourceAnchor() {
    final row = _firstVisibleSourceRow();
    if (row == null || _sourceLines.isEmpty) {
      return const _WrapAnchor(lineIndex: 0, charOffset: 0);
    }
    final lineIndex = math.min(row.index, _sourceLines.length - 1);
    final text = _sourceLines[lineIndex];
    if (text.isEmpty) {
      return _WrapAnchor(lineIndex: lineIndex, charOffset: 0);
    }
    final painter = _sourceLinePainter(
      text,
      wrapped: _wrap,
      textWidth: _sourceTextWidth(),
    );
    try {
      if (!_wrap) {
        final horizontal = _hScroll.value.clamp(0.0, painter.width).toDouble();
        final position = painter.getPositionForOffset(Offset(horizontal, 0));
        return _WrapAnchor(lineIndex: lineIndex, charOffset: position.offset);
      }
      final scrollOffset = _vScroll.hasClients ? _vScroll.offset : 0.0;
      // 行顶可能在视口上方（或顶部 padding 内），夹到段落范围内。
      final dy = (scrollOffset - row.rowTop)
          .clamp(0.0, painter.height)
          .toDouble();
      final position = painter.getPositionForOffset(Offset(0, dy));
      final caret = painter.getOffsetForCaret(position, Rect.zero);
      return _WrapAnchor(
        lineIndex: lineIndex,
        charOffset: position.offset,
        intraLineOffset: math.max(0.0, dy - caret.dy),
      );
    } finally {
      painter.dispose();
    }
  }

  /// 恢复 [_WrapAnchor]：换行关按字符换算横向偏移，换行开按字符的视觉行 +
  /// 行内偏移恢复纵向位置；行号列始终固定。
  void _restoreSourceAnchor(_WrapAnchor anchor) {
    if (!_vScroll.hasClients || _sourceLines.isEmpty) return;
    final lineIndex = math.min(
      math.max(0, anchor.lineIndex),
      _sourceLines.length - 1,
    );
    final text = _sourceLines[lineIndex];
    final textWidth = _sourceTextWidth();
    final painter = _sourceLinePainter(
      text,
      wrapped: _wrap,
      textWidth: textWidth,
    );
    try {
      final charOffset = text.isEmpty
          ? 0
          : math.min(math.max(0, anchor.charOffset), text.length);
      var offset = _kSourceListVerticalPadding.toDouble();
      if (_wrap) {
        final caret = painter.getOffsetForCaret(
          TextPosition(offset: charOffset),
          Rect.zero,
        );
        offset += _wrappedHeightUpTo(lineIndex, textWidth);
        offset += caret.dy;
        // 保留切换前在视觉行内的像素位置，避免每次切换向上漂移一行。
        offset += anchor.intraLineOffset.clamp(0.0, painter.height);
      } else {
        offset += _unwrappedHeightUpTo(lineIndex);
        final caret = painter.getOffsetForCaret(
          TextPosition(offset: charOffset),
          Rect.zero,
        );
        // 关闭换行后行内纵向位置无法直接映射：把同一字符放到视图左缘，
        // 保持横向阅读位置，绝不跳回行首。
        _hScroll.jumpTo(caret.dx);
      }
      final position = _vScroll.position;
      _vScroll.jumpTo(offset.clamp(0.0, position.maxScrollExtent).toDouble());
    } finally {
      painter.dispose();
    }
  }

  /// 内容正文视口宽（总宽 − 固定行号列 − 间距），换行开/关一致。
  double _sourceTextWidth() {
    final width = _lastContentWidth;
    if (width <= 0) return 0;
    return math.max(
      0.0,
      width - _sourceGutterWidth(context) - _kSourceGutterGap,
    );
  }

  /// 按当前换行状态构造与渲染同源的段落，供行内字符/像素映射使用。
  TextPainter _sourceLinePainter(
    String text, {
    required bool wrapped,
    required double textWidth,
  }) {
    final painter = TextPainter(
      text: TextSpan(text: text, style: _sourceTextStyle(context)),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      locale: Localizations.maybeLocaleOf(context),
    );
    painter.layout(maxWidth: wrapped ? textWidth : double.infinity);
    return painter;
  }

  /// 换行态下 [0, endExclusive) 行的累计高度；按内容/宽度增量缓存，只算到锚点。
  double _wrappedHeightUpTo(int endExclusive, double maxWidth) {
    if (endExclusive <= 0) return 0;
    final style = _sourceTextStyle(context);
    final textScaler = MediaQuery.textScalerOf(context);
    final locale = Localizations.maybeLocaleOf(context);
    final cacheKey =
        '${widget.content.hashCode}\u0000${style.hashCode}\u0000'
        '${textScaler.scale(_kSourceTextStyle.fontSize ?? 12)}\u0000$locale';
    if (_wrappedHeightKey != cacheKey || _wrappedHeightWidth != maxWidth) {
      _wrappedLineHeights.clear();
      _wrappedHeightKey = cacheKey;
      _wrappedHeightWidth = maxWidth;
    }
    final target = math.min(endExclusive, _sourceLines.length);
    final painter = TextPainter(
      textDirection: Directionality.of(context),
      textScaler: textScaler,
      locale: locale,
    );
    try {
      for (var i = _wrappedLineHeights.length; i < target; i++) {
        painter.text = TextSpan(text: _sourceLines[i], style: style);
        painter.layout(maxWidth: maxWidth);
        _wrappedLineHeights.add(painter.height);
      }
    } finally {
      painter.dispose();
    }
    var total = 0.0;
    for (var i = 0; i < target; i++) {
      total += _wrappedLineHeights[i];
    }
    return total;
  }

  /// 关闭换行态下 [0, endExclusive) 行的累计高度。
  ///
  /// 不折行时行高通常一致，但 emoji/CJK 回退字体可能更高；按逐行实测累计，
  /// 保证切换后顶部行不因字体回退而偏移。缓存与换行态同源。
  double _unwrappedHeightUpTo(int endExclusive) {
    if (endExclusive <= 0) return 0;
    final style = _sourceTextStyle(context);
    final textScaler = MediaQuery.textScalerOf(context);
    final locale = Localizations.maybeLocaleOf(context);
    final cacheKey =
        '${widget.content.hashCode}\u0000${style.hashCode}\u0000'
        '${textScaler.scale(_kSourceTextStyle.fontSize ?? 12)}\u0000$locale';
    if (_unwrappedHeightKey != cacheKey) {
      _unwrappedLineHeights.clear();
      _unwrappedHeightKey = cacheKey;
    }
    final target = math.min(endExclusive, _sourceLines.length);
    final painter = TextPainter(
      textDirection: Directionality.of(context),
      textScaler: textScaler,
      locale: locale,
    );
    try {
      for (var i = _unwrappedLineHeights.length; i < target; i++) {
        painter.text = TextSpan(text: _sourceLines[i], style: style);
        // softWrap:false 时 RenderParagraph 用固有宽度排版，行高与视口宽无关。
        painter.layout();
        _unwrappedLineHeights.add(painter.height);
      }
    } finally {
      painter.dispose();
    }
    var total = 0.0;
    for (var i = 0; i < target; i++) {
      total += _unwrappedLineHeights[i];
    }
    return total;
  }

  Widget _diffBody(BuildContext context) {
    final lines = _diffLines(context);
    if (lines.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            widget.emptyMessage ??
                L10n.t('没有可显示的行级差异', 'No line changes to display'),
            key: widget.keys.empty,
          ),
        ),
      );
    }
    final rows = _diffRows(lines);
    // 关键：用 State 的 context 取「挂载点环境值」（Android≈8；测试 null→18）。
    // 不能取 LayoutBuilder 内的 context，否则会取到下面给横向识别器的 4。
    final MediaQueryData ambient = MediaQuery.of(context);
    return LayoutBuilder(
      builder: (context, constraints) {
        // 正文视口宽 = 总宽 − 左右内边距 − 固定行号区 − 1px 分隔线。
        final textViewportWidth = math.max(
          0.0,
          constraints.maxWidth -
              _kDiffLinePadding * 2 -
              _kDiffGutterWidth -
              _kDiffGutterDividerWidth,
        );
        final maxExtent = math.max(0.0, _maxLineWidth - textViewportWidth);
        _syncDiffExtent(maxExtent);
        final canScroll = maxExtent > 0;
        return MediaQuery(
          // 只给「外层横向 recognizer」压阈值：同事件双越线时纵向先处理，
          // 统一 slop 不改变方向比；横向 4 / 纵向环境值才能让略斜横滑也归横向。
          data: ambient.copyWith(
            gestureSettings: const DeviceGestureSettings(touchSlop: 4),
          ),
          child: GestureDetector(
            key: widget.keys.diffScrollSurface,
            // opaque：空行区域也要能接住横滑，否则下半屏拖不动。
            behavior: HitTestBehavior.opaque,
            // 无需横向滚动时不挂识别器：避免 4px 抖动吞掉折叠按钮点击。
            onHorizontalDragDown: canScroll ? _onHorizontalDragDown : null,
            onHorizontalDragStart: canScroll ? _onHorizontalDragStart : null,
            onHorizontalDragUpdate: canScroll ? _onHorizontalDragUpdate : null,
            onHorizontalDragEnd: canScroll ? _onHorizontalDragEnd : null,
            // 内层还原纵向 ListView 的挂载点阈值（Android≈8），实现非对称 4/8。
            child: MediaQuery(
              data: ambient,
              // 懒构建（Q21 第二个 commit）：512 KiB 上限的 diff 可达
              // 1.3~1.7 万行，`ListView(children:)` 会一次物化全部行
              // Widget，这里只按视口构建；`rows` 只是轻量的行描述对象。
              child: ListView.builder(
                key: widget.keys.sourceList,
                padding: const EdgeInsets.symmetric(vertical: 4),
                itemCount: rows.length,
                itemBuilder: (context, index) {
                  final row = rows[index];
                  final lineIndex = row.lineIndex;
                  if (lineIndex != null) {
                    return _diffLine(
                      context,
                      lines[lineIndex],
                      lineIndex: lineIndex,
                    );
                  }
                  return _foldButton(row);
                },
              ),
            ),
          ),
        );
      },
    );
  }

  /// 布局期更新可横向滚动的余量。
  ///
  /// 视口宽度只能布局时拿到，而布局期直接 `notifyListeners` 会让正在布局
  /// 的子树变脏；只有当前偏移真的被夹取时才在帧末补一次广播。
  void _syncDiffExtent(double maxExtent) {
    if (!_hScroll.updateExtent(maxExtent)) return;
    if (_extentRefreshScheduled) return;
    _extentRefreshScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _extentRefreshScheduled = false;
      if (!mounted) return;
      _hScroll.refresh();
    });
  }

  /// 内容模式关闭换行时的共享横向余量（与 diff 同一套帧末广播约定）。
  void _syncContentExtent(double maxExtent) {
    if (!_hScroll.updateExtent(maxExtent)) return;
    if (_extentRefreshScheduled) return;
    _extentRefreshScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _extentRefreshScheduled = false;
      if (!mounted) return;
      _hScroll.refresh();
    });
  }

  void _onHorizontalDragDown(DragDownDetails details) {
    _flingCtrl.stop();
  }

  void _onHorizontalDragStart(DragStartDetails details) {
    _flingCtrl.stop();
  }

  void _onHorizontalDragUpdate(DragUpdateDetails details) {
    // 手指左移（dx < 0）→ 内容左移（偏移增大）。
    _hScroll.dragBy(-details.delta.dx);
  }

  void _onHorizontalDragEnd(DragEndDetails details) {
    final velocity = -(details.primaryVelocity ?? 0);
    if (!velocity.isFinite || velocity.abs() < kMinFlingVelocity) return;
    if (!_hScroll.canScroll) return;
    // 真惯性：与 Android 滚动一致的衰减模拟；`_onFlingTick` 负责写回偏移，
    // 撞到边界立刻停（不做「估算位置瞬移」）。
    _flingCtrl.animateWith(
      ClampingScrollSimulation(position: _hScroll.value, velocity: velocity),
    );
  }

  /// diff 正文样式：实际 `Text` 会 merge `DefaultTextStyle`（M3 bodyMedium 的
  /// letterSpacing:0.25 / height:1.43），测量必须与渲染同源，否则行宽偏小，
  /// 最长行的尾部永远滚不到。
  TextStyle _diffTextStyle(BuildContext context) =>
      DefaultTextStyle.of(context).style.merge(_kDiffTextStyle);

  /// 解析并测量 diff 行，结果缓存（diff 文本 / textScaler / 样式 / locale 变化时失效）。
  ///
  /// 最宽行宽必须在解析时一次量好（Q22）：`fontFamily: 'monospace'` 遇 CJK 会
  /// 回退到比例字族，行宽 ≠ 字符数 × 常数，只能 [TextPainter] 实测。
  List<_DiffLineData> _diffLines(BuildContext context) {
    final style = _diffTextStyle(context);
    final textScaler = MediaQuery.textScalerOf(context);
    final locale = Localizations.maybeLocaleOf(context);
    final cacheKey =
        '$_diffCacheKey\u0000${style.hashCode}\u0000'
        '${textScaler.scale(_kDiffTextStyle.fontSize ?? 12)}\u0000$locale';
    final cached = _cachedDiffLines;
    if (cached != null && _cachedDiffLinesKey == cacheKey) return cached;
    final lines = _parseDiffLines();
    _measureDiffLines(
      lines,
      style,
      textScaler,
      locale,
      Directionality.of(context),
    );
    _cachedDiffLines = lines;
    _cachedDiffLinesKey = cacheKey;
    return lines;
  }

  /// 量出最宽行宽（O(n) 一次），作为共享横向偏移的边界。
  void _measureDiffLines(
    List<_DiffLineData> lines,
    TextStyle style,
    TextScaler textScaler,
    Locale? locale,
    TextDirection direction,
  ) {
    _maxLineWidth = 0;
    _maxLineHeight = 0;
    final painter = TextPainter(
      textDirection: direction,
      textScaler: textScaler,
      locale: locale,
    );
    try {
      for (final line in lines) {
        painter.text = TextSpan(text: line.text, style: style);
        // maxWidth 默认 infinity = 整行固有宽，和实际 Text(softWrap:false) 一致。
        painter.layout();
        _maxLineWidth = math.max(_maxLineWidth, painter.width);
        _maxLineHeight = math.max(_maxLineHeight, painter.height);
      }
    } finally {
      painter.dispose();
    }
  }

  /// 解析 unified diff：跳过文件头/索引行，保留 hunk 标记与增删/上下文行。
  ///
  /// 同时按 hunk header（`@@ -a,b +c,d @@`）为每行算出旧/新行号：上下文行两边
  /// 都递增，删除行只进旧侧，新增行只进新侧；hunk header 行本身不显示行号。
  /// 未跟踪文件返回原始内容而不是 patch：每行按新增行展示（新侧行号），保留
  /// 空行与看起来像 diff 元数据的普通源码行，只忽略末尾换行产生的空哨兵。
  List<_DiffLineData> _parseDiffLines() {
    if (widget.diff.isEmpty) return const [];
    final rawLines = widget.diff.split('\n');
    final lines = <_DiffLineData>[];
    var inHunk = false;
    var oldLine = 0;
    var newLine = 0;
    var addedCount = 0;
    for (var rawIndex = 0; rawIndex < rawLines.length; rawIndex++) {
      final line = rawLines[rawIndex];
      if (widget.rawAddedContent) {
        if (rawIndex == rawLines.length - 1 &&
            line.isEmpty &&
            widget.diff.endsWith('\n')) {
          continue;
        }
        addedCount++;
        lines.add(
          _DiffLineData(marker: '+', text: line, newNumber: addedCount),
        );
        continue;
      }
      if (line.isEmpty ||
          line.startsWith('diff --git ') ||
          line.startsWith('index ') ||
          line.startsWith('Binary files ')) {
        continue;
      }
      if (line.startsWith('@@')) {
        inHunk = true;
        final header = _hunkHeader.firstMatch(line);
        if (header != null) {
          oldLine = int.parse(header.group(1)!);
          newLine = int.parse(header.group(3)!);
        }
        lines.add(_DiffLineData(marker: '@', text: line));
        continue;
      }
      if (line.startsWith('\\')) continue;
      if (!inHunk && (line.startsWith('--- ') || line.startsWith('+++ '))) {
        continue;
      }
      if (line.startsWith('+')) {
        lines.add(
          _DiffLineData(
            marker: '+',
            text: line.substring(1),
            newNumber: newLine++,
          ),
        );
      } else if (line.startsWith('-')) {
        lines.add(
          _DiffLineData(
            marker: '-',
            text: line.substring(1),
            oldNumber: oldLine++,
          ),
        );
      } else if (line.startsWith(' ')) {
        lines.add(
          _DiffLineData(
            marker: ' ',
            text: line.substring(1),
            oldNumber: oldLine++,
            newNumber: newLine++,
          ),
        );
      }
    }
    return lines;
  }

  /// 把解析后的行折叠成「可见行 / 折叠按钮」序列（Q21 第二个 commit）。
  ///
  /// 只生成轻量的 [_DiffRow] 描述对象，不物化 Widget：折叠段的可见行下标
  /// 只算一次，`ListView.builder` 按视口懒构建真正的行。
  List<_DiffRow> _diffRows(List<_DiffLineData> lines) {
    final rows = <_DiffRow>[];
    var index = 0;
    var runId = 0;
    while (index < lines.length) {
      if (lines[index].marker != ' ') {
        rows.add(_DiffRow.line(index));
        index++;
        continue;
      }
      final start = index;
      while (index < lines.length && lines[index].marker == ' ') {
        index++;
      }
      final length = index - start;
      if (length <= 6) {
        for (var i = start; i < index; i++) {
          rows.add(_DiffRow.line(i));
        }
        continue;
      }
      final id = runId++;
      final expanded = _expandedContextRuns.contains(id);
      if (expanded) {
        for (var i = start; i < index; i++) {
          rows.add(_DiffRow.line(i));
        }
      } else {
        for (var offset = 0; offset < 3; offset++) {
          rows.add(_DiffRow.line(start + offset));
        }
        for (var offset = index - 3; offset < index; offset++) {
          rows.add(_DiffRow.line(offset));
        }
      }
      rows.add(_DiffRow.fold(id, length, expanded));
    }
    return rows;
  }

  /// 长段未改动行的折叠/展开按钮（展开状态仍走 setState，与改造前一致）。
  Widget _foldButton(_DiffRow row) {
    final id = row.foldId!;
    final expanded = row.expanded;
    final count = row.foldCount ?? 0;
    return TextButton.icon(
      key: widget.keys.contextFold(id),
      onPressed: () => setState(() {
        if (expanded) {
          _expandedContextRuns.remove(id);
        } else {
          _expandedContextRuns.add(id);
        }
      }),
      icon: Icon(expanded ? Icons.unfold_less : Icons.unfold_more, size: 18),
      label: Text(
        expanded
            ? L10n.t('折叠未改动行', 'Fold unchanged lines')
            : L10n.t(
                '展开 ${math.max(0, count - 6)} 行未改动',
                'Expand ${math.max(0, count - 6)} unchanged lines',
              ),
      ),
    );
  }

  Widget _diffLine(BuildContext context, _DiffLineData line, {int? lineIndex}) {
    final color = switch (line.marker) {
      '+' => DshColors.ok(context),
      '-' => DshColors.danger(context),
      '@' => DshColors.ink3(context),
      _ => DshColors.ink(context),
    };
    final background = switch (line.marker) {
      '+' => DshColors.ok(context).withValues(alpha: .10),
      '-' => DshColors.danger(context).withValues(alpha: .10),
      _ => Colors.transparent,
    };
    final numberStyle = TextStyle(
      fontFamily: 'monospace',
      fontSize: 11,
      color: DshColors.ink3(context),
    );
    return Container(
      key: lineIndex == null ? null : widget.keys.diffLine(lineIndex),
      // Q12：增删底色留在最外层 Container，行号区与正文区两侧都有底色。
      color: background,
      // 上下内边距下沉到行号区/正文内部：分隔线在外层不再被 padding 截短。
      padding: const EdgeInsets.symmetric(horizontal: _kDiffLinePadding),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 行号区：旧号 / 新号 / 增删标记。不随横向偏移移动（Q2 固定）。
          //
          // 宽 93 = 92 内容 + 1px 右侧分隔线（Q13）：childless `Container(width:1)`
          // 在 Row(start) 的纵向无界约束下会被压成 1×0（不可见），所以分隔线
          // 用行号区容器的 border 实现，随行高自动拉满。颜色用主题令牌。
          Container(
            width: _kDiffGutterWidth + _kDiffGutterDividerWidth,
            // 至少与最高正文行同高（含上下内边距）：Border 覆盖整行高度，
            // 相邻行的竖线相接，不会退化成「每行 20dp 的虚线」。
            constraints: BoxConstraints(
              minHeight: _maxLineHeight + _kDiffLineVerticalPadding * 2,
            ),
            decoration: BoxDecoration(
              border: Border(
                right: BorderSide(
                  color: DshColors.line(context),
                  width: _kDiffGutterDividerWidth,
                ),
              ),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                vertical: _kDiffLineVerticalPadding,
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 34,
                    child: Text(
                      line.oldNumber?.toString() ?? '',
                      key: lineIndex == null
                          ? null
                          : widget.keys.diffLineOldNumber(lineIndex),
                      textAlign: TextAlign.right,
                      style: numberStyle,
                    ),
                  ),
                  const SizedBox(width: 4),
                  SizedBox(
                    width: 34,
                    child: Text(
                      line.newNumber?.toString() ?? '',
                      key: lineIndex == null
                          ? null
                          : widget.keys.diffLineNewNumber(lineIndex),
                      textAlign: TextAlign.right,
                      style: numberStyle,
                    ),
                  ),
                  SizedBox(
                    width: 20,
                    child: Text(
                      line.marker == ' ' ? ' ' : line.marker,
                      style: TextStyle(
                        color: color,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(
                vertical: _kDiffLineVerticalPadding,
              ),
              child: ClipRect(
                // 每行只监听共享偏移、只重建自身，而不是整块 diff（Q19）。
                child: ValueListenableBuilder<double>(
                  valueListenable: _hScroll,
                  builder: (context, offset, child) => Transform.translate(
                    offset: Offset(-offset, 0),
                    child: child,
                  ),
                  // 正文静态子树：偏移变化只平移，不重建 Text、不重排长段落。
                  //
                  // `softWrap: false` + `overflow: visible`：RenderParagraph
                  // 用固有宽度排版（maxWidth=∞）且不裁剪、不画 debug 溢出条
                  // （rendering/paragraph.dart `_adjustMaxWidth`），长行画到
                  // Expanded 宽度之外，由外层 ClipRect 负责视口裁剪。
                  child: Text(
                    line.text,
                    key: lineIndex == null
                        ? null
                        : widget.keys.diffLineText(lineIndex),
                    softWrap: false,
                    overflow: TextOverflow.visible,
                    style: _diffTextStyle(context).copyWith(color: color),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 一行 diff（已解析出行号）：[oldNumber]/[newNumber] 为 null 表示该侧不存在。
class _DiffLineData {
  const _DiffLineData({
    required this.marker,
    required this.text,
    this.oldNumber,
    this.newNumber,
  });

  final String marker;
  final String text;
  final int? oldNumber;
  final int? newNumber;
}

/// diff 列表里的一行：要么是原始 diff 行（[lineIndex]），要么是折叠按钮行
/// （[foldId]/[foldCount]）。只是数据描述，不持有 Widget（Q21 懒构建）。
class _DiffRow {
  const _DiffRow.line(this.lineIndex)
    : foldId = null,
      foldCount = null,
      expanded = false;

  const _DiffRow.fold(this.foldId, this.foldCount, this.expanded)
    : lineIndex = null;

  /// 在 `_DiffLineData` 列表里的下标；折叠按钮行为 null。
  final int? lineIndex;

  /// 折叠段的稳定 id（对应 `_expandedContextRuns` 的键）。
  final int? foldId;

  /// 折叠段的总行数（用于按钮文案）。
  final int? foldCount;

  /// 折叠按钮行是否已展开（展开后该段不再有按钮行）。
  final bool expanded;
}

/// 换行切换时的视口锚点：源行 + 行内字符偏移 + 视觉行内像素偏移。
///
/// 只记行号在单行超长内容上会跳回行首；[charOffset] 让关闭换行时能换算到
/// 横向滚动位置，再开启时又能从折行布局中找回同一段文字。
class _WrapAnchor {
  const _WrapAnchor({
    required this.lineIndex,
    required this.charOffset,
    this.intraLineOffset = 0,
  });

  final int lineIndex;

  /// 源行内的 UTF-16 字符偏移（顶部/左缘可见的第一个字符）。
  final int charOffset;

  /// 换行态下视口顶部相对该视觉行顶部的像素偏移；关闭换行态为 0。
  final double intraLineOffset;
}

/// diff 预览整块横向滚动共享的偏移（issue #71 / Q19 方案 B）。
///
/// 纯数值逻辑、不依赖 Widget 层：行号列钉在左侧，正文区按同一偏移平移；每行
/// 用 `ValueListenableBuilder` 监听本对象，只重建自身。`git_file_viewer_test.dart`
/// 直接单测它（公开类型只为可测，不属于对外 API）。
///
/// 实现 [ValueListenable] 是让 `ValueListenableBuilder<double>` 直接可用；
/// `addListener`/`removeListener` 继承自 [ChangeNotifier]。
class DiffScroll extends ChangeNotifier implements ValueListenable<double> {
  double _value = 0;
  double _maxExtent = 0;

  /// 当前横向偏移（逻辑像素，内容整体左移为正）。
  @override
  double get value => _value;

  /// 内容能额外左移的最大距离；装得下时为 0。
  double get maxExtent => _maxExtent;

  /// 是否存在可横向滚动的余量。
  bool get canScroll => _maxExtent > 0;

  /// 更新最大偏移（视口宽度或最宽行变化时），并把当前偏移夹进新边界。
  ///
  /// 返回 `true` 表示 [value] 被夹取，调用方需要刷新监听者。本方法自身不
  /// notify：它通常在 `LayoutBuilder` 的布局期调用，直接通知会让正在布局的
  /// 子树变脏；由调用方在帧末调用 [refresh] 统一广播。
  bool updateExtent(double maxExtent) {
    // 非有限输入（NaN/±inf）按 0 处理，否则 math.max 会把 NaN 传播进 value。
    final next = maxExtent.isFinite && maxExtent > 0 ? maxExtent : 0.0;
    if (next == _maxExtent) return false;
    _maxExtent = next;
    if (_value <= _maxExtent) return false;
    _value = _maxExtent;
    return true;
  }

  /// 跳到指定偏移，自动夹取到 `[0, maxExtent]`。
  void jumpTo(double value) {
    final target = value.isFinite ? value : 0.0;
    final next = math.min(math.max(0.0, target), _maxExtent);
    if (next == _value) return;
    _value = next;
    notifyListeners();
  }

  /// 按滚动增量拖动（手指左移为正）；到边界即停，不会越界。
  void dragBy(double pixels) => jumpTo(_value + pixels);

  /// 布局期夹取后补一次广播（[updateExtent] 不自行 notify 的配套方法）。
  void refresh() => notifyListeners();
}

/// unified diff hunk header：`@@ -oldStart,oldCount +newStart,newCount @@`。
final RegExp _hunkHeader = RegExp(
  r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@',
);
