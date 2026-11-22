// issue #157：图片查看器的共享壳（视觉/交互只定义一次，两处复用）。
//
// 复用方：
//   - `image_gallery.dart` 的 `ImageGalleryViewer`（附件图库：多图 PageView + N/M）；
//   - `screens/session_image_preview_screen.dart`（会话文件图片：单图 + 相对路径）。
//
// 两者的**字节来源不同**（图库走 `/attachment` + attachmentId，会话文件走
// `/workspace-image` + sessionId/相对路径），但查看器外壳完全相同：黑底全屏、
// 顶部关闭/标题/动作、InteractiveViewer 0.5–4x + 双击、加载/失败/不支持状态面板、
// 底部元信息条。设计稿 §7.6 明确要求「复用图库壳，不要复制第二套 viewer」。
//
// 这里只放**与数据来源无关**的部分；分页、取数、缓存、保存/分享通道仍由各自页面
// 负责（图库的 PageView 手势状态机与 SessionFileDownloadController 都不搬进来）。

import 'package:flutter/material.dart';

import '../l10n.dart';

/// 查看器缩放上下限（设计稿 §7：0.5–4x，与图库既有行为一致）。
const double imageViewerMinScale = 0.5;
const double imageViewerMaxScale = 4;

/// 双击放大倍数（再次双击复位）。
const double imageViewerDoubleTapScale = 2;

/// 双击缩放：已放大 → 复位；未放大 → 以视口中心放大 [imageViewerDoubleTapScale]。
///
/// 纯函数式变换，便于单测锁定「双击复位/放大」语义。
void toggleImageViewerZoom(
  TransformationController controller,
  Size viewport,
) {
  if (controller.value.getMaxScaleOnAxis() > 1.01) {
    controller.value = Matrix4.identity();
    return;
  }
  final cx = viewport.width / 2;
  final cy = viewport.height / 2;
  controller.value = Matrix4.identity()
    ..translateByDouble(cx, cy, 0, 1)
    ..scaleByDouble(
      imageViewerDoubleTapScale,
      imageViewerDoubleTapScale,
      imageViewerDoubleTapScale,
      1,
    )
    ..translateByDouble(-cx, -cy, 0, 1);
}

/// 查看器缩放层：InteractiveViewer 0.5–4x，可选双击放大/复位。
///
/// [viewerKey] 落在 `InteractiveViewer` 自身上（既有测试按这个 key 读取
/// `transformationController`，不能提到外层）。
class ImageViewerZoom extends StatelessWidget {
  const ImageViewerZoom({
    super.key,
    required this.controller,
    required this.child,
    this.viewerKey,
    this.enableDoubleTap = true,
  });

  final TransformationController controller;
  final Widget child;
  final Key? viewerKey;

  /// 图库与会话文件预览都开启双击（设计稿 §7.3）；置 false 可保留纯捏合缩放。
  final bool enableDoubleTap;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final viewer = InteractiveViewer(
          key: viewerKey,
          transformationController: controller,
          minScale: imageViewerMinScale,
          maxScale: imageViewerMaxScale,
          child: child,
        );
        if (!enableDoubleTap) return viewer;
        return GestureDetector(
          onDoubleTap: () =>
              toggleImageViewerZoom(controller, constraints.biggest),
          child: viewer,
        );
      },
    );
  }
}

/// 加载 / 失败 / 不支持格式的统一状态面板（黑底反色文字，垂直居中）。
///
/// 两处的差异只在图标与字号；文案、重试按钮语义一致。
class ImageViewerStatePane extends StatelessWidget {
  const ImageViewerStatePane({
    super.key,
    this.icon = Icons.broken_image_outlined,
    this.iconSize = 40,
    this.title,
    this.titleSize = 13,
    this.titleColor = Colors.white,
    this.message,
    this.messageSize = 12,
    this.loading = false,
    this.spinnerSize = 26,
    this.onRetry,
    this.retryKey,
    this.padding = const EdgeInsets.all(24),
  });

  /// null 表示不显示图标（纯文字面板，如图库的「图片不可用」）。
  final IconData? icon;
  final double iconSize;
  final String? title;
  final double titleSize;
  final Color titleColor;
  final String? message;
  final double messageSize;

