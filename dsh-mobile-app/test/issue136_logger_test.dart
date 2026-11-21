// issue #136：AppLog 级别模型、写入阈值、旧格式解析与持久化。
import 'package:dsh_mobile_app/logger.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await AppLog.instance.clear();
    await AppLog.instance.setLevel(AppLogLevel.info);
  });

  test('默认 info：debug 不写入，info/warn/error 保留且带级别前缀', () async {
    AppLog.instance.debug('d');
    AppLog.instance.info('i');
    AppLog.instance.warn('w');
    AppLog.instance.error('e');
    final lines = AppLog.instance.lines;
    expect(lines, hasLength(3));
    expect(lines[0], contains('[INFO] i'));
    expect(lines[1], contains('[WARN] w'));
    expect(lines[2], contains('[ERROR] e'));
    expect(lines.join('\n'), isNot(contains('[DEBUG]')));
  });

  test('阈值 warn：仅 warn/error；error：仅 error；debug：全部', () async {
    await AppLog.instance.setLevel(AppLogLevel.warn);
    AppLog.instance.debug('d');
    AppLog.instance.info('i');
    AppLog.instance.warn('w');
    AppLog.instance.error('e');
    expect(
      AppLog.instance.lines.map(
        (l) => l.contains('[WARN]') || l.contains('[ERROR]'),
      ),
      everyElement(isTrue),
    );
    expect(AppLog.instance.lines, hasLength(2));

    await AppLog.instance.setLevel(AppLogLevel.error);
    AppLog.instance.clear();
    AppLog.instance.warn('w');
    AppLog.instance.error('e');
    expect(AppLog.instance.lines, hasLength(1));
    expect(AppLog.instance.lines.single, contains('[ERROR]'));

    await AppLog.instance.setLevel(AppLogLevel.debug);
    AppLog.instance.clear();
    AppLog.instance.debug('d');
    AppLog.instance.info('i');
    expect(AppLog.instance.lines, hasLength(2));
  });

  test('AppLog.log 兼容为 info', () async {
    AppLog.instance.log('legacy call');
    expect(AppLog.instance.lines.single, contains('[INFO] legacy call'));
  });

  test('旧格式无级别行按 info 解析；新格式识别级别', () {
    final entries = AppLog.parseLines(
      '[11-21 01:02:03.456] old line\n'
      '[11-21 01:02:03.456] [WARN] warn line\n'
      '[11-21 01:02:03.456] [DEBUG] debug line',
    );
    expect(entries, hasLength(3));
    expect(entries[0].hasLevel, isFalse);
    expect(entries[0].level, AppLogLevel.info);
    expect(entries[0].raw, '[11-21 01:02:03.456] old line');
    expect(entries[1].level, AppLogLevel.warn);
    expect(entries[1].hasLevel, isTrue);
    expect(entries[2].level, AppLogLevel.debug);
    expect(
      AppLog.filterEntries(entries, AppLogLevel.warn).map((e) => e.level),
      [AppLogLevel.warn],
    );
  });

  test('级别持久化并可在重启路径恢复；非法值回退 info', () async {
    expect(await AppLog.instance.setLevel(AppLogLevel.debug), isNull);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(AppLog.prefsKey), 'debug');

    SharedPreferences.setMockInitialValues({AppLog.prefsKey: 'warn'});
    await AppLog.instance.loadLevel();
    expect(AppLog.instance.level, AppLogLevel.warn);

    SharedPreferences.setMockInitialValues({AppLog.prefsKey: 'bogus'});
    await AppLog.instance.loadLevel();
    expect(AppLog.instance.level, AppLogLevel.info);
  });
}
