// issue #157：会话文件图片预览的纯逻辑（无 Flutter/HTTP 依赖，便于单测）。
//
// 只负责格式识别、头部尺寸解析与错误码归一；读取/安全校验全部由宿主
// `/workspace-image` 完成（sessionId + cwd 相对路径 + realpath/O_NOFOLLOW）。
import 'dart:typed_data';

/// 首版真正支持预览的格式（与宿主 IMAGE_EXTENSIONS 同源）。
const Set<String> kSupportedImageExtensions = {
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
};

/// 首版明确不支持、但应在列表/查看器给出明确提示的图片格式。
const Set<String> kUnsupportedImageExtensions = {'svg', 'heic', 'heif', 'avif'};

String _extensionOf(String name) {
  final dot = name.lastIndexOf('.');
  if (dot < 0 || dot == name.length - 1) return '';
  return name.substring(dot + 1).toLowerCase();
}

bool isSupportedImagePreviewName(String name) =>
    kSupportedImageExtensions.contains(_extensionOf(name));

bool isUnsupportedImagePreviewName(String name) =>
    kUnsupportedImageExtensions.contains(_extensionOf(name));

String imageFormatLabel(String? contentType, String name) {
  final type = (contentType ?? '').split(';').first.trim().toLowerCase();
  return switch (type) {
    'image/png' => 'PNG',
    'image/jpeg' => 'JPEG',
    'image/webp' => 'WebP',
    'image/gif' => 'GIF',
    _ => _extensionOf(name).toUpperCase(),
  };
}

/// 从 PNG/JPEG/GIF/WebP 文件头解析像素尺寸；解析不到返回 null。
///
/// 与宿主 `imageDimensions` 保持同一口径，避免 App 展示与服务端限制不一致。
({int width, int height})? imagePixelSize(Uint8List bytes) {
  if (bytes.length < 12) return null;
  // PNG: signature + IHDR width/height at offset 16/20.
  if (bytes.length >= 24 &&
      bytes[0] == 0x89 &&
      bytes[1] == 0x50 &&
      bytes[2] == 0x4e &&
      bytes[3] == 0x47 &&
      bytes[4] == 0x0d &&
      bytes[5] == 0x0a &&
      bytes[6] == 0x1a &&
      bytes[7] == 0x0a) {
    final width = _u32be(bytes, 16);
    final height = _u32be(bytes, 20);
    return width > 0 && height > 0 ? (width: width, height: height) : null;
  }
  // GIF: GIF87a/GIF89a + little-endian width/height.
  final ascii6 = String.fromCharCodes(bytes.sublist(0, 6));
  if (bytes.length >= 10 && (ascii6 == 'GIF87a' || ascii6 == 'GIF89a')) {
    final width = bytes[6] | (bytes[7] << 8);
    final height = bytes[8] | (bytes[9] << 8);
    return width > 0 && height > 0 ? (width: width, height: height) : null;
  }
  // WebP: RIFF....WEBP + VP8X/VP8/VP8L chunk.
  if (bytes.length >= 30 &&
      String.fromCharCodes(bytes.sublist(0, 4)) == 'RIFF' &&
      String.fromCharCodes(bytes.sublist(8, 12)) == 'WEBP') {
    final chunk = String.fromCharCodes(bytes.sublist(12, 16));
    if (chunk == 'VP8X') {
      final width = 1 + _u24le(bytes, 24);
      final height = 1 + _u24le(bytes, 27);
      return (width: width, height: height);
    }
    if (chunk == 'VP8 ') {
      final width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
      final height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
      return width > 0 && height > 0 ? (width: width, height: height) : null;
    }
    if (chunk == 'VP8L' && bytes.length >= 25) {
      final b =
          bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      return (width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1);
    }
  }
  // JPEG: scan markers until SOF0–SOF15 (excluding DHT/JPG/DAC).
  if (bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff) {
    var i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] != 0xff) return null;
      final marker = bytes[i + 1];
      final length = (bytes[i + 2] << 8) | bytes[i + 3];
      if (length < 2) return null;
      if (marker >= 0xc0 &&
          marker <= 0xcf &&
          marker != 0xc4 &&
          marker != 0xc8 &&
          marker != 0xcc) {
        final height = (bytes[i + 5] << 8) | bytes[i + 6];
        final width = (bytes[i + 7] << 8) | bytes[i + 8];
        return width > 0 && height > 0 ? (width: width, height: height) : null;
      }
      i += 2 + length;
    }
  }
  return null;
}

int _u32be(Uint8List b, int o) =>
    (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];

int _u24le(Uint8List b, int o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

/// 稳定错误码 → UI 语义；未知码回退 [ImagePreviewErrorKind.unknown]。
enum ImagePreviewErrorKind {
  tooLarge,
  unsupported,
  missing,
  accessDenied,
  verificationUnavailable,
  unknown,
}

ImagePreviewErrorKind imagePreviewErrorKind(String? code) {
  return switch (code) {
    'image-too-large' => ImagePreviewErrorKind.tooLarge,
    'unsupported-image-type' => ImagePreviewErrorKind.unsupported,
    'image-not-found' => ImagePreviewErrorKind.missing,
    'consent-required' ||
    'consent-invalid' ||
    'path-outside-workspace' ||
    'workspace-not-authorized' ||
    'workspace-not-found' ||
    'session-not-found' => ImagePreviewErrorKind.accessDenied,
    'image-verification-unavailable' =>
      ImagePreviewErrorKind.verificationUnavailable,
    _ => ImagePreviewErrorKind.unknown,
  };
}
