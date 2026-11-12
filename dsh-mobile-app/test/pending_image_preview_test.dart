// issue #85：待上传图片本地全屏预览。
import 'dart:convert';
import 'dart:io';

import 'package:dsh_mobile_app/pending_image_preview.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

void main() {
  late Directory tempDir;
  late String firstPath;
  late String secondPath;

  setUpAll(() async {
    tempDir = await Directory.systemTemp.createTemp('pending-image-test-');
    firstPath = '${tempDir.path}/first.png';
    secondPath = '${tempDir.path}/second.png';
    final bytes = base64Decode(_pngBase64);
    await File(firstPath).writeAsBytes(bytes);
    await File(secondPath).writeAsBytes(bytes);
  });

  tearDownAll(() async {
    await tempDir.delete(recursive: true);
  });

  testWidgets('多图：打开指定序号并显示页码', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: PendingImagePreviewScreen(
        paths: [firstPath, secondPath],
        initialIndex: 1,
      ),
    ));
    await tester.pumpAndSettle();

    expect(find.text('2 / 2'), findsOneWidget);
    expect(find.byIcon(Icons.close), findsOneWidget);
    expect(find.byType(Image), findsWidgets);

  });

  testWidgets('空列表给出明确提示', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: PendingImagePreviewScreen(paths: []),
    ));
    await tester.pumpAndSettle();
    expect(find.text('没有可预览的图片'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
