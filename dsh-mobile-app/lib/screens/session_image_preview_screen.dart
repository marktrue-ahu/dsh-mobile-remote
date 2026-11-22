// issue #157：会话文件图片全屏预览。
//
// 只读取 `/workspace-image`（sessionId + cwd 相对路径）；宿主负责 session 作用域、
// realpath/O_NOFOLLOW、magic/尺寸/字节上限与 ETag。App 只负责显示、缩放/平移、
// 双击、解码降采样、缓存与错误态；列表不预加载图片。
//
// 视觉/交互复用图库壳（`widgets/image_viewer_shell.dart`，设计稿 §7.6 要求「复用
// 图库壳，不要复制第二套 viewer」）：黑底全屏、顶部关闭/文件名/下载、InteractiveViewer
// 0.5–4x + 双击、加载/失败/不支持状态面板、底部元信息条。本文件只保留**取数 +
// 会话文件特有的元信息**（格式/宽×高/大小/相对路径，不显示 EXIF）。
import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../api.dart';
import '../image_preview_logic.dart';
import '../l10n.dart';
import '../session_image_cache.dart';
import '../toast.dart';
import '../widgets/image_viewer_shell.dart';

class SessionImagePreviewScreen extends StatefulWidget {
  const SessionImagePreviewScreen({
    super.key,
    required this.api,
    required this.sessionId,
    required this.name,
    required this.relativePath,
    this.unsupportedReason,
    this.onDownload,
    this.selectResult,
    this.cache,
  });

  final Api api;
  final String sessionId;
  final String name;

  /// 会话工作目录相对路径（`/workspace-image` 的 path）。
  final String relativePath;

  /// 非空表示不请求图片（SVG/HEIC/AVIF）：查看器直接给出该原因的不可预览提示。
  final String? unsupportedReason;

  /// 复用 #138 单文件下载；不可用（如选择模式）时为 null，按钮隐藏。
  final Future<void> Function()? onDownload;

  /// 非 null 表示给调用方当**文件选择器**用（文件历史「选择文件」）：显示
  /// 「选择此文件」按钮，点按以该值 pop 回调用方。
  ///
  /// 图片查看器没有文本查看器那样的"选中"语义，若不给这个入口，选择模式下点
  /// 图片会走进一个只能关闭、选不中的死胡同。
  final String? selectResult;

  /// 测试注入；生产使用进程级 LRU。
  final SessionImageCache? cache;

  @override
  State<SessionImagePreviewScreen> createState() =>
      _SessionImagePreviewScreenState();
}

class _SessionImagePreviewScreenState extends State<SessionImagePreviewScreen> {
  late final SessionImageCache _cache;
  final TransformationController _transform = TransformationController();
  Uint8List? _bytes;
  String? _contentType;
  ({int width, int height})? _pixelSize;
  bool _loading = true;
  String? _errorKindCode;
  String? _errorReason;
  bool _downloading = false;

  @override
  void initState() {
    super.initState();
    _cache = widget.cache ?? SessionImageCache.instance;
    if ((widget.unsupportedReason ?? '').isNotEmpty) {
      _loading = false;
    } else {
      unawaited(_load());
    }
  }

  @override
  void dispose() {
    _transform.dispose();
    super.dispose();
  }

  String get _relativePath => widget.relativePath;

