/// Safe display projection for the host-sanitized plugin update log.
class PluginUpdateLogLine {
  const PluginUpdateLogLine({required this.seq, required this.text});
  final int seq;
  final String text;

  static PluginUpdateLogLine? fromJson(Object? value) {
    if (value is! Map || value['seq'] is! int || value['text'] is! String) {
      return null;
    }
    final seq = value['seq'] as int;
    final text = (value['text'] as String).trimRight();
    if (seq < 1 || text.isEmpty) return null;
    return PluginUpdateLogLine(seq: seq, text: text);
  }
}

class PluginUpdateLog {
  const PluginUpdateLog({
    required this.opId,
    required this.phase,
    required this.lines,
    required this.cursor,
  });
  final String opId;
  final String phase;
  final List<PluginUpdateLogLine> lines;
  final int cursor;

  /// Older hosts may omit opId from a log page. Accept that legacy response,
  /// but never attach an explicitly different operation's output to this panel.
  static bool matchesOperation(Map<String, dynamic> json, String expectedOpId) {
    final responseOpId = json['opId'];
    return responseOpId == null || responseOpId == expectedOpId;
  }

  static PluginUpdateLog fromJson(Map<String, dynamic> json) {
    final events = json['events'];
    final lines = events is List
        ? events
              .map(PluginUpdateLogLine.fromJson)
              .whereType<PluginUpdateLogLine>()
              .toList()
        : <PluginUpdateLogLine>[];
    return PluginUpdateLog(
      opId: json['opId'] is String ? json['opId'] as String : '',
      phase: json['phase'] is String ? json['phase'] as String : '',
      lines: List.unmodifiable(lines),
      cursor: lines.fold<int>(
        0,
        (max, line) => line.seq > max ? line.seq : max,
      ),
    );
  }
}
