import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'attention.dart';
import 'logger.dart';
import 'profile_namespace.dart';

/// Versioned, bounded notification ledger. No prompts, tokens or tool arguments.
class AttentionStorage {
  static const baseKey = 'dsh_attention_ledger_v1';

  /// 仅用于旧测试/兼容读取当前全局 scope；生产读写都显式传捕获 scope。
  static String get preferenceKey => ProfileNamespace.key(baseKey);

  static String keyForScope(String? scope) =>
      ProfileNamespace.forScope(scope ?? ProfileNamespace.scope, baseKey);

  Future<void> restore(AttentionLedger ledger, {String? scope}) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final value = prefs.getString(keyForScope(scope));
      if (value == null) return;
      final data = jsonDecode(value);
      if (data is! Map || data['version'] != 1 || data['entries'] is! List) {
        return;
      }
      ledger.restore(
        (data['entries'] as List)
            .whereType<Map>()
            .map((row) => Map<String, dynamic>.from(row))
            .toList(),
      );
    } catch (_) {
      AppLog.instance.log('通知：账本无法恢复，等待宿主待办快照对账');
    }
  }

  Future<void> save(AttentionLedger ledger, {String? scope}) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      keyForScope(scope),
      jsonEncode({'version': 1, 'entries': ledger.toJson()}),
    );
  }
}
