// 应用日志：关键事件写入本地文件 + 内存环形缓冲，设置页可查看/复制/清空。
// 用途：排查"加载不出来/连接异常"等问题（release 无控制台输出时唯一手段）。
//
// issue #136：日志级别（debug/info/warn/error）。
// issue #154：把「记录级别」与日志页「显示筛选」拆开：
//   - [level]（`app_log_level`）是写入阈值：低于它的日志不写文件/内存；
//   - [displayPrefsKey] 只记住日志页显示筛选，绝不参与写入判断、也不改 [level]。
// 旧日志文件无级别行仍可读取，按 info 处理；文件路径、15 天清理、256KB 截断、800 行
// 缓冲语义保持不变。
import 'dart:io';

import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

enum AppLogLevel {
  debug(0, 'DEBUG'),
  info(1, 'INFO'),
  warn(2, 'WARN'),
  error(3, 'ERROR');

  const AppLogLevel(this.rank, this.label);
  final int rank;
  final String label;

  static AppLogLevel? tryParse(String? raw) {
    final value = raw?.trim().toLowerCase();
    for (final level in values) {
      if (level.name == value) return level;
    }
    return null;
  }
}

/// 一行日志的解析结果（level + 原文）。旧格式无级别 → info，且 [hasLevel] false。
class AppLogEntry {
  const AppLogEntry({
    required this.raw,
    required this.level,
    required this.hasLevel,
  });

  final String raw;
  final AppLogLevel level;
  final bool hasLevel;
}

final RegExp _newLogPrefix = RegExp(
  r'^\[\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?\] \[(DEBUG|INFO|WARN|ERROR)\] ?(.*)$',
);

class AppLog {
  AppLog._();
  static final AppLog instance = AppLog._();

  static const prefsKey = 'app_log_level';
  static const defaultLevel = AppLogLevel.info;

  /// 日志页「显示筛选」偏好：只影响查看，与 [prefsKey]/[level] 完全分开。
  static const displayPrefsKey = 'app_log_display_level';
  static const defaultDisplayLevel = AppLogLevel.info;

  final List<String> _buf = [];
  File? _file;
  static const _maxBuf = 800;

  /// 日志文件体积近似计账（不每行 stat——移动端 flash 上每行 stat+fsync 会让 SSE 流式期间掉帧）
  int _approxBytes = 0;

  /// 日志保留天数（默认 15 天）：文件最后写入时间超过该期限，启动时清空。
  static const _keepDays = 15;

  AppLogLevel _level = defaultLevel;
  AppLogLevel get level => _level;

  /// 启动时调用：加载持久化级别、定位日志文件（应用文档目录 dsh_mobile.log），并做过期清理。
  Future<void> init() async {
    await loadLevel();
    try {
      final dir = await getApplicationDocumentsDirectory();
      final f = File('${dir.path}/dsh_mobile.log');
      // 默认 15 天清理一次：上次写日志距今超过保留期 → 清空（保留文件避免重建权限问题）
      try {
        if (await f.exists()) {
          final age = DateTime.now().difference(await f.lastModified());
          if (age.inDays >= _keepDays) {
            await f.writeAsString('');
          }
          _approxBytes = (await f.length()).toInt();
        }
      } catch (_) {
        // 清理失败不影响日志功能
      }
      _file = f;
      log('==== App 启动 ====');
    } catch (_) {
      // 无文件系统权限时仅内存日志
    }
  }

