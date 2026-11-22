// issue #157：会话文件图片预览的纯逻辑单测。
//
// 覆盖：扩展名识别（支持/不支持/大写/无扩展名/边界）、格式短标签、
// PNG/JPEG/GIF/WebP(VP8X/VP8 /VP8L) 头部尺寸解析与损坏输入、稳定错误码归一。
//
// 这些函数是 App 与宿主 `imageDimensions`/`IMAGE_EXTENSIONS` 的同口径投影，
// 因此用真实字节（而不是伪造字段）锁定行为。

import 'dart:convert';
import 'dart:typed_data';

import 'package:dsh_mobile_app/image_preview_logic.dart';
import 'package:flutter_test/flutter_test.dart';

/// 合法 1x1 PNG（IHDR 16/20 = 1/1）。
final Uint8List _png1x1 = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4z8AAAAMBAQD3A0FDAAAAAElFTkSuQmCC',
);

/// 合法 1x1 GIF89a（小端宽高在 offset 6/8）。
final Uint8List _gif1x1 = base64Decode(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
);

/// 合法 1x1 WebP lossy（VP8 块）。
final Uint8List _webpVp8 = base64Decode(
  'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=',
);

/// 构造一个最小 WebP 容器：RIFF....WEBP + 指定 chunk 头 + payload。
Uint8List _webp(Uint8List chunk, List<int> payload, {int? riffSize}) {
  final bytes = <int>[
    ...ascii.encode('RIFF'),
    ...(riffSize ?? (4 + payload.length + 8)).toUint32le(),
    ...ascii.encode('WEBP'),
    ...chunk,
    ...payload.length.toUint32le(),
    ...payload,
  ];
  return Uint8List.fromList(bytes);
}

extension _U32Le on int {
  List<int> toUint32le() => [
    this & 0xff,
    (this >> 8) & 0xff,
    (this >> 16) & 0xff,
    (this >> 24) & 0xff,
  ];
}

/// VP8X：flags(4B) + 24bit 宽-1 + 24bit 高-1。
Uint8List _webpVp8x(int width, int height) {
  final w = width - 1;
  final h = height - 1;
  final payload = <int>[
    0x00, 0x00, 0x00, 0x00, // flags/reserved
    w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff,
    h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff,
  ];
  return _webp(Uint8List.fromList(ascii.encode('VP8X')), payload);
}

/// VP8L：signature(0x2f) + 14bit 宽-1 + 14bit 高-1（本例只写 4 字节 packed）。
///
/// 补齐到 10 字节：实现里的 WebP 分支要求整块 ≥ 30 字节（RIFF 头 + chunk 头 +
/// 足够读到 VP8X/VP8L 字段），过短按「不是 WebP」处理。
Uint8List _webpVp8l(int width, int height) {
  final packed =
      ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  final payload = <int>[
    0x2f,
    packed & 0xff,
    (packed >> 8) & 0xff,
    (packed >> 16) & 0xff,
    (packed >> 24) & 0xff,
    ...List<int>.filled(5, 0),
  ];
  return _webp(Uint8List.fromList(ascii.encode('VP8L')), payload);
}

