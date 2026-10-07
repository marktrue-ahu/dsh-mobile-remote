// issue #24：轮次导航的视觉载体（刻度轨）。
//
// 手机没有悬停，所以电脑端的"指针移到刻度上出预览"改为：
//   - **点按**某个刻度 = 直接跳转；
//   - **长按**进入扫掠模式，随后**沿轨拖动**连续预览，**松手**落在预览所指的那一轮。
// 之所以用"长按后拖动"而不是"直接拖动"：竖直拖动是消息流的滚动手势，
// 刻度轨不应把它抢走。长按手势在手势竞技场里天然晚于滚动，因此两者不冲突。
//
// 本组件只负责呈现与手势，不决定何时可见、也不做定位——那两件事分别由
// `shouldShowTurnRail` 与聊天页的定位循环负责（见 ADR 0018）。

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../l10n.dart';
import '../theme.dart';
import '../turn_navigation.dart';

/// 单个刻度的行高（与电脑端一致的固定步距，便于"按 y 反算序号"）。
const double _kTickPitch = 10;

/// 刻度条尺寸：宽 20 × 高 2 的圆角横条，右对齐。
const double _kBarWidth = 20;
const double _kBarHeight = 2;

/// 轨道两端的内边距（避免首尾刻度贴边）。
const double _kRailInset = 6;

/// 轨内滚动到两端时的渐隐带宽。
const double _kFadeBand = 24;

/// 预览气泡宽度上限（与电脑端一致：至多 300，且不超过容器宽度减 120）。
const double _kPreviewMaxWidth = 300;

class TurnNavigatorRail extends StatefulWidget {
  const TurnNavigatorRail({
    super.key,
    required this.anchors,
    required this.activeTurn,
    required this.busyTurn,
    required this.onNavigate,
    this.width = 28,
    this.maxHeight = 420,
  });

  /// 已加载轮次（按轮次号升序）。少于 2 轮时不渲染。
  final List<TurnAnchor> anchors;

  /// 当前阅读的轮次（高亮）。
  final int? activeTurn;

  /// 跳转进行中的轮次（脉冲）；null 表示空闲。
  final int? busyTurn;

  /// 用户选定某一轮（点按或长按扫掠松手）。
  final ValueChanged<TurnAnchor> onNavigate;

  final double width;
  final double maxHeight;

  @override
  State<TurnNavigatorRail> createState() => _TurnNavigatorRailState();
}

