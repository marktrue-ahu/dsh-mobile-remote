// GitLab #152 / ADR 0036：当前活动连接档案的全局命名空间。
//
// 所有以 sessionId/仓库名等作为 key 的本地状态必须经 [ProfileNamespace.key] 加上
// `(profileId, hostId)` 前缀，切换档案后自然落到不同命名空间；空 scope 兼容单连接
// 旧版本/测试。
class ProfileNamespace {
  ProfileNamespace._();

  static String _scope = '';

  static String get scope => _scope;

  static void setScope(String scope) {
    _scope = scope;
  }

  static String key(String base) => _scope.isEmpty ? base : '$base@$_scope';

  /// 单一 scope 格式化：hostId 为空也保留分隔符，便于空 host → 首次绑定迁移。
  static String scopeFor(String profileId, String hostId) => '$profileId:$hostId';

  static String forScope(String scope, String base) =>
      scope.isEmpty ? base : '$base@$scope';
}