/// JPEG：SOI + 一个 APP0(FFE0) 段 + SOF0(FFC0)，宽高在大端 offset。
Uint8List _jpeg(int width, int height) {
  Uint8List seg(int marker, List<int> payload) {
    final len = payload.length + 2;
    return Uint8List.fromList([
      0xff,
      marker,
      (len >> 8) & 0xff,
      len & 0xff,
      ...payload,
    ]);
  }

  final app0 = seg(0xe0, List<int>.filled(14, 0));
  final sof0 = seg(0xc0, [
    0x08, // precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01, // components
    0x01, 0x11, 0x00,
  ]);
  return Uint8List.fromList([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

void main() {
  group('扩展名识别', () {
    test('支持的格式（含大写与多点文件名）', () {
      for (final name in [
        'a.png',
        'a.PNG',
        'b.jpg',
        'b.JPEG',
        'c.webp',
        'd.gif',
        'archive.v2.final.PNG',
      ]) {
        expect(isSupportedImagePreviewName(name), isTrue, reason: name);
        expect(isUnsupportedImagePreviewName(name), isFalse, reason: name);
      }
    });

    test('已知不支持但应提示的格式', () {
      for (final name in ['a.svg', 'b.heic', 'c.HEIF', 'd.avif']) {
        expect(isUnsupportedImagePreviewName(name), isTrue, reason: name);
        expect(isSupportedImagePreviewName(name), isFalse, reason: name);
      }
    });

    test('其他文件/无扩展名/尾点/空串既非支持也非不支持', () {
      for (final name in [
        'readme.md',
        'a.txt',
        'noext',
        'trailing.',
        '',
        'dir.png/file.md',
      ]) {
        expect(isSupportedImagePreviewName(name), isFalse, reason: name);
        expect(isUnsupportedImagePreviewName(name), isFalse, reason: name);
      }
    });

    test('绝对路径与 Windows 路径按最后一段扩展名识别', () {
      expect(isSupportedImagePreviewName('/work/a.png'), isTrue);
      expect(isSupportedImagePreviewName(r'C:\work\a.jpg'), isTrue);
      expect(isUnsupportedImagePreviewName('/work/a.heic'), isTrue);
    });
  });

  group('imageFormatLabel', () {
    test('content-type 优先，忽略参数与大小写', () {
      expect(imageFormatLabel('image/png', 'a.png'), 'PNG');
      expect(imageFormatLabel('image/jpeg', 'a.jpg'), 'JPEG');
      expect(imageFormatLabel('IMAGE/JPEG; charset=binary', 'a.jpeg'), 'JPEG');
      expect(imageFormatLabel('image/webp', 'a.webp'), 'WebP');
      expect(imageFormatLabel('image/gif', 'a.gif'), 'GIF');
    });

    test('未知/缺失 content-type 回退扩展名大写', () {
      expect(imageFormatLabel(null, 'a.PNG'), 'PNG');
      expect(imageFormatLabel('', 'a.heic'), 'HEIC');
      expect(imageFormatLabel('application/octet-stream', 'a.svg'), 'SVG');
      expect(imageFormatLabel(null, 'noext'), '');
    });
  });

  group('imagePixelSize', () {
    test('PNG：IHDR 大端宽高', () {
      expect(imagePixelSize(_png1x1), (width: 1, height: 1));
      final bigger = Uint8List.fromList(_png1x1);
      // 覆盖宽=1920(0x780)、高=1080(0x438)
      bigger[16] = 0;
      bigger[17] = 0;
      bigger[18] = 0x07;
      bigger[19] = 0x80;
      bigger[20] = 0;
      bigger[21] = 0;
      bigger[22] = 0x04;
      bigger[23] = 0x38;
      expect(imagePixelSize(bigger), (width: 1920, height: 1080));
    });

    test('GIF：GIF87a/GIF89a 小端宽高', () {
      expect(imagePixelSize(_gif1x1), (width: 1, height: 1));
      final bigger = Uint8List.fromList(_gif1x1);
      bigger[6] = 0x40;
      bigger[7] = 0x01; // 320
      bigger[8] = 0xf0;
      bigger[9] = 0x00; // 240
      expect(imagePixelSize(bigger), (width: 320, height: 240));

      final gif87 = Uint8List.fromList(_gif1x1);
      gif87.setRange(0, 6, ascii.encode('GIF87a'));
      expect(imagePixelSize(gif87), (width: 1, height: 1));
    });

    test('WebP VP8：14bit 宽高（含缩放位掩码）', () {
      expect(imagePixelSize(_webpVp8), (width: 1, height: 1));
    });

    test('WebP VP8X：24bit 宽-1/高-1', () {
      expect(imagePixelSize(_webpVp8x(1920, 1080)), (
        width: 1920,
        height: 1080,
      ));
      expect(imagePixelSize(_webpVp8x(1, 1)), (width: 1, height: 1));
    });

    test('WebP VP8L：packed 14bit 宽高', () {
      expect(imagePixelSize(_webpVp8l(320, 240)), (width: 320, height: 240));
      expect(imagePixelSize(_webpVp8l(1, 1)), (width: 1, height: 1));
    });

    test('JPEG：跳过 APP0 段后读 SOF0 宽高', () {
      expect(imagePixelSize(_jpeg(1920, 1080)), (width: 1920, height: 1080));
      expect(imagePixelSize(_jpeg(1, 1)), (width: 1, height: 1));
    });

    test('JPEG：跳过 DHT/DAC 等非 SOF 段，命中 SOF2', () {
      Uint8List seg(int marker, List<int> payload) {
        final len = payload.length + 2;
        return Uint8List.fromList([
          0xff,
          marker,
          (len >> 8) & 0xff,
          len & 0xff,
          ...payload,
        ]);
      }

      final bytes = Uint8List.fromList([
        0xff,
        0xd8,
        ...seg(0xc4, List<int>.filled(8, 0)), // DHT：不是 SOF
        ...seg(0xc2, [
          0x08,
          0x01,
          0x40, // 320
          0x02,
          0x58, // 600
          0x01,
          0x01,
          0x11,
          0x00,
        ]),
        0xff,
        0xd9,
      ]);
      expect(imagePixelSize(bytes), (width: 600, height: 320));
    });

    test('过短/损坏/零尺寸一律 null（不抛异常）', () {
      expect(imagePixelSize(Uint8List(0)), isNull);
      expect(imagePixelSize(Uint8List(4)), isNull);
      expect(imagePixelSize(Uint8List.fromList(List<int>.filled(11, 0))), isNull);
      // PNG 签名但截断在 IHDR 之前
      expect(imagePixelSize(Uint8List.fromList(_png1x1.sublist(0, 12))), isNull);
      // PNG 宽高为 0
      final zeroPng = Uint8List.fromList(_png1x1);
      zeroPng[16] = 0;
      zeroPng[17] = 0;
      zeroPng[18] = 0;
      zeroPng[19] = 0;
      expect(imagePixelSize(zeroPng), isNull);
      // 未知 magic
      expect(
        imagePixelSize(Uint8List.fromList(ascii.encode('NOTANIMAGE!!!'))),
        isNull,
      );
      // JPEG 标称段长非法（<2）→ null 而不是越界
      final badJpeg = Uint8List.fromList([
        0xff,
        0xd8,
        0xff,
        0xe0,
        0x00,
        0x00,
        ...List<int>.filled(20, 0),
      ]);
      expect(imagePixelSize(badJpeg), isNull);
    });

    test('WebP 容器但 chunk 未知 → null', () {
      final unknown = _webp(
        Uint8List.fromList(ascii.encode('XXXX')),
        List<int>.filled(20, 0),
      );
      expect(imagePixelSize(unknown), isNull);
    });
  });

  group('imagePreviewErrorKind', () {
    test('稳定错误码映射', () {
      expect(
        imagePreviewErrorKind('image-too-large'),
        ImagePreviewErrorKind.tooLarge,
      );
      expect(
        imagePreviewErrorKind('unsupported-image-type'),
        ImagePreviewErrorKind.unsupported,
      );
      expect(
        imagePreviewErrorKind('image-not-found'),
        ImagePreviewErrorKind.missing,
      );
      expect(
        imagePreviewErrorKind('image-verification-unavailable'),
        ImagePreviewErrorKind.verificationUnavailable,
      );
    });

    test('授权/作用域类错误码统一归为 accessDenied', () {
      for (final code in [
        'consent-required',
        'consent-invalid',
        'path-outside-workspace',
        'workspace-not-authorized',
        'workspace-not-found',
        'session-not-found',
      ]) {
        expect(
          imagePreviewErrorKind(code),
          ImagePreviewErrorKind.accessDenied,
          reason: code,
        );
      }
    });

    test('未知/空/null 回退 unknown（不抛异常）', () {
      expect(imagePreviewErrorKind(null), ImagePreviewErrorKind.unknown);
      expect(imagePreviewErrorKind(''), ImagePreviewErrorKind.unknown);
      expect(imagePreviewErrorKind('boom'), ImagePreviewErrorKind.unknown);
      expect(imagePreviewErrorKind('IMAGE-TOO-LARGE'), ImagePreviewErrorKind.unknown,
          reason: '错误码大小写敏感（服务端固定小写）');
    });
  });
}