  Future<void> _load() async {
    if (!mounted) return;
    setState(() {
      _loading = true;
      _errorKindCode = null;
      _errorReason = null;
    });
    final cached = _relativePath.isEmpty
        ? null
        : _cache.lookup(widget.api, widget.sessionId, _relativePath);
    try {
      if (_relativePath.isEmpty) {
        // 拼不出会话 cwd 相对路径 → 不请求（不构造任意宿主路径）。
        throw ApiException('path-outside-workspace', code: 'path-outside-workspace');
      }
      final data = await widget.api.workspaceImage(
        widget.sessionId,
        _relativePath,
        ifNoneMatch: cached?.etag,
      );
      if (!mounted) return;
      if (data.notModified) {
        if (cached == null) {
          // 304 但本地无缓存（重启/清缓存后 ETag 仍被复用）：按缺失处理，可重试。
          setState(() {
            _loading = false;
            _errorKindCode = 'image-not-found';
          });
          return;
        }
        _applyImage(cached.bytes, cached.contentType);
        return;
      }
      final contentType = data.contentType;
      if (!_isDisplayableContentType(contentType)) {
        setState(() {
          _loading = false;
          _errorKindCode = 'unsupported-image-type';
          _errorReason = L10n.t(
            '此格式暂不支持预览，可下载原图',
            'This format is not previewable yet; download the original',
          );
        });
        return;
      }
      if (data.bytes.isEmpty) {
        setState(() {
          _loading = false;
          _errorKindCode = 'image-not-found';
        });
        return;
      }
      _cache.put(
        widget.api,
        widget.sessionId,
        _relativePath,
        CachedSessionImage(
          bytes: data.bytes,
          contentType: contentType,
          etag: data.etag,
          relativePath: _relativePath,
        ),
      );
      _applyImage(data.bytes, contentType);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _errorKindCode = e.code;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _errorKindCode = null;
      });
    }
  }

  void _applyImage(Uint8List bytes, String? contentType) {
    if (!mounted) return;
    setState(() {
      _bytes = bytes;
      _contentType = contentType;
      _pixelSize = imagePixelSize(bytes);
      _loading = false;
      _errorKindCode = null;
      _errorReason = null;
    });
  }

  bool _isDisplayableContentType(String? contentType) {
    final type = (contentType ?? '').split(';').first.trim().toLowerCase();
    return type == 'image/png' ||
        type == 'image/jpeg' ||
        type == 'image/webp' ||
        type == 'image/gif' ||
        // 旧宿主/测试桩可能不带 content-type；以扩展名兜底，宿主已做 magic 校验。
        (type.isEmpty && isSupportedImagePreviewName(widget.name));
  }

  Future<void> _download() async {
    final callback = widget.onDownload;
    if (callback == null || _downloading) return;
    setState(() => _downloading = true);
    try {
      await callback();
      if (!mounted) return;
      // 全屏路由会盖住根 messenger 的 SnackBar，提示落在本页 Scaffold 内才可见。
      showToast(context, L10n.t('已开始下载原图', 'Downloading the original image'));
    } catch (e) {
      if (!mounted) return;
      showToast(context, '${L10n.t('下载失败：', 'Download failed: ')}$e');
    } finally {
      if (mounted) setState(() => _downloading = false);
    }
  }

  void _retry() {
    _transform.value = Matrix4.identity();
    unawaited(_load());
  }

  @override
  Widget build(BuildContext context) {
    final unsupported = (widget.unsupportedReason ?? '').isNotEmpty;
    return ImageViewerShell(
      scaffoldKey: const Key('sf-image-preview'),
      closeKey: const Key('sf-image-close'),
      title: Text(
        widget.name,
        key: const Key('sf-image-name'),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(color: Colors.white, fontSize: 14),
      ),
      actions: [
        if (widget.onDownload != null) _downloadAction(),
        if (widget.selectResult != null) _selectAction(),
      ],
      meta: _bytes == null ? null : _metaLine(),
      metaKey: const Key('sf-image-meta'),
      metaMaxLines: 2,
      toolbarColor: Colors.black,
      body: unsupported
          ? ImageViewerStatePane(
              key: const Key('sf-image-unsupported'),
              icon: Icons.image_not_supported_outlined,
              iconSize: 44,
              title: widget.unsupportedReason!,
              titleSize: 14,
              message: L10n.t(
                '可下载原图后使用其他应用查看',
                'Download the original to open it in another app',
              ),
            )
          : _body(),
    );
  }

  /// 选择模式下的「选择此文件」：把调用方给的绝对路径 pop 回去（与文本查看器
  /// 的 `sf-history` 确认选择同一语义）。
  Widget _selectAction() {
    return IconButton(
      key: const Key('sf-image-select'),
      tooltip: L10n.t('选择此文件', 'Choose this file'),
      icon: const Icon(Icons.check, color: Colors.white),
      onPressed: () => Navigator.of(context).pop(widget.selectResult),
    );
  }

  Widget _downloadAction() {
    return IconButton(
      key: const Key('sf-image-download'),
      tooltip: L10n.t('下载原图', 'Download original'),
      onPressed: _downloading ? null : _download,
      icon: _downloading
          ? const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: Colors.white,
              ),
            )
          : const Icon(Icons.download_outlined, color: Colors.white),
    );
  }

  Widget _body() {
    if (_loading) {
      return ImageViewerStatePane(
        key: const Key('sf-image-loading'),
        icon: Icons.image_outlined,
        iconSize: 44,
        loading: true,
        title: L10n.t('正在加载图片…', 'Loading image…'),
        titleSize: 14,
        message: L10n.t('图片较大时会按视口降采样', 'Large images are downsampled'),
      );
    }
    if (_errorKindCode != null || _errorReason != null) {
      final kind = imagePreviewErrorKind(_errorKindCode);
      return ImageViewerStatePane(
        key: const Key('sf-image-error'),
        icon: Icons.broken_image_outlined,
        iconSize: 44,
        title: _errorReason ?? _errorTitle(kind),
        titleSize: 14,
        message: _errorHint(kind),
        onRetry: _retry,
        retryKey: const Key('sf-image-retry'),
      );
    }
    final bytes = _bytes;
    if (bytes == null) {
      return ImageViewerStatePane(
        key: const Key('sf-image-error'),
        icon: Icons.image_not_supported_outlined,
        iconSize: 44,
        title: L10n.t('无法预览此图片', 'Cannot preview this image'),
        titleSize: 14,
        onRetry: _retry,
        retryKey: const Key('sf-image-retry'),
      );
    }
    return LayoutBuilder(
      builder: (context, constraints) {
        final cacheWidth = _decodeWidth(
          constraints.maxWidth,
          MediaQuery.devicePixelRatioOf(context),
        );
        return ImageViewerZoom(
          viewerKey: const Key('sf-image-viewer'),
          controller: _transform,
          child: SizedBox.expand(
            child: Image.memory(
              bytes,
              key: const Key('sf-image-image'),
              fit: BoxFit.contain,
              // GIF 按原始尺寸解码：动图逐帧缩放会让内存/动画都更不稳定，
              // 且设计稿要求动图自动播放。
              cacheWidth: imageFormatLabel(_contentType, widget.name) == 'GIF'
                  ? null
                  : cacheWidth,
              gaplessPlayback: true,
              semanticLabel: L10n.t(
                '查看图片 ${widget.name}',
                'Image ${widget.name}',
              ),
              errorBuilder: (context, error, stack) => ImageViewerStatePane(
                key: const Key('sf-image-decode-error'),
                icon: Icons.broken_image_outlined,
                iconSize: 44,
                title: L10n.t('无法解码此图片', 'Cannot decode this image'),
                titleSize: 14,
                message: L10n.t(
                  '可下载原图后使用其他应用查看',
                  'Download the original instead',
                ),
                onRetry: _retry,
                retryKey: const Key('sf-image-retry'),
              ),
            ),
          ),
        );
      },
    );
  }

  /// 解码宽度上限：按**视口物理宽度 2 倍**（兼顾放大到 2x 仍清晰）并封顶 4096。
  ///
  /// 返回 null 表示不降采样（图片本身不超过上限时按原始分辨率解码）。
  int? _decodeWidth(double viewportWidth, double dpr) {
    final cap = math.min(4096, math.max(512, (viewportWidth * dpr * 2).round()));
    final size = _pixelSize;
    if (size == null) return cap;
    return size.width <= cap ? null : cap;
  }

  String _metaLine() {
    final format = imageFormatLabel(_contentType, widget.name);
    final dimensions = _pixelSize == null
        ? ''
        : '${_pixelSize!.width}×${_pixelSize!.height}';
    return <String>[
      if (format.isNotEmpty) format,
      if (dimensions.isNotEmpty) dimensions,
      _formatBytes(_bytes?.length ?? 0),
      if (widget.relativePath.isNotEmpty) widget.relativePath,
      if (format == 'GIF') L10n.t('GIF 动图会自动播放', 'GIF animates automatically'),
    ].join(' · ');
  }

  static String _formatBytes(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KiB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MiB';
  }

  String _errorTitle(ImagePreviewErrorKind kind) => switch (kind) {
    ImagePreviewErrorKind.tooLarge => L10n.t(
      '图片过大，无法预览',
      'Image too large to preview',
    ),
    ImagePreviewErrorKind.unsupported => L10n.t(
      '此格式暂不支持预览',
      'This format is not previewable yet',
    ),
    ImagePreviewErrorKind.missing => L10n.t(
      '文件为空或已被删除',
      'File is empty or deleted',
    ),
    ImagePreviewErrorKind.accessDenied => L10n.t(
      '无法访问该图片',
      'Cannot access this image',
    ),
    ImagePreviewErrorKind.verificationUnavailable => L10n.t(
      '当前电脑端无法安全校验图片',
      'This host cannot safely verify images',
    ),
    ImagePreviewErrorKind.unknown => L10n.t(
      '无法预览此图片',
      'Cannot preview this image',
    ),
  };

  String _errorHint(ImagePreviewErrorKind kind) => switch (kind) {
    ImagePreviewErrorKind.tooLarge => L10n.t(
      '可下载原图后使用其他应用查看',
      'Download the original to view it in another app',
    ),
    ImagePreviewErrorKind.unsupported => L10n.t(
      '可下载原图后使用其他应用查看',
      'Download the original to view it in another app',
    ),
    ImagePreviewErrorKind.missing => L10n.t(
      '请返回刷新文件列表',
      'Go back and refresh the file list',
    ),
    ImagePreviewErrorKind.accessDenied => L10n.t(
      '图片必须位于当前会话工作目录内',
      'Images must stay inside this session workspace',
    ),
    ImagePreviewErrorKind.verificationUnavailable => L10n.t(
      '请更新电脑端插件后重试',
      'Update the host plugin and retry',
    ),
    ImagePreviewErrorKind.unknown => L10n.t(
      '可点重试；仍失败可下载原图',
      'Retry, or download the original if it keeps failing',
    ),
  };
}