class _TurnNavigatorRailState extends State<TurnNavigatorRail>
    with SingleTickerProviderStateMixin {
  final ScrollController _railCtrl = ScrollController();

  /// 扫掠模式中预览到的轮次；null 表示没有预览。
  int? _previewTurn;

  /// 是否处于长按扫掠中（决定松手是落点还是取消、以及是否让出自动跟随）。
  bool _scrubbing = false;

  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1000),
  );

  @override
  void initState() {
    super.initState();
    _syncPulse();
  }

  @override
  void didUpdateWidget(covariant TurnNavigatorRail oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncPulse();
    // 当前轮变化时把它滚进视野；扫掠期间不移动轨道（不把手底下的东西抽走）。
    if (!_scrubbing && oldWidget.activeTurn != widget.activeTurn) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _revealActive());
    }
  }

  void _syncPulse() {
    if (widget.busyTurn != null) {
      if (!_pulse.isAnimating) _pulse.repeat(reverse: true);
    } else if (_pulse.isAnimating) {
      _pulse.stop();
      _pulse.value = 1;
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    _railCtrl.dispose();
    super.dispose();
  }

  int get _count => widget.anchors.length;

  double get _contentHeight => _count * _kTickPitch + _kRailInset * 2;

  /// 把当前轮滚进轨内视野（居中优先，必要时只保证可见）。
  void _revealActive() {
    if (!mounted || !_railCtrl.hasClients) return;
    final active = widget.activeTurn;
    if (active == null) return;
    final index = widget.anchors.indexWhere((a) => a.turn == active);
    if (index < 0) return;
    final viewport = _railCtrl.position.viewportDimension;
    final target = _kRailInset + index * _kTickPitch - viewport / 2;
    final maxOffset = math.max(0.0, _contentHeight - viewport);
    final clamped = target.clamp(0.0, maxOffset).toDouble();
    if ((_railCtrl.offset - clamped).abs() < 1) return;
    _railCtrl.animateTo(
      clamped,
      duration: const Duration(milliseconds: 180),
      curve: Curves.easeOutCubic,
    );
  }

  /// 由轨道内的本地 y 反算刻度序号（考虑轨内滚动偏移）。
  int _indexAtLocalY(double localY) {
    final contentY = localY + (_railCtrl.hasClients ? _railCtrl.offset : 0);
    final raw = ((contentY - _kRailInset) / _kTickPitch).floor();
    return raw.clamp(0, _count - 1);
  }

  void _setPreviewFromLocalY(double localY) {
    final index = _indexAtLocalY(localY);
    final turn = widget.anchors[index].turn;
    if (turn == _previewTurn) return;
    setState(() => _previewTurn = turn);
  }

  void _commitPreview() {
    final turn = _previewTurn;
    setState(() {
      _previewTurn = null;
      _scrubbing = false;
    });
    if (turn == null) return;
    final index = widget.anchors.indexWhere((a) => a.turn == turn);
    if (index < 0) return;
    widget.onNavigate(widget.anchors[index]);
  }

  @override
  Widget build(BuildContext context) {
    // 少于 2 轮：没有导航价值，不渲染（与电脑端一致）。
    if (_count < 2) return const SizedBox.shrink();

    return LayoutBuilder(
      builder: (context, constraints) {
        final available = constraints.maxHeight.isFinite
            ? constraints.maxHeight
            : widget.maxHeight;
        // 与电脑端同构：留出 64px 余量，并设上限，避免在长会话里铺满全屏。
        final frameHeight = math.min(
          widget.maxHeight,
          math.max(0.0, available - 64),
        );
        if (frameHeight < _kTickPitch * 2) return const SizedBox.shrink();

        final overflow = _contentHeight > frameHeight;
        final preview = _previewTurn == null
            ? null
            : widget.anchors.firstWhere(
                (a) => a.turn == _previewTurn,
                orElse: () => widget.anchors.first,
              );

        return SizedBox(
          width: widget.width,
          height: frameHeight,
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              Positioned.fill(
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTapUp: (d) {
                    // 点按 = 直接跳转（不需要先出预览）。
                    final index = _indexAtLocalY(d.localPosition.dy);
                    widget.onNavigate(widget.anchors[index]);
                  },
                  onLongPressStart: (d) {
                    setState(() => _scrubbing = true);
                    _setPreviewFromLocalY(d.localPosition.dy);
                  },
                  onLongPressMoveUpdate: (d) =>
                      _setPreviewFromLocalY(d.localPosition.dy),
                  onLongPressEnd: (_) => _commitPreview(),
                  onLongPressCancel: () {
                    // 手势被抢走：清掉预览，不落点。
                    if (_previewTurn != null || _scrubbing) {
                      setState(() {
                        _previewTurn = null;
                        _scrubbing = false;
                      });
                    }
                  },
                  child: _buildTickColumn(frameHeight, overflow),
                ),
              ),
              if (preview != null)
                _buildPreview(
                  context: context,
                  anchor: preview,
                  frameHeight: frameHeight,
                ),
            ],
          ),
        );
      },
    );
  }

  Widget _buildTickColumn(double frameHeight, bool overflow) {
    final column = SingleChildScrollView(
      controller: _railCtrl,
      physics: const ClampingScrollPhysics(),
      child: SizedBox(
        height: _contentHeight,
        child: Column(
          children: [
            const SizedBox(height: _kRailInset),
            for (final anchor in widget.anchors)
              SizedBox(
                key: ValueKey<String>('turn-tick-${anchor.turn}'),
                height: _kTickPitch,
                child: Align(
                  alignment: Alignment.centerRight,
                  child: _TickBar(
                    active: anchor.turn == widget.activeTurn,
                    busy: anchor.turn == widget.busyTurn,
                    previewed: anchor.turn == _previewTurn,
                    pulse: _pulse,
                  ),
                ),
              ),
            const SizedBox(height: _kRailInset),
          ],
        ),
      ),
    );
    if (!overflow) return column;
    // 可滚动时在两端做渐隐，提示"上面/下面还有刻度"。
    return ShaderMask(
      shaderCallback: (rect) => const LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [Colors.transparent, Colors.black, Colors.black, Colors.transparent],
        stops: [0.0, _kFadeBand / 100, 1 - _kFadeBand / 100, 1.0],
      ).createShader(rect),
      blendMode: BlendMode.dstIn,
      child: column,
    );
  }

  Widget _buildPreview({
    required BuildContext context,
    required TurnAnchor anchor,
    required double frameHeight,
  }) {
    final index = widget.anchors.indexWhere((a) => a.turn == anchor.turn);
    final offset = _railCtrl.hasClients ? _railCtrl.offset : 0.0;
    // 气泡竖直中心对齐被预览的刻度，并夹在轨道范围内（与电脑端同构）。
    const bubbleHeight = 96.0;
    final center = _kRailInset + index * _kTickPitch + _kTickPitch / 2 - offset;
    final maxTop = math.max(0.0, frameHeight - bubbleHeight);
    final top = (center - bubbleHeight / 2).clamp(0.0, maxTop).toDouble();

    // 空提示词（纯图片/纯命令轮）回退为「第 N 轮」，不让气泡看起来像坏数据。
    final prompt = anchor.prompt.isEmpty
        ? L10n.t('第 ${anchor.turn} 轮', 'Turn ${anchor.turn}')
        : anchor.prompt;

    return Positioned(
      top: top,
      right: widget.width + 10,
      width: math.min(_kPreviewMaxWidth, MediaQuery.sizeOf(context).width - 120),
      child: IgnorePointer(
        child: Material(
          elevation: 8,
          borderRadius: BorderRadius.circular(12),
          color: DshColors.surface(context),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  prompt,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                ),
                if (anchor.response.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    anchor.response,
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12,
                      height: 1.35,
                      color: DshColors.ink3(context),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 单个刻度：20×2 圆角横条，右对齐；按状态改变长度与明暗。
class _TickBar extends StatelessWidget {
  const _TickBar({
    required this.active,
    required this.busy,
    required this.previewed,
    required this.pulse,
  });

  final bool active;
  final bool busy;
  final bool previewed;
  final Animation<double> pulse;

  @override
  Widget build(BuildContext context) {
    final Color base = active
        ? DshColors.ink(context)
        : previewed
            ? DshColors.ink2(context)
            : DshColors.ink3(context).withValues(alpha: 0.55);
    // 当前轮最长最亮；被预览的次之；其余短而淡（见 ADR 0018 的刻度态说明）。
    final double scale = active
        ? 1.0
        : previewed
            ? 0.9
            : 0.6;

    Widget bar = Container(
      width: _kBarWidth * scale,
      height: _kBarHeight,
      decoration: BoxDecoration(
        color: base,
        borderRadius: BorderRadius.circular(2),
      ),
    );
    if (busy) {
      // 跳转进行中：脉冲，避免长翻页期间看起来像没响应。
      bar = FadeTransition(opacity: pulse, child: bar);
    }
    return bar;
  }
}