  /// 读取持久化级别；失败/非法值回退 info（不影响日志可用性）。
  Future<void> loadLevel() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      _level = AppLogLevel.tryParse(prefs.getString(prefsKey)) ?? defaultLevel;
    } catch (_) {
      _level = defaultLevel;
    }
  }

  /// 持久化并立即切换记录级别；失败返回错误文案且保持原级别（调用方 toast）。
  Future<String?> setLevel(AppLogLevel level) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final ok = await prefs.setString(prefsKey, level.name);
      if (!ok) return '偏好写入失败';
      _level = level;
      return null;
    } catch (e) {
      return '$e';
    }
  }

  /// 读取日志页显示筛选；失败/非法值回退 [defaultDisplayLevel]。
  ///
  /// 只读 [displayPrefsKey]，不改变 [level]，也不影响后续写入阈值。
  Future<AppLogLevel> loadDisplayLevel() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return AppLogLevel.tryParse(prefs.getString(displayPrefsKey)) ??
          defaultDisplayLevel;
    } catch (_) {
      return defaultDisplayLevel;
    }
  }

  /// 只持久化日志页显示筛选；失败返回错误文案。
  ///
  /// 明确不修改 [level]/[prefsKey]：显示筛选不是记录级别。
  Future<String?> setDisplayLevel(AppLogLevel level) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final ok = await prefs.setString(displayPrefsKey, level.name);
      if (!ok) return '偏好写入失败';
      return null;
    } catch (e) {
      return '$e';
    }
  }

  /// 默认 info 级别（兼容既有调用点；不改所有调用方）。
  void log(String msg) => info(msg);

  void debug(String msg) => _write(AppLogLevel.debug, msg);
  void info(String msg) => _write(AppLogLevel.info, msg);
  void warn(String msg) => _write(AppLogLevel.warn, msg);
  void error(String msg) => _write(AppLogLevel.error, msg);

  void _write(AppLogLevel level, String msg) {
    if (level.rank < _level.rank) return;
    final line =
        '[${DateTime.now().toString().substring(5, 23)}] [${level.label}] $msg';
    _buf.add(line);
    if (_buf.length > _maxBuf) _buf.removeAt(0);
    // print 在 release 下也会进入 logcat（tag=flutter），便于 adb 抓取排障
    // ignore: avoid_print
    print(line);
    final f = _file;
    if (f == null) return;
    try {
      // v3.0.0：去 flush:true——同步 append 保留（日志有序、不丢行），但 fsync 每行一次
      // 在 SSE chunk 高频路径上会显著掉帧；尺寸用近似记账，超限时才做一次全量截断。
      f.writeAsStringSync('$line\n', mode: FileMode.append);
      _approxBytes += line.length + 1;
      // 控制体积：超过 256KB 截断保留后半
      if (_approxBytes > 256 * 1024) {
        final lines = f.readAsLinesSync();
        f.writeAsStringSync('${lines.sublist(lines.length ~/ 2).join('\n')}\n');
        _approxBytes = lines.length ~/ 2 * 16; // 截半后的近似值（仅用于下一轮截断判定）
      }
    } catch (_) {
      // 日志失败不影响功能
    }
  }

  /// 当前内存中的日志（最新在后）
  List<String> get lines => List.of(_buf);

  /// 完整日志文本（文件内容，空则用内存）
  Future<String> readAll() async {
    try {
      final f = _file;
      if (f != null && await f.exists()) return await f.readAsString();
    } catch (_) {}
    return _buf.join('\n');
  }

  Future<void> clear() async {
    _buf.clear();
    try {
      await _file?.writeAsString('');
    } catch (_) {}
  }

  /// 解析日志文本：新格式取 `[LEVEL]`，旧格式/未知级别按 info 且 hasLevel=false。
  static List<AppLogEntry> parseLines(String text) {
    final out = <AppLogEntry>[];
    for (final raw in text.split('\n')) {
      if (raw.isEmpty) continue;
      final match = _newLogPrefix.firstMatch(raw);
      if (match != null) {
        final level = AppLogLevel.tryParse(match.group(1)) ?? AppLogLevel.info;
        out.add(AppLogEntry(raw: raw, level: level, hasLevel: true));
      } else {
        out.add(
          AppLogEntry(raw: raw, level: AppLogLevel.info, hasLevel: false),
        );
      }
    }
    return out;
  }

  /// 阈值过滤（`>=`）；旧格式按 info。
  static List<AppLogEntry> filterEntries(
    List<AppLogEntry> entries,
    AppLogLevel level,
  ) => entries.where((entry) => entry.level.rank >= level.rank).toList();
}