  /// true 时图标位显示转圈（加载态）。
  final bool loading;
  final double spinnerSize;
  final VoidCallback? onRetry;
  final Key? retryKey;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    final titleText = title;
    final messageText = message;
    return Center(
      child: SingleChildScrollView(
        padding: padding,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (loading)
              SizedBox(
                width: spinnerSize,
                height: spinnerSize,
                child: const CircularProgressIndicator(
                  strokeWidth: 2,
                  color: Colors.white70,
                ),
              )
            else if (icon != null)
              Icon(icon, size: iconSize, color: Colors.white70),
            if (titleText != null && titleText.isNotEmpty) ...[
              if (loading || icon != null) const SizedBox(height: 12),
              Text(
                titleText,
                textAlign: TextAlign.center,
                style: TextStyle(color: titleColor, fontSize: titleSize),
              ),
            ],
            if (messageText != null && messageText.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                messageText,
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white70, fontSize: messageSize),
              ),
            ],
            if (onRetry != null) ...[
              const SizedBox(height: 12),
              TextButton.icon(
                key: retryKey,
                onPressed: onRetry,
                icon: const Icon(Icons.refresh, color: Colors.white),
                label: Text(
                  L10n.t('重试', 'Retry'),
                  style: const TextStyle(color: Colors.white),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// 全屏查看器骨架：黑底 Scaffold + 顶部工具栏 + 主体 + 底部元信息条。
///
/// 主体铺满（图片在工具栏/信息条下方延伸，保持沉浸感）；工具栏与信息条浮在其上。
/// [messengerKey] 非空时在内部包一层 `ScaffoldMessenger`——全屏不透明路由会盖住
/// App 根 messenger 的 SnackBar，查看器内的保存/分享/失败提示必须落在内部。
class ImageViewerShell extends StatelessWidget {
  const ImageViewerShell({
    super.key,
    required this.body,
    this.scaffoldKey,
    this.messengerKey,
    this.closeKey,
    this.closeTooltip,
    this.onClose,
    this.title,
    this.centerTitle = false,
    this.actions = const <Widget>[],
    this.meta,
    this.metaKey,
    this.metaMaxLines = 1,
    this.toolbarColor = const Color(0x73000000),
    this.metaColor = const Color(0x73000000),
  });

  /// 图片区域（铺满整个壳）。
  final Widget body;

  final Key? scaffoldKey;
  final GlobalKey<ScaffoldMessengerState>? messengerKey;
  final Key? closeKey;
  final String? closeTooltip;

  /// 默认 `Navigator.pop`；需要别的关闭语义时传入。
  final VoidCallback? onClose;

  /// 工具栏中段：图库放 `N/M`，会话文件放文件名（调用方自带 key/样式）。
  final Widget? title;
  final bool centerTitle;

  /// 右侧动作按钮（图库的保存/分享、会话文件的下载）。
  final List<Widget> actions;

  /// 底部元信息条文本；null 不显示。
  final String? meta;
  final Key? metaKey;
  final int metaMaxLines;

  final Color toolbarColor;
  final Color metaColor;

  @override
  Widget build(BuildContext context) {
    final scaffold = Scaffold(
      key: scaffoldKey,
      backgroundColor: Colors.black,
      body: SafeArea(
        child: Stack(
          children: [
            Positioned.fill(child: body),
            Positioned(top: 0, left: 0, right: 0, child: _buildToolbar(context)),
            if (meta != null)
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                child: _buildMetaBar(),
              ),
          ],
        ),
      ),
    );
    final messenger = messengerKey;
    if (messenger == null) return scaffold;
    return ScaffoldMessenger(key: messenger, child: scaffold);
  }

  Widget _buildToolbar(BuildContext context) {
    final label = title;
    final titleWidget = label == null
        ? const SizedBox.shrink()
        : (centerTitle ? Center(child: label) : label);
    return Container(
      color: toolbarColor,
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
      child: Row(
        children: [
          IconButton(
            key: closeKey,
            tooltip: closeTooltip ?? L10n.t('关闭', 'Close'),
            icon: const Icon(Icons.close, color: Colors.white),
            onPressed: onClose ?? () => Navigator.of(context).pop(),
          ),
          Expanded(child: titleWidget),
          ...actions,
        ],
      ),
    );
  }

  Widget _buildMetaBar() {
    return Container(
      width: double.infinity,
      color: metaColor,
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 10),
      child: Text(
        meta!,
        key: metaKey,
        maxLines: metaMaxLines,
        softWrap: metaMaxLines > 1,
        overflow: TextOverflow.ellipsis,
        textAlign: TextAlign.center,
        style: const TextStyle(color: Colors.white70, fontSize: 12),
      ),
    );
  }
}
